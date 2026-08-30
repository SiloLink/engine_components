import * as THREE from "three";
import { Components } from "../../Components";
import { Component, Event, World, Disposable } from "../../Types";
import { Mouse } from "../../Raycasters/src/mouse";
import { FragmentsManager } from "../../../fragments";

/**
 * GPU-readback picker that identifies what's under a screen position
 * without going through the worker raycast. Two granularities, same
 * render pass:
 *
 * - {@link getModelAt} returns the model id under the cursor.
 * - {@link getItemAt} returns the item itself (`modelId` + `localId`).
 *
 * The fragments tile geometry already carries a per-vertex `id`
 * attribute (the internal item id). We render the BIM scene to an
 * integer offscreen target with a shader that writes `(modelIndex, itemId)`
 * as two full-width uint32 channels, then `readPixels` at the cursor and
 * decodes them. One render plus one 16-byte readback per call. The model and
 * item identities resolve
 * on the main thread through the dense map installed with each model.
 *
 * Encoding (one RGBA32UI pixel):
 *   R = modelIndex (1..2^32-1, 0 = void / unwritten)
 *   G = itemId + 1 (0 = void / unwritten)
 *   B = 0
 *   A = 1
 *
 * `modelIndex` is assigned per-pick from an `indexToModelId` map; the
 * picker re-allocates indices each call so the assignment is stable for
 * the duration of the pick but doesn't grow over the session.
 */
export class FastModelPicker implements Disposable {
  /** {@link Component.enabled} */
  enabled = true;

  /** Components instance this picker belongs to. */
  components: Components;

  /** {@link Disposable.onDisposed} */
  readonly onDisposed = new Event();

  /** Position helper bound to the world's canvas. */
  readonly mouse: Mouse;

  /** World this picker renders against. */
  world: World;

  /**
   * When `true`, mirrors the id render to a debug canvas pinned in the
   * top-right corner. Each model shows up as a near-uniform red band
   * (the low byte of the model index) modulated by the item-id bytes.
   */
  debugMode = false;

  /**
   * Maximum models the picker can disambiguate in a single pick. Zero is
   * reserved as the void sentinel, leaving the rest of the uint32 range.
   */
  static readonly MAX_MODELS = 0xffffffff;
  static readonly PICK_SIZE = 4;

  private _renderTarget?: THREE.WebGLRenderTarget;
  /** Full-width model/item identity target, separate from RGBA8 depth data. */
  private _identityRenderTarget?: THREE.WebGLRenderTarget;
  private _renderTargetSize = new THREE.Vector2();
  /** Detached camera whose projection is cropped to the cursor pixels. */
  private _pickCamera?: THREE.Camera;
  /** Reused projection transform for the detached pick camera. */
  private _cropMatrix = new THREE.Matrix4();

  private _debugCanvas?: HTMLCanvasElement;
  private _debugContainer?: HTMLDivElement;

  /** Base shader used to create model-specific id materials. */
  private _idMaterial: THREE.ShaderMaterial;
  /** Reusable model-index materials that share one shader program. */
  private _idMaterials: THREE.ShaderMaterial[] = [];

  /**
   * Depth-encoding shader used by {@link getPointAt}. Written via
   * `scene.overrideMaterial` for one render of the BIM scene, packs
   * `gl_FragCoord.z` into the four bytes of the color attachment using
   * three's `packing` chunk. The packed value is robust to round-trip
   * through an `UNSIGNED_BYTE` target.
   */
  private _depthMaterial: THREE.ShaderMaterial;

  /**
   * World-space normal-encoding shader used by {@link getNormalAt}.
   * Writes `(normal * 0.5 + 0.5)` into RGB, alpha = 1. Decode side maps
   * `(rgb * 2 - 1)` and renormalizes. Naive packing wastes alpha and
   * gives ~1° precision per axis, which is plenty for surface
   * alignment, orbit-around-clicked-point, and snapping. Octahedral
   * packing would buy us another bit per axis but isn't worth the
   * complexity until a consumer actually needs sub-degree accuracy.
   */
  private _normalMaterial: THREE.ShaderMaterial;

  /**
   * Cached original materials for the swap-render-restore pass.
   * Populated in {@link applyIdMaterial}, drained in
   * {@link restoreOriginalMaterials} after the render.
   */
  private _originalMaterials = new Map<
    THREE.Mesh,
    THREE.Material | THREE.Material[]
  >();

  /** Reused temporary material arrays keyed by material and group count. */
  private _materialArrays = new Map<
    THREE.Material,
    Map<number, THREE.Material[]>
  >();

  /** Latest measured identity pass, exposed only through a copied snapshot. */
  private _lastIdentityPickStats?: {
    prepareMs: number;
    renderMs: number;
    readbackMs: number;
    restoreMs: number;
    renderCalls: number;
    renderTriangles: number;
    tileCount: number;
    visibleTileCount: number;
  };
  private _pickTileCount = 0;
  private _pickVisibleTileCount = 0;

  /** Model roots that received a valid index for the current identity pass. */
  private _identityModelRoots = new Set<THREE.Object3D>();

  /** Exact renderer event subscription owned by this picker. */
  private _resizeEvent?: Event<THREE.Vector2>;
  private _resizeHandler?: (newSize: THREE.Vector2) => void;

