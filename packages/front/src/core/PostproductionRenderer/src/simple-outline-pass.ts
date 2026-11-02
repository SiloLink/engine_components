import * as OBC from "@thatopen/components";
import * as THREE from "three";
import {
  Pass,
  FullScreenQuad,
} from "three/examples/jsm/postprocessing/Pass.js";
import {
  getTileIndexLayout,
  toDrawnIndexRanges,
} from "../../../utils/tile-index-layout";

const PALETTE_SIZE = 256;
const DEFAULT_GROUP = "default";

/**
 * Fill twins of meshes added through `addMeshToGroup` have no surface of
 * their own in the scene render, so they draw as its first translucent
 * surfaces, after every opaque one.
 */
const MESH_FILL_GROUP_ORDER = -1_000_000;

interface DrawRange {
  start: number;
  count: number;
}

/**
 * The parts of `ranges` outside `covered`. Neither overlaps itself, and
 * `covered` is in index order.
 */
function subtractRanges(
  ranges: readonly DrawRange[],
  covered: readonly DrawRange[],
): DrawRange[] {
  const rest: DrawRange[] = [];
  for (const range of ranges) {
    let start = range.start;
    const end = range.start + range.count;
    for (const cover of covered) {
      if (cover.start >= end) break;
      const coverEnd = cover.start + cover.count;
      if (coverEnd <= start) continue;
      if (cover.start > start) rest.push({ start, count: cover.start - start });
      start = coverEnd;
      if (start >= end) break;
    }
    if (start < end) rest.push({ start, count: end - start });
  }
  return rest;
}

interface OutlineGroup {
  id: number;
  name: string;
  /** Container parented to the root scene; ghost meshes live here. */
  container: THREE.Group;
  /** Dedicated material for this group, with its idColor uniform baked in. */
  material: THREE.ShaderMaterial;
  /** Translucent fill drawn on outlined geometry inside the scene render. */
  fillMaterial: THREE.MeshBasicMaterial;
  outlineColor: THREE.Color;
  fillColor: THREE.Color;
  fillOpacity: number;
  thickness: number;
  /**
   * Higher priority wins at coplanar pixels. Groups render in priority order;
   * the default less-equal depth test lets the later group resolve the tie.
   */
  priority: number;
}

type OutlineGroupConfig = Partial<
  Omit<OutlineGroup, "id" | "name" | "container" | "material" | "fillMaterial">
>;

/**
 * A proxy mesh attached to the pass via {@link SimpleOutlinePass.attachOutlinedTile}.
 *
 * The proxy carries its own `BufferGeometry` whose `attributes` and `index`
 * are aliased from the source tile (no GPU duplication) and whose
 * `groups` cover only the index chunks for outlined items in that tile.
 * Drawing the proxy with the group's mask material paints those chunks
 * into the mask buffer; everything else in the tile is invisible.
 *
 * Per-frame the proxy's `matrixWorld` is synced from the source so the
 * outline tracks the tile through camera moves and any model-level
 * transforms, and its groups follow the tile's index packing.
 */
interface OutlinedTileProxy {
  source: THREE.Mesh;
  proxy: THREE.Mesh;
  /** The outlined chunks, in the tile's full index. */
  ranges: DrawRange[];
  /** The chunks at the slots the tile's current index draws them. */
  drawn: readonly DrawRange[];
  /** The tile index packing `drawn` follows, undefined for the full index. */
  layout: ReturnType<typeof getTileIndexLayout>;
  groupName: string;
}

type RenderHook = THREE.Object3D["onAfterRender"];

/** Outlined tiles of one source mesh and the render hook that fills them. */
interface TileFill {
  tile: THREE.Mesh;
  targets: Set<OutlinedTileProxy>;
  /** Fills for the current scene render, highest group priority first. */
  fills: { ranges: readonly DrawRange[]; material: THREE.MeshBasicMaterial }[];
  /** Installed on the tile only while a scene render fills it. */
  hook: RenderHook;
  installed: boolean;
  /** The tile's own hook while ours is installed, undefined for the prototype's. */
  previous: RenderHook | undefined;
}

const GHOST_VERT = `
  #include <clipping_planes_pars_vertex>
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;

const GHOST_FRAG = `
  #include <clipping_planes_pars_fragment>
  uniform vec4 idColor;
  void main() {
    #include <clipping_planes_fragment>
    gl_FragColor = idColor;
  }