  /**
   * LOD line meshes don't carry the per-vertex `id` attribute and would
   * write whatever color their normal shader produces into the id
   * buffer, faking hits. Hidden for the duration of the id render and
   * restored after.
   */
  private _hiddenLods: THREE.Object3D[] = [];

  constructor(components: Components, world: World) {
    if (!world.renderer) {
      throw new Error("A renderer is needed for the FastModelPicker to work!");
    }
    this.world = world;
    this.mouse = new Mouse(world.renderer.three.domElement);
    this.components = components;
    this._idMaterial = this.buildIdMaterial();
    this._depthMaterial = this.buildDepthMaterial();
    this._normalMaterial = this.buildNormalMaterial();
    this.setupRenderTarget();
  }

  /**
   * Returns the model id under the given screen position, or `null` if
   * the cursor is over empty space.
   *
   * Cheaper than {@link getItemAt} because we don't resolve the
   * `localId`; we just read the model byte from the same render.
   *
   * @param position - Normalized device coords. Defaults to the
   *   picker's last known mouse position.
   */
  async getModelAt(position?: THREE.Vector2): Promise<string | null> {
    const result = await this.runIdPass(position);
    if (!result) return null;
    return result.modelId;
  }

  /**
   * Returns `{ modelId, localId }` for the item under the given screen
   * position, or `null` if the cursor is over empty space.
   *
   * The encoded RGBA pixel contains the Fragments-internal `itemId`.
   * FragmentsModel installs a dense item/local-id map during setup, so its
   * existing async translation API resolves locally without a worker trip.
   *
   * @param position - Normalized device coords. Defaults to the
   *   picker's last known mouse position.
   */
  async getItemAt(
    position?: THREE.Vector2,
  ): Promise<{ modelId: string; localId: number; itemId: number } | null> {
    const result = await this.runIdPass(position);
    if (!result) return null;
    // The vertex `id` attribute now encodes the internal **itemId**
    // (the FlatBuffer `sample.item()` index, key for `boxes.sampleOf`)
    // rather than the user-facing localId. This lets internal consumers
    // such as snapping use itemId directly, while the public result resolves
    // localId through the model's setup-time dense main-thread map.
    const fragments = this.components.get(FragmentsManager);
    const model = fragments.list.get(result.modelId);
    if (!model) return null;
    const localIds = await model.getLocalIdsFromItemIds([result.itemId]);
    const localId = localIds?.[0];
    if (localId === undefined || localId === null) return null;
    return { modelId: result.modelId, localId, itemId: result.itemId };
  }

  /**
   * Returns the world-space point under the given screen position, or
   * `null` if the cursor is over empty space.
   *
   * Renders the BIM scene with a depth-encoding override material that
   * packs `gl_FragCoord.z` into the color buffer, reads four bytes at
   * the cursor pixel, and unprojects through the camera matrices to a
   * world point. One render pass, one 4-byte readback, no worker
   * round-trip. Useful for things like "set camera orbit center to
   * what the user just clicked on".
   *
   * Cheaper than {@link getItemAt} because we don't differentiate
   * models — one render covers the whole BIM scene at once. We don't
   * resolve any item id either.
   *
   * @param position - Normalized device coords. Defaults to the
   *   picker's last known mouse position.
   */
  getPointAtSync(position?: THREE.Vector2): THREE.Vector3 | null {
    if (!this.enabled) return null;
    if (!this._renderTarget || !this.world.renderer) return null;

    const fragments = this.components.get(FragmentsManager);
    if (!fragments.initialized || fragments.list.size === 0) return null;

    const pos = position ?? this.mouse.position;
    const view = this.renderDepthPass(pos);
    const pixel = this.readPixelAt(this._renderTarget, view.readX, view.readY);
    if (!pixel) return null;
    if (pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 0) {
      return null; // cleared / void — nothing was drawn here
    }

    const depth = unpackDepthFromRGBA(pixel);
    // depth ≈ 1 means the far plane: nothing in front of the camera at
    // that pixel. Treat as void rather than returning a point on the
    // far plane.
    if (depth >= 1.0 - 1e-6) return null;

    return unprojectToWorld(pos, depth, this.world.camera.three);
  }

  /**
   * Asynchronous compatibility wrapper for {@link getPointAtSync}.
   */
  async getPointAt(position?: THREE.Vector2): Promise<THREE.Vector3 | null> {
    return this.getPointAtSync(position);
  }

  /**
   * Returns the world-space surface normal under the cursor, or `null`
   * if the cursor is over empty space.
   *
   * Mirrors {@link getPointAt}'s structure: one `scene.overrideMaterial`
   * render with the normal-encoding shader, one 4-byte readback,
   * decode and renormalize.
   */
  async getNormalAt(position?: THREE.Vector2): Promise<THREE.Vector3 | null> {
    if (!this.enabled) return null;
    if (!this._renderTarget || !this.world.renderer) return null;
    const fragments = this.components.get(FragmentsManager);
    if (!fragments.initialized || fragments.list.size === 0) return null;

    const pos = position ?? this.mouse.position;
    const view = this.renderNormalPass(pos);
    const pixel = this.readPixelAt(this._renderTarget, view.readX, view.readY);
    if (!pixel) return null;
    if (pixel[3] === 0) return null; // void pixel — nothing rendered here

    const x = (pixel[0] / 255) * 2 - 1;
    const y = (pixel[1] / 255) * 2 - 1;
    const z = (pixel[2] / 255) * 2 - 1;
    const n = new THREE.Vector3(x, y, z);
    if (n.lengthSq() < 1e-8) return null;
    return n.normalize();
  }