`;

/**
 * Multi-group outline pass.
 *
 * Every group has its own material with its id baked into a `idColor` uniform,
 * and its own container `Group` parented to a single root scene. Ghost meshes
 * are tagged at assign time (`mesh.material = group.material`) and added to
 * the group's container; all ghosts across all groups are then rendered into
 * the mask target in one `renderer.render(rootScene, camera)` call.
 *
 * A composite shader reads the mask (center pixel id) and samples the x-ray
 * mask neighborhood within the group's thickness to paint an inward outline
 * wherever the center is near a different id.
 *
 * Fills are drawn by the scene render itself (see {@link showSceneFills}):
 * right after three.js draws a range of a filled tile, a render hook paints
 * the outlined part of that range. A fill is therefore exactly as visible as its
 * surface. Surfaces drawn later blend over it or hide it like they do the
 * surface, whether the outlined surface is opaque or itself translucent.
 * Styles without a color render overlay the fill in the composite instead
 * ({@link compositeFill}).
 *
 * Legacy single-outline API (`outlineColor`, `thickness`, `fillColor`,
 * `fillOpacity`, `scene`) is preserved as a delegate to the "default" group.
 */
export class SimpleOutlinePass extends Pass {
  debugShowMask = false;

  /**
   * Whether the composite paints group fills over the finished image.
   * Postproduction turns this off when its base pass draws the fills inside
   * the scene render.
   */
  compositeFill = true;

  private _world: OBC.World;
  private _maskTarget: THREE.WebGLRenderTarget;
  private _rootScene: THREE.Scene;
  private _fsQuad: FullScreenQuad;
  private _debugQuad: FullScreenQuad;
  private _tileFills = new Map<THREE.Mesh, TileFill>();
  private readonly _fillRange: THREE.GeometryGroup = {
    start: 0,
    count: 0,
    materialIndex: 0,
  };
  /** Fill twins of meshes added through {@link addMeshToGroup}. */
  private _sceneFills = new THREE.Group();
  private _meshFills = new Map<THREE.Mesh, THREE.Mesh>();
  /** Polygon offset units that move a fill towards the camera. */
  private _fillOffsetUnits: number;

  private _groups = new Map<string, OutlineGroup>();
  private _groupsById = new Map<number, OutlineGroup>();
  /**
   * Outlined-tile proxies, keyed by source tile mesh. The pass owns the
   * proxy meshes (and their lightweight `BufferGeometry` wrappers); the
   * source meshes, their `attributes`, and their `index` belong to
   * fragments and are never mutated here.
   */
  private _outlinedTiles = new Map<string, OutlinedTileProxy>();
  private _nextId = 1;
  private _maxThickness = 2;

  private _paletteData: Uint8Array;
  private _paletteTexture: THREE.DataTexture;

  constructor(
    width: number,
    height: number,
    world: OBC.World,
    reversedDepth: boolean,
  ) {
    super();
    this._world = world;
    // three.js negates the offset factor for a reversed depth buffer, but
    // not the units.
    this._fillOffsetUnits = reversedDepth ? 1 : -1;

    this._maskTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
    });

    this._sceneFills.name = "outline-scene-fills";
    this._sceneFills.renderOrder = MESH_FILL_GROUP_ORDER;
    this._sceneFills.visible = false;
    this._sceneFills.matrixAutoUpdate = false;
    this._sceneFills.matrixWorldAutoUpdate = false;

    this._rootScene = new THREE.Scene();
    this._rootScene.background = null;

    this._paletteData = new Uint8Array(PALETTE_SIZE * 2 * 4);
    this._paletteTexture = new THREE.DataTexture(
      this._paletteData,
      PALETTE_SIZE,
      2,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this._paletteTexture.minFilter = THREE.NearestFilter;
    this._paletteTexture.magFilter = THREE.NearestFilter;
    this._paletteTexture.wrapS = THREE.ClampToEdgeWrapping;
    this._paletteTexture.wrapT = THREE.ClampToEdgeWrapping;
    this._paletteTexture.needsUpdate = true;

    this._fsQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          tMask: { value: null },
          tPalette: { value: this._paletteTexture },
          resolution: { value: new THREE.Vector2(width, height) },
          maxThickness: { value: this._maxThickness },
          compositeFill: { value: true },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          precision highp float;
          varying vec2 vUv;

          uniform sampler2D tDiffuse;
          uniform sampler2D tMask;
          uniform sampler2D tPalette;
          uniform vec2 resolution;
          uniform float maxThickness;
          uniform bool compositeFill;

          // Palette is 256x2. y=0.25 (row 0) line, y=0.75 (row 1) fill.
          vec4 paletteLine(float id) {
            return texture2D(tPalette, vec2((id + 0.5) / 256.0, 0.25));
          }
          vec4 paletteFill(float id) {
            return texture2D(tPalette, vec2((id + 0.5) / 256.0, 0.75));
          }

          float readId(vec2 uv) {
            return floor(texture2D(tMask, uv).r * 255.0 + 0.5);
          }

          void main() {
            vec4 scene = texture2D(tDiffuse, vUv);
            vec4 mask = texture2D(tMask, vUv);
            float centerId = floor(mask.r * 255.0 + 0.5);

            if (centerId < 0.5) {
              gl_FragColor = scene;
              return;
            }

            // Inward outline: we are inside group centerId. Without a scene
            // fill, apply its fill here; if any pixel within this group's
            // thickness belongs to a different id, we are near the group's
            // interior silhouette and paint the outline color. This
            // guarantees outlines never spill past the group's own footprint.
            vec4 fill = paletteFill(centerId);
            vec4 line = paletteLine(centerId);
            float t = line.a * 255.0;
            vec2 texel = 1.0 / resolution;

            vec3 rgb = compositeFill
              ? mix(scene.rgb, fill.rgb, fill.a)
              : scene.rgb;

            float edge = 0.0;
            for (float y = -maxThickness; y <= maxThickness; y += 1.0) {
              if (abs(y) > t) continue;
              for (float x = -maxThickness; x <= maxThickness; x += 1.0) {
                if (abs(x) > t) continue;
                float nId = readId(vUv + vec2(x, y) * texel);
                if (nId != centerId) { edge = 1.0; break; }
              }
              if (edge > 0.5) break;
            }

            if (edge > 0.5) rgb = line.rgb;
            gl_FragColor = vec4(rgb, 1.0);
          }
        `,
        depthTest: false,
        depthWrite: false,
      }),
    );

    this._debugQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { tMask: { value: null } },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D tMask;
          varying vec2 vUv;
          void main() {
            float id = texture2D(tMask, vUv).r;
            gl_FragColor = vec4(vec3(id * 8.0), 1.0);
          }
        `,
      }),
    );

    // Create the default group so legacy code has something to target.
    this.addGroup(DEFAULT_GROUP, {
      outlineColor: new THREE.Color(0xffc800),
      fillColor: new THREE.Color(0xffff00),
      fillOpacity: 0.3,
      thickness: 2,
    });
  }

  // ---------------------------------------------------------------------------
  // Group API
  // ---------------------------------------------------------------------------

  /**
   * Creates a named outline group. Each group has its own container, material
   * (with id baked in) and visual config. No hard cap on active groups beyond
   * the palette size (255 concurrent).
   */
  addGroup(name: string, config?: OutlineGroupConfig) {
    let group = this._groups.get(name);
    if (group) {
      if (config) this.configureGroup(name, config);
      return group;
    }

    const id = this.allocateId();
    const priority = config?.priority ?? 0;

    // The mask follows the world's clipping planes so outlined items end at
    // a section cut like their source geometry. The renderer's list is
    // edited in place, so the material always sees the current planes.
    const material = new THREE.ShaderMaterial({
      uniforms: { idColor: { value: new THREE.Vector4(id / 255, 0, 0, 1) } },
      clipping: true,
      clippingPlanes: this._world.renderer?.clippingPlanes ?? null,
      vertexShader: GHOST_VERT,
      fragmentShader: GHOST_FRAG,
      depthTest: true,
      depthWrite: true,
      transparent: false,
    });

    const container = new THREE.Group();
    container.name = `outline-group:${name}`;
    container.renderOrder = priority;
    this._rootScene.add(container);

    const fillColor = config?.fillColor?.clone() ?? new THREE.Color(0xffff00);
    const fillOpacity = config?.fillOpacity ?? 0.3;
    const fillMaterial = new THREE.MeshBasicMaterial({
      color: fillColor,
      opacity: fillOpacity,
      transparent: true,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      // A fill coincides with its outlined surface; the smallest resolvable
      // depth step towards the camera lets it win that tie and nothing else.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: this._fillOffsetUnits,
      // Fills end at a section cut like the mask and the source geometry.
      clippingPlanes: this._world.renderer?.clippingPlanes ?? null,
      toneMapped: false,
    });

    group = {
      id,
      name,
      container,
      material,
      fillMaterial,
      outlineColor: config?.outlineColor?.clone() ?? new THREE.Color(0xffc800),
      fillColor,
      fillOpacity,
      thickness: config?.thickness ?? 2,
      priority,
    };

    this._groups.set(name, group);
    this._groupsById.set(id, group);
    this.writePaletteEntry(group);
    this.updateMaxThickness();
    return group;
  }

  /**
   * Updates an existing group's visual config.
   */
  configureGroup(name: string, config: OutlineGroupConfig) {
    const group = this._groups.get(name);
    if (!group) return;
    if (config.outlineColor) group.outlineColor.copy(config.outlineColor);
    if (config.fillColor) group.fillColor.copy(config.fillColor);
    if (config.fillOpacity !== undefined)
      group.fillOpacity = config.fillOpacity;
    if (config.thickness !== undefined) group.thickness = config.thickness;
    if (config.priority !== undefined) {
      group.priority = config.priority;
      group.container.renderOrder = config.priority;
    }
    group.fillMaterial.color.copy(group.fillColor);
    group.fillMaterial.opacity = group.fillOpacity;
    for (const target of this._outlinedTiles.values()) {
      if (target.groupName !== name) continue;
      target.proxy.visible = this.groupNeedsMask(group);
    }
    this.writePaletteEntry(group);
    this.updateMaxThickness();
  }

  /**
   * Removes a group. Detaches its ghost meshes (the caller still owns them)
   * and disposes the group's material.
   */
  removeGroup(name: string) {
    if (name === DEFAULT_GROUP) return;
    const group = this._groups.get(name);
    if (!group) return;
    for (const [key, target] of this._outlinedTiles) {
      if (target.groupName !== name) continue;
      this.destroyOutlinedTileProxy(target);
      this._outlinedTiles.delete(key);
    }
    while (group.container.children.length) {
      group.container.children[0].removeFromParent();
    }
    this.pruneMeshFills();
    group.container.removeFromParent();
    group.material.dispose();
    group.fillMaterial.dispose();
    this._groups.delete(name);
    this._groupsById.delete(group.id);
    this.clearPaletteEntry(group.id);
    this.updateMaxThickness();
  }

  hasGroup(name: string) {
    return this._groups.has(name);
  }

  getGroup(name: string) {
    return this._groups.get(name);
  }

  /**
   * Attaches a mesh to a group: assigns the group's material and parents the
   * mesh into the group's container. Creates the group on demand.
   */
  addMeshToGroup(mesh: THREE.Mesh, name: string) {
    let group = this._groups.get(name);
    if (!group) group = this.addGroup(name);
    mesh.material = group.material;
    group.container.add(mesh);
    this._meshFills.get(mesh)?.removeFromParent();
    const fill = this.createSceneFill(mesh.geometry, group.fillMaterial);
    fill.frustumCulled = mesh.frustumCulled;
    this._meshFills.set(mesh, fill);
  }

  // ---------------------------------------------------------------------------
  // Outlined-tile API
  //
  // The mainstream way to outline geometry through this pass: hand it a
  // source tile mesh and the index chunks within that tile that should be
  // outlined. The pass clones the mesh sharing `geometry.attributes` /
  // `index` (no GPU duplication), adds `geometry.groups` for the chunks,
  // and keeps it in the named group's container.
  // ---------------------------------------------------------------------------

  /**
   * Attach a tile mesh as an outline target. Creates a proxy mesh that
   * shares the source's `geometry.attributes` and `index` and draws only
   * the slices specified by `position[i] / size[i]` (parallel arrays of
   * offsets into the tile's full index, as Fragments item draw chunks give
   * them; while Fragments draws a compacted index, they are drawn at their
   * packed slots).
   *
   * Calling again with the same tile rebuilds the proxy's groups from
   * the new chunks; calling with a different `groupName` reparents the
   * proxy and reassigns its mask material.
   */
  attachOutlinedTile(
    tile: THREE.Mesh,
    chunks: { position: ArrayLike<number>; size: ArrayLike<number> },
    groupName: string = DEFAULT_GROUP,
  ) {
    let group = this._groups.get(groupName);
    if (!group) group = this.addGroup(groupName);

    const key = this.getOutlinedTileKey(tile, groupName);
    const existing = this._outlinedTiles.get(key);
    if (existing) {
      existing.ranges = this.copyRanges(chunks);
      this.syncProxyLayout(existing, true);
      existing.proxy.visible = this.groupNeedsMask(group);
      return;
    }

    const proxyGeom = new THREE.BufferGeometry();

    // Material assigned as `Material[]`, not a single `Material`. Three's
    // `WebGLRenderer.renderObject` only honors `geometry.groups` when the
    // mesh's material is an array; with a single material it draws the
    // entire indexed geometry and ignores the groups, which would render
    // the whole tile silhouette instead of just the outlined slices.
    const proxy = new THREE.Mesh(proxyGeom, [group.material]);
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    proxy.frustumCulled = false; // matrix is owned by source; trust it
    proxy.matrixWorld.copy(tile.matrixWorld);
    proxy.visible = this.groupNeedsMask(group);

    group.container.add(proxy);
    const target: OutlinedTileProxy = {
      source: tile,
      proxy,
      ranges: this.copyRanges(chunks),
      drawn: [],
      layout: undefined,
      groupName,
    };
    this.syncProxyLayout(target, true);
    this._outlinedTiles.set(key, target);
    this.addTileFill(target);
  }

  /**
   * Rebuilds an attached proxy from the tile's current material slots and
   * geometry groups without resolving item chunks again in the worker.
   */
  refreshOutlinedTile(tile: THREE.Mesh, groupName?: string) {
    if (groupName !== undefined) {
      const target = this._outlinedTiles.get(
        this.getOutlinedTileKey(tile, groupName),
      );
      if (target) this.refreshOutlinedTileProxy(target);
      return;
    }
    for (const target of this._outlinedTiles.values()) {
      if (target.source === tile) this.refreshOutlinedTileProxy(target);
    }
  }

  /**
   * Stop outlining a tile and release its geometry wrapper. Shared attributes
   * and index buffers remain owned by Fragments.
   */
  detachOutlinedTile(tile: THREE.Mesh, groupName?: string) {
    if (groupName !== undefined) {
      const key = this.getOutlinedTileKey(tile, groupName);
      const target = this._outlinedTiles.get(key);
      if (!target) return;
      this.destroyOutlinedTileProxy(target);
      this._outlinedTiles.delete(key);
      return;
    }

    for (const [key, target] of this._outlinedTiles) {
      if (target.source !== tile) continue;
      this.destroyOutlinedTileProxy(target);
      this._outlinedTiles.delete(key);
    }
  }

  hasOutlinedTile(tile: THREE.Mesh, groupName?: string) {
    if (groupName !== undefined) {
      return this._outlinedTiles.has(this.getOutlinedTileKey(tile, groupName));
    }
    for (const target of this._outlinedTiles.values()) {
      if (target.source === tile) return true;
    }
    return false;
  }

  /**
   * Container (THREE.Group) where a group's ghost meshes live. Creates the
   * group on demand. Use {@link addMeshToGroup} when adding ghosts so the
   * right material gets assigned; this accessor is for introspection.
   */
  getGroupContainer(name: string): THREE.Object3D {
    let group = this._groups.get(name);
    if (!group) group = this.addGroup(name);
    return group.container;
  }

  /** @deprecated Kept for API compatibility. Use {@link getGroupContainer}. */
  getGroupScene(name: string): THREE.Object3D {
    return this.getGroupContainer(name);
  }

  listGroups() {
    return [...this._groups.keys()];
  }

  // ---------------------------------------------------------------------------
  // Legacy singular API (delegates to the default group)
  // ---------------------------------------------------------------------------

  /**
   * @deprecated Previously a `THREE.Scene`. Now the default group's container
   * (a `THREE.Group`). Use `getGroupContainer(name)` or `addMeshToGroup(mesh, name)`.
   */
  get scene(): THREE.Object3D {
    return this._groups.get(DEFAULT_GROUP)!.container;
  }

  get outlineColor() {
    return this._groups.get(DEFAULT_GROUP)!.outlineColor;
  }

  set outlineColor(value: THREE.Color) {
    this.configureGroup(DEFAULT_GROUP, { outlineColor: value });
  }

  get thickness() {
    return this._groups.get(DEFAULT_GROUP)!.thickness;
  }

  set thickness(value: number) {
    this.configureGroup(DEFAULT_GROUP, { thickness: value });
  }

  get fillColor() {
    return this._groups.get(DEFAULT_GROUP)!.fillColor;
  }

  set fillColor(value: THREE.Color) {
    this.configureGroup(DEFAULT_GROUP, { fillColor: value });
  }

  get fillOpacity() {
    return this._groups.get(DEFAULT_GROUP)!.fillOpacity;
  }

  set fillOpacity(value: number) {
    this.configureGroup(DEFAULT_GROUP, { fillOpacity: value });
  }

  // ---------------------------------------------------------------------------
  // Pass overrides
  // ---------------------------------------------------------------------------

  setSize(width: number, height: number) {
    this._maskTarget.setSize(width, height);
    const mat = this._fsQuad.material as THREE.ShaderMaterial;
    mat.uniforms.resolution.value.set(width, height);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ) {
    const camera = this._world.camera.three;

    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();

    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this._maskTarget);
    renderer.clear(true, true, false);

    // Sync proxy matrices and index packing from their source tiles. Cheap:
    // bounded by the number of currently-outlined tiles, not items. The
    // source's `matrixWorld` is updated by three when the model gets
    // transformed.
    if (this._outlinedTiles.size > 0) {
      for (const target of this._outlinedTiles.values()) {
        this.syncProxyLayout(target);
        this.syncProxyTransform(target.proxy, target.source);
        const group = this._groups.get(target.groupName);
        target.proxy.visible =
          group !== undefined &&
          this.groupNeedsMask(group) &&
          this.isHierarchyVisible(target.source);
      }
    }

    // Single draw of all groups. Each ghost mesh already holds its group's
    // material with the right id baked in; three.js sorts and batches the
    // draws, the shared depth buffer gives "closer outlined item wins", and
    // renderOrder settles exact coplanar ties by group priority.
    renderer.render(this._rootScene, camera);

    renderer.setClearColor(prevClearColor, prevClearAlpha);

    // --- Composite
    if (this.debugShowMask) {
      const debugMat = this._debugQuad.material as THREE.ShaderMaterial;
      debugMat.uniforms.tMask.value = this._maskTarget.texture;
      if (this.renderToScreen) renderer.setRenderTarget(null);
      else renderer.setRenderTarget(writeBuffer);
      this._debugQuad.render(renderer);
      return;
    }

    const mat = this._fsQuad.material as THREE.ShaderMaterial;
    mat.uniforms.tDiffuse.value = readBuffer.texture;
    mat.uniforms.tMask.value = this._maskTarget.texture;
    mat.uniforms.maxThickness.value = this._maxThickness;
    mat.uniforms.compositeFill.value = this.compositeFill;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._fsQuad.render(renderer);
  }

  /**
   * Shows the fills for one render of `scene`. The base pass calls this
   * around its scene render, so other passes and frames without this pass
   * never draw the fills.
   */
  showSceneFills(scene: THREE.Object3D) {
    // An item in several groups, such as a selection and its batch, gets the
    // fill of the highest-priority group once: a group fills only the slots
    // that higher ones leave, whatever the bounds of their ranges.
    for (const entry of this._tileFills.values()) {
      entry.fills.length = 0;
      const targets = [...entry.targets]
        .map((target) => ({
          target,
          group: this._groups.get(target.groupName),
        }))
        .filter(({ group }) => group && group.fillOpacity > 0)
        .sort((a, b) => b.group!.priority - a.group!.priority);
      const filled: DrawRange[] = [];
      for (const { target, group } of targets) {
        this.syncProxyLayout(target);
        const ranges = subtractRanges(target.drawn, filled);
        if (ranges.length === 0) continue;
        entry.fills.push({ ranges, material: group!.fillMaterial });
        filled.push(...ranges);
        filled.sort((a, b) => a.start - b.start);
      }
      if (entry.fills.length > 0) this.installTileHook(entry);
    }
    if (this._sceneFills.parent !== scene) scene.add(this._sceneFills);
    this.pruneMeshFills();
    for (const [mesh, fill] of this._meshFills) {
      const group = this.getMeshGroup(mesh)!;
      mesh.updateWorldMatrix(true, false);
      this.syncProxyTransform(fill, mesh);
      fill.visible = group.fillOpacity > 0 && mesh.visible;
    }
    this._sceneFills.visible = true;
  }

  hideSceneFills() {
    for (const entry of this._tileFills.values()) this.uninstallTileHook(entry);
    this._sceneFills.visible = false;
  }

  dispose() {
    // FullScreenQuad.dispose() only disposes its internal geometry; the
    // materials we passed in are our responsibility.
    (this._fsQuad.material as THREE.Material).dispose();
    (this._debugQuad.material as THREE.Material).dispose();
    this._fsQuad.dispose();
    this._debugQuad.dispose();

    this._maskTarget.dispose();
    this._paletteTexture.dispose();

    for (const target of this._outlinedTiles.values())
      this.destroyOutlinedTileProxy(target);
    this._outlinedTiles.clear();
    for (const fill of this._meshFills.values()) fill.removeFromParent();
    this._meshFills.clear();
    this._sceneFills.removeFromParent();

    for (const group of this._groups.values()) {
      while (group.container.children.length) {
        group.container.children[0].removeFromParent();
      }
      group.container.removeFromParent();
      group.material.dispose();
      group.fillMaterial.dispose();
    }
    this._groups.clear();
    this._groupsById.clear();
  }

  /** Tracks a tile's outline groups; its hook is installed per scene render. */
  private addTileFill(target: OutlinedTileProxy) {
    const tile = target.source;
    const existing = this._tileFills.get(tile);
    if (existing) {
      existing.targets.add(target);
      return;
    }
    const entry: TileFill = {
      tile,
      targets: new Set([target]),
      fills: [],
      installed: false,
      previous: undefined,
      hook: (renderer, scene, camera, geometry, material, group) => {
        entry.previous?.call(
          tile,
          renderer,
          scene,
          camera,
          geometry,
          material,
          group,
        );
        this.drawTileFill(entry, renderer, scene, camera, geometry, group);
      },
    };
    this._tileFills.set(tile, entry);
  }

  private removeTileFill(target: OutlinedTileProxy) {
    const tile = target.source;
    const entry = this._tileFills.get(tile);
    if (!entry) return;
    entry.targets.delete(target);
    if (entry.targets.size > 0) return;
    this.uninstallTileHook(entry);
    this._tileFills.delete(tile);
  }

  /**
   * A tile with a hook draws every range separately: three.js batches ranges
   * only of tiles without one. So only tiles with a fill get the hook, and only
   * for the scene render that draws it.
   */
  private installTileHook(entry: TileFill) {
    if (entry.installed) return;
    const { tile } = entry;
    entry.previous = Object.prototype.hasOwnProperty.call(tile, "onAfterRender")
      ? tile.onAfterRender
      : undefined;
    tile.onAfterRender = entry.hook;
    entry.installed = true;
  }

  private uninstallTileHook(entry: TileFill) {
    if (!entry.installed) return;
    entry.installed = false;
    const { tile } = entry;
    if (tile.onAfterRender === entry.hook) {
      if (entry.previous) tile.onAfterRender = entry.previous;
      else Reflect.deleteProperty(tile, "onAfterRender");
    }
    entry.previous = undefined;
  }

  /** Paints the outlined parts of the range three.js has just drawn. */
  private drawTileFill(
    entry: TileFill,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    geometry: THREE.BufferGeometry,
    // three.js passes the drawn geometry group, typed as a scene Group.
    group: unknown,
  ) {
    const drawn = group as THREE.GeometryGroup | null;
    const start = drawn ? drawn.start : geometry.drawRange.start;
    const end = start + (drawn ? drawn.count : geometry.drawRange.count);
    // Runs for every drawn range of an outlined tile: no allocations. Fill
    // ranges do not overlap, so each outlined slot is filled once.
    for (const fill of entry.fills) {
      for (const range of fill.ranges) {
        const from = Math.max(start, range.start);
        const to = Math.min(end, range.start + range.count);
        if (to <= from) continue;
        this._fillRange.start = from;
        this._fillRange.count = to - from;
        renderer.renderBufferDirect(
          camera,
          scene,
          geometry,
          fill.material,
          entry.tile,
          this._fillRange,
        );
      }
    }
  }

  private createSceneFill(
    geometry: THREE.BufferGeometry,
    material: THREE.Material | THREE.Material[],
  ) {
    const fill = new THREE.Mesh(geometry, material);
    fill.matrixAutoUpdate = false;
    fill.matrixWorldAutoUpdate = false;
    fill.frustumCulled = false;
    // A display twin of geometry that is already pickable.
    fill.raycast = () => {};
    this._sceneFills.add(fill);
    return fill;
  }

  private getMeshGroup(mesh: THREE.Mesh) {
    for (const group of this._groups.values()) {
      if (mesh.parent === group.container) return group;
    }
    return undefined;
  }

  /** Releases fill twins of meshes that have left their group. */
  private pruneMeshFills() {
    for (const [mesh, fill] of this._meshFills) {
      if (this.getMeshGroup(mesh)) continue;
      fill.removeFromParent();
      this._meshFills.delete(mesh);
    }
  }

  /**
   * Push the given index chunks into the proxy's `geometry.groups`.
   * `Infinity` and `0xffffffff` are both treated as "to end of buffer";
   * three.js accepts `Infinity` natively, which we pass through.
   */
  private fillProxyGroups(
    proxyGeom: THREE.BufferGeometry,
    ranges: readonly DrawRange[],
  ) {
    proxyGeom.clearGroups();
    for (const range of ranges) proxyGeom.addGroup(range.start, range.count, 0);
  }

  private copyRanges(chunks: {
    position: ArrayLike<number>;
    size: ArrayLike<number>;
  }) {
    const ranges: DrawRange[] = [];
    const count = Math.min(chunks.position.length, chunks.size.length);
    for (let i = 0; i < count; i++) {
      const size = chunks.size[i];
      ranges.push({
        start: chunks.position[i],
        count: size === 0xffffffff ? Infinity : size,
      });
    }
    return ranges;
  }

  private refreshAliasedGeometry(
    proxy: THREE.BufferGeometry,
    source: THREE.BufferGeometry,
  ) {
    proxy.attributes = source.attributes;
    proxy.index = source.index;
    proxy.morphAttributes = source.morphAttributes;
    proxy.morphTargetsRelative = source.morphTargetsRelative;
    proxy.boundingBox = source.boundingBox;
    proxy.boundingSphere = source.boundingSphere;
    proxy.drawRange = { ...source.drawRange };
  }

  private refreshOutlinedTileProxy(target: OutlinedTileProxy) {
    const group = this._groups.get(target.groupName);
    if (!group) return;
    this.syncProxyLayout(target, true);
    target.proxy.visible = this.groupNeedsMask(group);
  }

  /**
   * Aliases the tile's buffers and draws the outlined chunks where the
   * tile's index holds them. Fragments repacks a compacted index as the view
   * changes, so a change of packing redraws the groups; `force` redraws them
   * anyway, for new chunks or new tile buffers.
   */
  private syncProxyLayout(target: OutlinedTileProxy, force = false) {
    const geometry = target.source.geometry;
    const layout = getTileIndexLayout(geometry);
    if (!force && layout === target.layout) return;
    target.layout = layout;
    target.drawn = toDrawnIndexRanges(geometry, target.ranges);
    this.refreshAliasedGeometry(target.proxy.geometry, geometry);
    this.fillProxyGroups(target.proxy.geometry, target.drawn);
  }

  private destroyOutlinedTileProxy(target: OutlinedTileProxy) {
    target.proxy.removeFromParent();
    this.removeTileFill(target);
    const geometry = target.proxy.geometry;
    // Release the wrapper's renderer/VAO registration, not the source buffers.
    // Replace the alias maps instead of deleting entries from the shared maps.
    geometry.attributes = {};
    geometry.index = null;
    geometry.morphAttributes = {};
    geometry.dispose();
  }

  private syncProxyTransform(proxy: THREE.Mesh, source: THREE.Object3D) {
    proxy.matrixWorld.copy(source.matrixWorld);
    proxy.renderOrder = source.renderOrder;
    proxy.layers.mask = source.layers.mask;
  }

  private isHierarchyVisible(source: THREE.Object3D) {
    let current: THREE.Object3D | null = source;
    while (current) {
      if (!current.visible) return false;
      current = current.parent;
    }
    return true;
  }

  private groupNeedsMask(group: OutlineGroup) {
    return group.thickness > 0 || group.fillOpacity > 0;
  }

  private getOutlinedTileKey(tile: THREE.Mesh, groupName: string) {
    return `${groupName}:${tile.uuid}`;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private allocateId() {
    for (let i = 0; i < PALETTE_SIZE - 1; i++) {
      const candidate = ((this._nextId - 1 + i) % (PALETTE_SIZE - 1)) + 1;
      if (!this._groupsById.has(candidate)) {
        this._nextId = (candidate % (PALETTE_SIZE - 1)) + 1;
        return candidate;
      }
    }
    throw new Error(
      `SimpleOutlinePass: cannot allocate outline group id, ${PALETTE_SIZE - 1} groups active.`,
    );
  }

  private writePaletteEntry(group: OutlineGroup) {
    const id = group.id;
    const lineOffset = id * 4;
    const fillOffset = (PALETTE_SIZE + id) * 4;
    const data = this._paletteData;
    const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

    data[lineOffset] = clampByte(group.outlineColor.r * 255);
    data[lineOffset + 1] = clampByte(group.outlineColor.g * 255);
    data[lineOffset + 2] = clampByte(group.outlineColor.b * 255);
    data[lineOffset + 3] = clampByte(group.thickness);

    data[fillOffset] = clampByte(group.fillColor.r * 255);
    data[fillOffset + 1] = clampByte(group.fillColor.g * 255);
    data[fillOffset + 2] = clampByte(group.fillColor.b * 255);
    data[fillOffset + 3] = clampByte(group.fillOpacity * 255);

    this._paletteTexture.needsUpdate = true;
  }

  private clearPaletteEntry(id: number) {
    const data = this._paletteData;
    const lineOffset = id * 4;
    const fillOffset = (PALETTE_SIZE + id) * 4;
    for (let i = 0; i < 4; i++) data[lineOffset + i] = 0;
    for (let i = 0; i < 4; i++) data[fillOffset + i] = 0;
    this._paletteTexture.needsUpdate = true;
  }

  private updateMaxThickness() {
    let max = 1;
    for (const group of this._groups.values()) {
      if (group.thickness > max) max = group.thickness;
    }
    this._maxThickness = Math.max(1, Math.round(max));
  }
}