  /**
   * One-shot pick that produces the full result shape consumers need:
   * `{ modelId, localId, point, normal, distance }`. Routes through the
   * three GPU passes (id, depth, normal) and composes the output. No
   * worker round-trip.
   *
   * Returns `null` if the cursor is over empty space, the id pass
   * decodes to the void sentinel, or the depth round-trip yields the
   * far plane.
   */
  async getFullPick(position?: THREE.Vector2): Promise<{
    modelId: string;
    localId: number;
    /**
     * Internal item index (FlatBuffer `sample.item()`). Exposed so
     * SnapResolver and other internal consumers can hit fragments'
     * itemId-keyed fast paths (`boxes.sampleOf`) without paying a
     * second worker round-trip to translate back from localId.
     */
    itemId: number;
    point: THREE.Vector3;
    normal: THREE.Vector3 | null;
    distance: number;
  } | null> {
    const item = await this.getItemAt(position);
    if (!item) return null;
    const point = await this.getPointAt(position);
    if (!point) return null;
    const normal = await this.getNormalAt(position);
    const distance = point.distanceTo(this.world.camera.three.position);
    return { ...item, point, normal, distance };
  }

  /**
   * Toggle the debug overlay. When enabled the picker mirrors its id
   * render to a small canvas pinned in the top-right corner so you can
   * see what the readback sees.
   */
  setDebugMode(enabled: boolean) {
    this.debugMode = enabled;
    if (enabled) this.setupDebugCanvas();
    else this.removeDebugCanvas();
  }

  /** Latest identity-pass timings and submitted draw work. */
  getLastIdentityPickStats() {
    return this._lastIdentityPickStats
      ? { ...this._lastIdentityPickStats }
      : undefined;
  }

  /** {@link Disposable.dispose} */
  dispose() {
    if (this._resizeEvent && this._resizeHandler) {
      this._resizeEvent.remove(this._resizeHandler);
    }
    this._resizeEvent = undefined;
    this._resizeHandler = undefined;
    this.mouse.dispose();
    this.removeDebugCanvas();
    for (const material of this._idMaterials) material.dispose();
    if (this._idMaterials.length === 0) this._idMaterial.dispose();
    this._idMaterials.length = 0;
    this._depthMaterial.dispose();
    this._normalMaterial.dispose();
    if (this._renderTarget) this._renderTarget.dispose();
    this._renderTarget = undefined;
    if (this._identityRenderTarget) this._identityRenderTarget.dispose();
    this._identityRenderTarget = undefined;
    this._originalMaterials.clear();
    this._materialArrays.clear();
    this._lastIdentityPickStats = undefined;
    this._hiddenLods.length = 0;
    this._identityModelRoots.clear();
    this.onDisposed.trigger();
    this.onDisposed.reset();
  }

  // ---------------------------------------------------------------------------
  // Shared pick path
  // ---------------------------------------------------------------------------

  /**
   * Runs one id render and returns the raw decoded `(modelId, itemId)`
   * for the cursor pixel. Model and item identity share one RGBA32UI pixel.
   */
  private async runIdPass(
    position?: THREE.Vector2,
  ): Promise<{ modelId: string; itemId: number } | null> {
    if (!this.enabled) return null;
    if (!this._identityRenderTarget) return null;
    if (!this.world.renderer) return null;

    const fragments = this.components.get(FragmentsManager);
    if (!fragments.initialized || fragments.list.size === 0) return null;

    const prepareStartedAt = performance.now();
    const indexToModel = this.applyIdMaterial();
    const prepareMs = performance.now() - prepareStartedAt;
    if (indexToModel.size === 0) {
      const restoreStartedAt = performance.now();
      this.restoreOriginalMaterials();
      this._lastIdentityPickStats = {
        prepareMs,
        renderMs: 0,
        readbackMs: 0,
        restoreMs: performance.now() - restoreStartedAt,
        renderCalls: 0,
        renderTriangles: 0,
        tileCount: this._pickTileCount,
        visibleTileCount: this._pickVisibleTileCount,
      };
      return null;
    }

    const pos = position ?? this.mouse.position;
    let view!: { camera: THREE.Camera; readX: number; readY: number };
    let renderMs = 0;
    let renderCalls = 0;
    let renderTriangles = 0;
    let restoreMs = 0;
    try {
      const renderStartedAt = performance.now();
      view = this.renderIdPass(pos);
      renderMs = performance.now() - renderStartedAt;
      const renderInfo = this.world.renderer.three.info.render;
      renderCalls = renderInfo.calls;
      renderTriangles = renderInfo.triangles;
    } finally {
      const restoreStartedAt = performance.now();
      this.restoreOriginalMaterials();
      restoreMs = performance.now() - restoreStartedAt;
    }

    const readbackStartedAt = performance.now();
    if (this.debugMode && this._debugCanvas) this.updateDebugCanvas();
    const pixel = this.readIdentityPixelAt(
      this._identityRenderTarget,
      view.readX,
      view.readY,
    );
    this._lastIdentityPickStats = {
      prepareMs,
      renderMs,
      readbackMs: performance.now() - readbackStartedAt,
      restoreMs,
      renderCalls,
      renderTriangles,
      tileCount: this._pickTileCount,
      visibleTileCount: this._pickVisibleTileCount,
    };
    if (!pixel) return null;

    const modelIndex = pixel[0];
    if (modelIndex === 0) return null; // void
    const modelId = indexToModel.get(modelIndex);
    if (!modelId) return null;

    // The worker writes `itemId + 1` as four big-endian bytes. The shader
    // reconstructs the complete uint32 into G, so no identity bits are lost.
    const encoded = pixel[1];
    if (encoded === 0) return null;
    const itemId = encoded - 1;
    return { modelId, itemId };
  }

  /**
   * Walks every fragments model. For each shell mesh that carries the
   * per-vertex `id` attribute, stashes the original material and swaps
   * in the shared id-encoding shader. Hides LOD line meshes (which
   * lack `id`) so they don't pollute the id buffer. Returns the
   * temporary `modelIndex → modelId` map the render pass uses to
   * disambiguate models.
   */
  private applyIdMaterial(): Map<number, string> {
    const fragments = this.components.get(FragmentsManager);
    const indexToModel = new Map<number, string>();
    this._identityModelRoots.clear();
    this._pickTileCount = 0;
    this._pickVisibleTileCount = 0;
    const planes = this.world.renderer!.three.clippingPlanes ?? [];
    let nextModelIndex = 1;

    for (const [modelId, model] of fragments.list) {
      if (nextModelIndex > FastModelPicker.MAX_MODELS) break;
      const idMaterial = this.getIdMaterial(nextModelIndex);
      idMaterial.clippingPlanes = planes;
      idMaterial.clipping = planes.length > 0;
      let hasOwnedMesh = false;

      for (const [, child] of model.tiles) {
        if (!(child instanceof THREE.Mesh)) continue;
        const geom = child.geometry as THREE.BufferGeometry | undefined;
        if (!geom) continue;
        if (!geom.attributes || !geom.attributes.id) {
          if (child.visible) {
            this._hiddenLods.push(child);
            child.visible = false;
          }
          continue;
        }
        this._pickTileCount += 1;
        if (child.visible) this._pickVisibleTileCount += 1;
        this._originalMaterials.set(child, child.material);
        const original = child.material;
        const len = Array.isArray(original) ? original.length : 1;
        child.material = this.getMaterialArray(idMaterial, len);
        hasOwnedMesh = true;
      }

      if (!hasOwnedMesh) continue;
      indexToModel.set(nextModelIndex, modelId);
      this._identityModelRoots.add(model.object);
      nextModelIndex += 1;
    }

    return indexToModel;
  }

  /**
   * Renders all visible BIM models in one id pass. Each model's meshes use
   * a model-specific material, so normal depth testing resolves the
   * front-most `(modelIndex, itemId)` in a single scene render.
   */
  private renderIdPass(ndc: THREE.Vector2) {
    const view = this.createPickView(ndc);
    this.renderPickPass(
      this._identityRenderTarget!,
      view.camera,
      this._identityModelRoots,
    );
    return view;
  }

  /**
   * Builds a detached camera whose projection covers only the 4×4 source-pixel
   * region around the cursor. This preserves exact raster picking while letting
   * three.js reject off-cursor tile meshes before draw submission.
   */
  private createPickView(ndc: THREE.Vector2) {
    const sourceCamera = this.world.camera.three;
    sourceCamera.updateWorldMatrix(true, false);
    let camera = this._pickCamera;
    if (!camera || camera.type !== sourceCamera.type) {
      camera = (
        sourceCamera.clone as unknown as (recursive: boolean) => THREE.Camera
      )(false);
      this._pickCamera = camera;
    } else {
      camera.copy(sourceCamera, false);
    }
    sourceCamera.matrixWorld.decompose(
      camera.position,
      camera.quaternion,
      camera.scale,
    );
    camera.updateMatrix();
    camera.updateMatrixWorld(true);

    const sourceWidth = Math.max(1, Math.floor(this._renderTargetSize.x));
    const sourceHeight = Math.max(1, Math.floor(this._renderTargetSize.y));
    const width = Math.min(FastModelPicker.PICK_SIZE, sourceWidth);
    const height = Math.min(FastModelPicker.PICK_SIZE, sourceHeight);
    if (
      this._renderTarget!.width !== width ||
      this._renderTarget!.height !== height
    ) {
      this._renderTarget!.setSize(width, height);
    }
    if (
      this._identityRenderTarget &&
      (this._identityRenderTarget.width !== width ||
        this._identityRenderTarget.height !== height)
    ) {
      this._identityRenderTarget.setSize(width, height);
    }
    const sourceX = Math.max(
      0,
      Math.min(sourceWidth - 1, Math.floor((ndc.x + 1) * 0.5 * sourceWidth)),
    );
    const sourceY = Math.max(
      0,
      Math.min(sourceHeight - 1, Math.floor((ndc.y + 1) * 0.5 * sourceHeight)),
    );
    const startX = Math.max(
      0,
      Math.min(sourceWidth - width, sourceX - (width >> 1)),
    );
    const startY = Math.max(
      0,
      Math.min(sourceHeight - height, sourceY - (height >> 1)),
    );
    const centerX = (2 * (startX + width * 0.5)) / sourceWidth - 1;
    const centerY = (2 * (startY + height * 0.5)) / sourceHeight - 1;
    const scaleX = sourceWidth / width;
    const scaleY = sourceHeight / height;
    this._cropMatrix.set(
      scaleX,
      0,
      0,
      -centerX * scaleX,
      0,
      scaleY,
      0,
      -centerY * scaleY,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
    );
    camera.projectionMatrix.multiplyMatrices(
      this._cropMatrix,
      sourceCamera.projectionMatrix,
    );
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    return {
      camera,
      readX: sourceX - startX,
      readY: sourceY - startY,
    };
  }

  /**
   * Renders the BIM scene once through the cropped pick camera. Non-BIM meshes
   * are hidden for the duration.
   */
  private renderPickPass(
    target: THREE.WebGLRenderTarget,
    camera: THREE.Camera,
    includedModelRoots?: ReadonlySet<THREE.Object3D>,
  ) {
    const renderer = this.world.renderer!.three;
    const scene = this.world.scene.three;
    const fragments = this.components.get(FragmentsManager);
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    const prevScissorTest = renderer.getScissorTest();
    const prevScissor = renderer.getScissor(new THREE.Vector4());

    const prevBackground = (scene as THREE.Scene).background;
    const nonBimVisibility = this.hideNonBimMeshes(
      scene,
      fragments,
      includedModelRoots,
    );
    try {
      (scene as THREE.Scene).background = null;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = false;
      renderer.setScissorTest(false);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
    } finally {
      for (const [obj, was] of nonBimVisibility) obj.visible = was;
      renderer.setRenderTarget(prevTarget);
      renderer.setScissorTest(prevScissorTest);
      renderer.setScissor(prevScissor);
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      (scene as THREE.Scene).background = prevBackground;
    }
  }

  /**
   * Renders the picker's color target with the BIM tile shells using
   * the given override-style material, swapped in **per-mesh** rather
   * than via `scene.overrideMaterial`.
   *
   * Why per-mesh swap and not `scene.overrideMaterial`: fragments runs
   * its own LOD/visibility logic on tile shells (`mesh.visible`
   * toggled internally based on current LOD stage and frustum). At
   * the moment we render, most tile shells are flagged invisible —
   * `overrideMaterial` then renders nothing and we read back a
   * cleared pixel. Per-mesh swap mirrors what {@link renderIdPass}
   * does; we also force each shell visible for the duration of the
   * render. The same cropped camera is shared with the identity pass.
   *
   * Honours the renderer's clipping planes so picked depth/normal
   * match what's actually rendered on screen.
   */
  private renderWithTileMaterial(
    material: THREE.ShaderMaterial,
    ndc: THREE.Vector2,
  ) {
    const renderer = this.world.renderer!.three;
    const scene = this.world.scene.three;
    const view = this.createPickView(ndc);
    const fragments = this.components.get(FragmentsManager);

    // Sync clipping planes onto the swap material.
    const planes = renderer.clippingPlanes ?? [];
    material.clippingPlanes = planes;
    material.clipping = planes.length > 0;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    const prevScissorTest = renderer.getScissorTest();
    const prevScissor = renderer.getScissor(new THREE.Vector4());

    // Same background caveat as renderPickPass: a non-null scene background
    // would force-clear our target mid-pass and, for the depth/normal reads,
    // paint the background colour into pixels with no geometry so they decode
    // to a bogus point/normal instead of void. Null it for the render and
    // restore below (issues #737 / #773).
    const prevBackground = (scene as THREE.Scene).background;
    // Per-mesh material + visibility swap. We only touch shells that
    // carry the `id` attribute — those are the BIM tile shells.
    // LOD-stage line meshes (no `id`) are hidden so they don't write
    // into our pick buffer.
    // Only touch shells that fragments currently has visible. Forcing
    // hidden tiles visible leaks stale LOD-stage geometry into the
    // pick — those tiles sit at slightly different depths than the
    // active ones and would dominate `gl_FragCoord.z` at the cursor.
    const matSwap = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    const hiddenLines: THREE.Object3D[] = [];
    for (const [, model] of fragments.list) {
      for (const [, child] of model.tiles) {
        if (!(child instanceof THREE.Mesh)) continue;
        const geom = child.geometry as THREE.BufferGeometry | undefined;
        if (!geom) continue;
        if (!geom.attributes || !geom.attributes.id) {
          if (child.visible) {
            hiddenLines.push(child);
            child.visible = false;
          }
          continue;
        }
        // Mirror the id pass: we only rasterize tiles fragments has
        // currently flagged visible. Forcing hidden tiles visible
        // would render stale LOD-stage geometry that sits at slightly
        // different depths than the active tiles.
        if (!child.visible) continue;
        matSwap.set(child, child.material);
        // Wrap in an array so three honours `geometry.groups` (per-item
        // visibility ranges). With a single Material, three draws the
        // whole indexed geometry and the depth/normal at the cursor
        // would reflect a hidden item. Length must match the original
        // so highlight groups (materialIndex >= 1) also draw — see the
        // longer note in `applyIdMaterial`.
        const original = child.material;
        const len = Array.isArray(original) ? original.length : 1;
        child.material = this.getMaterialArray(material, len);
      }
    }

    const nonBimVisibility = this.hideNonBimMeshes(scene, fragments);
    try {
      (scene as THREE.Scene).background = null;
      renderer.setRenderTarget(this._renderTarget!);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = false;
      renderer.setScissorTest(false);
      renderer.clear(true, true, false);
      renderer.render(scene, view.camera);
    } finally {
      for (const [mesh, mat] of matSwap) mesh.material = mat;
      for (const obj of hiddenLines) obj.visible = true;
      for (const [obj, was] of nonBimVisibility) obj.visible = was;
      renderer.setRenderTarget(prevTarget);
      renderer.setScissorTest(prevScissorTest);
      renderer.setScissor(prevScissor);
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      (scene as THREE.Scene).background = prevBackground;
    }
    return view;
  }

  private renderDepthPass(ndc: THREE.Vector2) {
    return this.renderWithTileMaterial(this._depthMaterial, ndc);
  }

  private renderNormalPass(ndc: THREE.Vector2) {
    return this.renderWithTileMaterial(this._normalMaterial, ndc);
  }

  private restoreOriginalMaterials() {
    for (const [mesh, mat] of this._originalMaterials) {
      mesh.material = mat;
    }
    this._originalMaterials.clear();

    for (const obj of this._hiddenLods) obj.visible = true;
    this._hiddenLods.length = 0;
    this._identityModelRoots.clear();
  }

  private getIdMaterial(modelIndex: number) {
    const index = modelIndex - 1;
    let material = this._idMaterials[index];
    if (!material) {
      material = index === 0 ? this._idMaterial : this._idMaterial.clone();
      this._idMaterials[index] = material;
    }
    material.uniforms.modelIndex.value = modelIndex;
    return material;
  }

  private getMaterialArray(material: THREE.Material, length: number) {
    let byLength = this._materialArrays.get(material);
    if (!byLength) {
      byLength = new Map<number, THREE.Material[]>();
      this._materialArrays.set(material, byLength);
    }
    let materials = byLength.get(length);
    if (!materials) {
      materials = new Array(length).fill(material);
      byLength.set(length, materials);
    }
    return materials;
  }

  private hideNonBimMeshes(
    scene: THREE.Object3D,
    fragments: FragmentsManager,
    includedModelRoots?: ReadonlySet<THREE.Object3D>,
  ) {
    const modelRoots = new Set<THREE.Object3D>();
    for (const [, model] of fragments.list) modelRoots.add(model.object);
    const visibility = new Map<THREE.Object3D, boolean>();
    if (includedModelRoots) {
      for (const root of modelRoots) {
        if (includedModelRoots.has(root)) continue;
        visibility.set(root, root.visible);
        root.visible = false;
      }
    }
    const stack: THREE.Object3D[] = [scene];
    while (stack.length) {
      const node = stack.pop()!;
      if (modelRoots.has(node)) continue;
      if (node !== scene && (node as THREE.Mesh).isMesh) {
        visibility.set(node, node.visible);
        node.visible = false;
      }
      for (const child of node.children) stack.push(child);
    }
    return visibility;
  }

  private readPixelAt(
    target: THREE.WebGLRenderTarget,
    x: number,
    y: number,
  ): Uint8Array | null {
    const renderer = this.world.renderer!.three;
    const cx = Math.max(0, Math.min(target.width - 1, Math.floor(x)));
    const cy = Math.max(0, Math.min(target.height - 1, Math.floor(y)));
    const pixels = new Uint8Array(4);
    renderer.readRenderTargetPixels(target, cx, cy, 1, 1, pixels);
    return pixels;
  }

  private readIdentityPixelAt(
    target: THREE.WebGLRenderTarget,
    x: number,
    y: number,
  ): Uint32Array | null {
    const renderer = this.world.renderer!.three;
    const cx = Math.max(0, Math.min(target.width - 1, Math.floor(x)));
    const cy = Math.max(0, Math.min(target.height - 1, Math.floor(y)));
    const pixels = new Uint32Array(4);
    renderer.readRenderTargetPixels(target, cx, cy, 1, 1, pixels);
    return pixels;
  }

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  /**
   * Single id shader, single render pass. Reads:
   *   - `id`: per-vertex `vec4` — the four bytes of `itemId + 1`
   *     (big-endian) supplied as a non-normalised `Uint8Array`
   *     attribute by fragments. Each component is 0–255 as a float.
   *   - `modelIndex` uniform — the uint32 index assigned to the currently-
   *     rendered model.
   *
   * Output writes `(modelIndex, itemId + 1, 0, 1)` into one RGBA32UI
   * pixel. Reconstructing all four id bytes preserves the Fragments uint32
   * identity contract while retaining one render and one synchronous readback.
   */
  private buildIdMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { modelIndex: { value: 1 } },
      vertexShader: `
        in vec4 id;
        uniform uint modelIndex;
        flat out uvec4 vIdentity;
        #if NUM_CLIPPING_PLANES > 0
          out vec3 vClipPosition;
        #endif
        void main() {
          uvec4 idBytes = uvec4(id);
          uint encodedItemId =
            (idBytes.x << 24u) |
            (idBytes.y << 16u) |
            (idBytes.z << 8u) |
            idBytes.w;
          vIdentity = uvec4(modelIndex, encodedItemId, 0u, 1u);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          #if NUM_CLIPPING_PLANES > 0
            vClipPosition = -mvPosition.xyz;
          #endif
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        precision highp float;
        precision highp int;
        flat in uvec4 vIdentity;
        layout(location = 0) out uvec4 outIdentity;
        #if NUM_CLIPPING_PLANES > 0
          in vec3 vClipPosition;
          uniform vec4 clippingPlanes[NUM_CLIPPING_PLANES];
        #endif
        void main() {
          #if NUM_CLIPPING_PLANES > 0
            for (int i = 0; i < NUM_CLIPPING_PLANES; i++) {
              vec4 plane = clippingPlanes[i];
              if (dot(vClipPosition, plane.xyz) > plane.w) discard;
            }
          #endif
          outIdentity = vIdentity;
        }
      `,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
  }

  /**
   * Builds the depth-encoding override material used by
   * {@link renderDepthPass}. Includes three's `packing` chunk to reuse
   * the standard `packDepthToRGBA` helper, which is robust to the
   * round-trip through an `UNSIGNED_BYTE` color attachment (the chunk
   * pre-multiplies by `256/255` so `depth = 1.0` decodes back exactly
   * to `1.0`). Decode side mirrors this with the same scaling factors;
   * see {@link unpackDepthFromRGBA} below.
   */
  private buildDepthMaterial(): THREE.ShaderMaterial {
    // Depth packed manually instead of via three's `#include <packing>`
    // chunk — `ShaderMaterial` doesn't reliably resolve chunk includes
    // for custom shaders, and we were silently getting back unrelated
    // bytes that decoded to garbage.
    //
    // Convention (must mirror `unpackDepthFromRGBA` below):
    //   r = fract(v * 256^3)  (least significant)
    //   g = fract(v * 256^2)
    //   b = fract(v * 256)
    //   a = v                 (most significant)
    // The `r.yzw -= r.xyz / 256` step shaves the residual from each
    // higher component so the encoded value is exact. The final
    // `* 256/255` upscale ensures `v = 1.0` lands at all-255 bytes
    // rather than rolling over to 0.
    return new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: `
        #if NUM_CLIPPING_PLANES > 0
          varying vec3 vClipPosition;
        #endif
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          #if NUM_CLIPPING_PLANES > 0
            vClipPosition = -mvPosition.xyz;
          #endif
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        #if NUM_CLIPPING_PLANES > 0
          varying vec3 vClipPosition;
          uniform vec4 clippingPlanes[NUM_CLIPPING_PLANES];
        #endif
        void main() {
          #if NUM_CLIPPING_PLANES > 0
            for (int i = 0; i < NUM_CLIPPING_PLANES; i++) {
              vec4 plane = clippingPlanes[i];
              if (dot(vClipPosition, plane.xyz) > plane.w) discard;
            }
          #endif
          float v = gl_FragCoord.z;
          vec4 r = vec4(
            fract(v * 16777216.0),
            fract(v * 65536.0),
            fract(v * 256.0),
            v
          );
          r.yzw -= r.xyz * (1.0 / 256.0);
          gl_FragColor = r * (256.0 / 255.0);
        }
      `,
      side: THREE.DoubleSide,
    });
  }

  /**
   * World-space normal in RGB. Handles backfaces by flipping the
   * encoded normal so consumers always get the surface they're looking
   * at. Decode side: `(rgb * 2 - 1)` → renormalize.
   */
  private buildNormalMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: `
        varying vec3 vWorldNormal;
        #if NUM_CLIPPING_PLANES > 0
          varying vec3 vClipPosition;
        #endif
        void main() {
          vWorldNormal = normalize(
            (modelMatrix * vec4(normal, 0.0)).xyz
          );
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          #if NUM_CLIPPING_PLANES > 0
            vClipPosition = -mvPosition.xyz;
          #endif
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldNormal;
        #if NUM_CLIPPING_PLANES > 0
          varying vec3 vClipPosition;
          uniform vec4 clippingPlanes[NUM_CLIPPING_PLANES];
        #endif
        void main() {
          #if NUM_CLIPPING_PLANES > 0
            for (int i = 0; i < NUM_CLIPPING_PLANES; i++) {
              vec4 plane = clippingPlanes[i];
              if (dot(vClipPosition, plane.xyz) > plane.w) discard;
            }
          #endif
          vec3 n = normalize(vWorldNormal);
          if (!gl_FrontFacing) n = -n;
          gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
        }
      `,
      side: THREE.DoubleSide,
    });
  }

  private setupRenderTarget() {
    const worldRenderer = this.world.renderer!;
    const renderer = worldRenderer.three;
    const size = renderer.getSize(new THREE.Vector2());
    this._renderTargetSize.copy(size);
    const width = Math.min(
      FastModelPicker.PICK_SIZE,
      Math.max(1, Math.floor(size.x)),
    );
    const height = Math.min(
      FastModelPicker.PICK_SIZE,
      Math.max(1, Math.floor(size.y)),
    );

    const opts: THREE.RenderTargetOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    };
    this._renderTarget = new THREE.WebGLRenderTarget(width, height, opts);
    this._identityRenderTarget = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RGBAIntegerFormat,
      type: THREE.UnsignedIntType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    if (this.debugMode) this.setupDebugCanvas();

    if (this._resizeEvent && this._resizeHandler) {
      this._resizeEvent.remove(this._resizeHandler);
    }
    this._resizeHandler = (newSize) => {
      this._renderTargetSize.copy(newSize);
      const renderTarget = this._renderTarget;
      const identityRenderTarget = this._identityRenderTarget;
      if (!renderTarget || !identityRenderTarget) return;
      const nextWidth = Math.min(
        FastModelPicker.PICK_SIZE,
        Math.max(1, Math.floor(newSize.x)),
      );
      const nextHeight = Math.min(
        FastModelPicker.PICK_SIZE,
        Math.max(1, Math.floor(newSize.y)),
      );
      renderTarget.setSize(nextWidth, nextHeight);
      identityRenderTarget.setSize(nextWidth, nextHeight);
      if (this._debugCanvas) {
        this._debugCanvas.width = nextWidth;
        this._debugCanvas.height = nextHeight;
      }
    };
    this._resizeEvent = worldRenderer.onResize;
    this._resizeEvent.add(this._resizeHandler);
  }

  private setupDebugCanvas() {
    if (this._debugCanvas) return;
    const width =
      this._identityRenderTarget?.width ?? FastModelPicker.PICK_SIZE;
    const height =
      this._identityRenderTarget?.height ?? FastModelPicker.PICK_SIZE;

    this._debugContainer = document.createElement("div");
    this._debugContainer.style.position = "fixed";
    this._debugContainer.style.top = "10px";
    this._debugContainer.style.right = "10px";
    this._debugContainer.style.width = "300px";
    this._debugContainer.style.height = "300px";
    this._debugContainer.style.border = "2px solid #fff";
    this._debugContainer.style.backgroundColor = "#000";
    this._debugContainer.style.zIndex = "10000";
    this._debugContainer.style.pointerEvents = "none";

    this._debugCanvas = document.createElement("canvas");
    this._debugCanvas.width = width;
    this._debugCanvas.height = height;
    this._debugCanvas.style.width = "100%";
    this._debugCanvas.style.height = "100%";
    this._debugCanvas.style.imageRendering = "pixelated";
    this._debugContainer.appendChild(this._debugCanvas);
    document.body.appendChild(this._debugContainer);
  }

  private removeDebugCanvas() {
    if (this._debugContainer) {
      this._debugContainer.remove();
      this._debugContainer = undefined;
      this._debugCanvas = undefined;
    }
  }

  private updateDebugCanvas() {
    if (
      !this._debugCanvas ||
      !this._identityRenderTarget ||
      !this.world.renderer
    ) {
      return;
    }
    const renderer = this.world.renderer.three;
    const width = this._identityRenderTarget.width;
    const height = this._identityRenderTarget.height;

    const pixels = new Uint32Array(width * height * 4);
    renderer.readRenderTargetPixels(
      this._identityRenderTarget,
      0,
      0,
      width,
      height,
      pixels,
    );

    const ctx = this._debugCanvas.getContext("2d");
    if (!ctx) return;
    const imageData = ctx.createImageData(width, height);
    // Flip Y axis: WebGL has Y=0 at bottom, canvas 2D has Y=0 at top.
    const rowSize = width * 4;
    for (let y = 0; y < height; y++) {
      const srcRow = y;
      const dstRow = height - 1 - y;
      const srcOffset = srcRow * rowSize;
      const dstOffset = dstRow * rowSize;
      for (let x = 0; x < width; x++) {
        const src = srcOffset + x * 4;
        const dst = dstOffset + x * 4;
        const modelIndex = pixels[src];
        const itemId = pixels[src + 1];
        // Debug-only byte visualization of the two uint32 identity channels.
        // eslint-disable-next-line no-bitwise
        imageData.data[dst] = modelIndex & 0xff;
        // eslint-disable-next-line no-bitwise
        imageData.data[dst + 1] = (itemId >> 16) & 0xff;
        // eslint-disable-next-line no-bitwise
        imageData.data[dst + 2] = itemId & 0xff;
        imageData.data[dst + 3] = modelIndex === 0 ? 0 : 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }
}

// ---------------------------------------------------------------------------
// Depth helpers
// ---------------------------------------------------------------------------

/**
 * Inverse of three's `packDepthToRGBA` GLSL helper. The shader chunk
 * pre-multiplies its packed bytes by `256/255` (so `depth = 1.0` round-
 * trips to `(255, 255, 255, 255)`); we mirror that with `255/256` here
 * and the reciprocals of the chunk's `PackFactors`.
 */
function unpackDepthFromRGBA(pixels: Uint8Array): number {
  const r = pixels[0] / 255;
  const g = pixels[1] / 255;
  const b = pixels[2] / 255;
  const a = pixels[3] / 255;
  const downscale = 255 / 256;
  return downscale * (r / (256 * 256 * 256) + g / (256 * 256) + b / 256 + a);
}

/**
 * Convert a cursor `ndc` and a `[0..1]` depth-buffer sample to a
 * world-space point. NDC z lives in `[-1..1]` so we expand the depth
 * sample before unprojecting through the camera's matrices.
 */
function unprojectToWorld(
  ndc: THREE.Vector2,
  depth: number,
  camera: THREE.Camera,
): THREE.Vector3 {
  const v = new THREE.Vector3(ndc.x, ndc.y, depth * 2 - 1);
  v.unproject(camera);
  return v;
}
