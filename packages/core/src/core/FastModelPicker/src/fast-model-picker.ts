/* eslint-disable max-classes-per-file */
import * as THREE from "three";
import { FragmentsManager } from "../../../fragments/FragmentsManager";
import type { Components } from "../../Components";
import { Mouse } from "../../Raycasters/src/mouse";
import type { BaseRenderer } from "../../Types/src/base-renderer";
import { Component } from "../../Types/src/component";
import { Event } from "../../Types/src/event";
import type { Disposable } from "../../Types/src/interfaces";
import type { World } from "../../Types/src/world";

/**
 * Attachment index of each pick output in the pick render target. Matches
 * the `layout(location)` of that output in
 * {@link FastModelPicker.buildPickMaterial}. Adding an output takes a key
 * here, an `out` in the shader and a decoder below; WebGL2 guarantees at
 * least 4 draw buffers.
 */
const PickOutput = { id: 0, depth: 1, normal: 2 } as const;

type PickOutputName = keyof typeof PickOutput;

const PICK_OUTPUT_NAMES = Object.keys(PickOutput) as PickOutputName[];

/** The outputs {@link FastModelPicker.renderPick} reads back. */
type PickRequest = Readonly<Partial<Record<PickOutputName, boolean>>>;

/** One RGBA pixel per output, filled by {@link FastModelPicker.renderPick}. */
interface PickBuffers {
  readonly id: Uint32Array;
  readonly depth: Uint8Array;
  readonly normal: Uint8Array;
}

/**
 * A decoded pick. Every value is owned by the result: no reference into the
 * picker's reused pixel buffers, camera snapshot or index map.
 * {@link FastModelPicker.pick} is synchronous and decodes before it returns,
 * so a caller can await anything it likes afterwards — a `localId`
 * translation, say — without the result drifting under it.
 */
interface Pick {
  /** The item under the cursor, when the `id` output was requested. */
  item: { modelId: string; itemId: number } | null;
  /**
   * The surface under the cursor, when the `depth` output was requested.
   * `distance` is measured from the camera the pick was rendered with.
   */
  surface: { point: THREE.Vector3; distance: number } | null;
  /** The surface normal, when the `normal` output was requested. */
  normal: THREE.Vector3 | null;
}

/** What {@link FastModelPicker.renderPick} hands to the decoders. */
interface PickFrame {
  /** The index each model was drawn with. */
  indexToModel: ReadonlyMap<number, string>;
  /**
   * The camera the pick was rendered with, a snapshot of the world camera.
   * Decode against it rather than `world.camera`, which may have moved on.
   * Reused by the next pick, so decode before awaiting anything.
   */
  camera: THREE.Camera;
  /** Center of the read pixel, in {@link camera}'s NDC. */
  ndc: THREE.Vector2;
  /**
   * Whether the renderer draws with a reversed depth buffer
   * (`reversedDepthBuffer: true` and `EXT_clip_control` available). Then
   * depth runs 1 at the near plane to 0 at the far plane and already is the
   * NDC z, instead of `ndc.z * 0.5 + 0.5`.
   */
  reversedDepth: boolean;
}

const ID_REQUEST: PickRequest = { id: true };
const DEPTH_REQUEST: PickRequest = { depth: true };
const NORMAL_REQUEST: PickRequest = { normal: true };
const FULL_REQUEST: PickRequest = { id: true, depth: true, normal: true };
const NO_REQUEST: PickRequest = {};

/** The viewport center, which the debug overlay renders around. Never written. */
const ORIGIN = new THREE.Vector2();

/**
 * The camera every pick renders through. Its matrices are written by
 * `snapshotCamera` before each render, so it has nothing to recompute.
 *
 * With a reversed depth buffer, three calls `updateProjectionMatrix()` on
 * the first render through a camera that is not yet flagged as reversed.
 * A bare `THREE.Camera` has no such method, so the first pick threw. A
 * `PerspectiveCamera` or `OrthographicCamera` would not throw, but it would
 * rebuild the projection from its own fov / frustum and overwrite the
 * narrowed pick projection, so that first pick would read the wrong pixel.
 * The copied projection is the world camera's, which three has already
 * switched to reversed depth when it rendered the scene, so keeping the
 * written matrix is the correct answer.
 */
class PickCamera extends THREE.Camera {
  updateProjectionMatrix() {
    // Intentionally empty: the projection is copied, never derived.
  }
}

// ---------------------------------------------------------------------------
// Render target / scene helpers
// ---------------------------------------------------------------------------

/** A render target with one RGBA8 attachment per {@link PickOutput}. */
function createPickTarget(width: number, height: number) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    count: PICK_OUTPUT_NAMES.length,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
  });
  // Keep every Fragments item id and model index, including the high byte.
  const identity = target.textures[PickOutput.id];
  identity.format = THREE.RGBAIntegerFormat;
  identity.type = THREE.UnsignedIntType;
  identity.internalFormat = "RGBA32UI";
  return target;
}

/** Whether three draws `object` itself, as opposed to only its children. */
function isRenderable(object: THREE.Object3D) {
  const flags = object as Partial<
    Record<"isMesh" | "isLine" | "isPoints" | "isSprite", boolean>
  >;
  return Boolean(
    flags.isMesh || flags.isLine || flags.isPoints || flags.isSprite,
  );
}

/**
 * How Fragments packs a compacted SHELL tile index, published in
 * `geometry.userData`: packed run `i` holds the full-index slots
 * `[start[i], start[i] + count[i])` at the packed slots from `offset[i]`.
 * Runs follow the full index in order and do not overlap.
 */
interface CompactIndexRuns {
  start: ArrayLike<number>;
  count: ArrayLike<number>;
  offset: ArrayLike<number>;
}

/**
 * Where the full-index range `[start, start + count)` of a tile is drawn in
 * the tile's current index. A compacted index holds only the visible runs,
 * so the hidden parts of the range map to nothing; parts that meet in the
 * packing form one range.
 */
function toDrawnIndexRanges(
  geometry: THREE.BufferGeometry,
  start: number,
  count: number,
): { start: number; count: number }[] {
  const { compactIndex, compactRuns } = geometry.userData as {
    compactIndex?: boolean;
    compactRuns?: CompactIndexRuns;
  };
  if (!compactIndex || !compactRuns) return [{ start, count }];
  const {
    start: runStarts,
    count: runCounts,
    offset: runOffsets,
  } = compactRuns;
  const end = start + count;
  // The first run that ends after the range starts.
  let first = 0;
  let last = runStarts.length;
  while (first < last) {
    const middle = (first + last) >>> 1;
    if (runStarts[middle] + runCounts[middle] <= start) first = middle + 1;
    else last = middle;
  }
  const drawn: { start: number; count: number }[] = [];
  for (let i = first; i < runStarts.length && runStarts[i] < end; i++) {
    const from = Math.max(start, runStarts[i]);
    const to = Math.min(end, runStarts[i] + runCounts[i]);
    const at = runOffsets[i] + from - runStarts[i];
    const previous = drawn[drawn.length - 1];
    if (previous && previous.start + previous.count === at)
      previous.count += to - from;
    else drawn.push({ start: at, count: to - from });
  }
  return drawn;
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/**
 * Inverse of the depth packing in {@link FastModelPicker.buildPickMaterial}.
 * The shader pre-multiplies its packed bytes by `256/255` (so `depth = 1.0`
 * round-trips to `(255, 255, 255, 255)`); we mirror that with `255/256`
 * here.
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
 * world-space point, through the camera's matrices.
 *
 * With a standard depth buffer NDC z lives in `[-1..1]`, so the sample is
 * expanded. With a reversed one three sets clip control to a `[0..1]` depth
 * range and builds the projection reversed, so the sample IS the NDC z;
 * expanding it would put every point just past the near plane.
 */
function unprojectToWorld(
  ndc: THREE.Vector2,
  depth: number,
  camera: THREE.Camera,
  reversedDepth: boolean,
): THREE.Vector3 {
  const z = reversedDepth ? depth : depth * 2 - 1;
  const v = new THREE.Vector3(ndc.x, ndc.y, z);
  v.unproject(camera);
  return v;
}

/**
 * Decodes the {@link PickOutput.id} pixel into the picked item, or `null`
 * over empty space.
 */
function decodeId(
  pixel: Uint32Array,
  indexToModel: ReadonlyMap<number, string>,
) {
  const modelId = indexToModel.get(pixel[0]);
  const encoded = pixel[1];
  if (!modelId || encoded === 0) return null;
  return { modelId, itemId: encoded - 1 };
}

/**
 * Decodes the {@link PickOutput.depth} pixel into the world-space point it
 * describes, or `null` over empty space.
 */
function decodePoint(pixel: Uint8Array, frame: PickFrame) {
  if (pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 0) {
    return null; // cleared / void — nothing was drawn here
  }
  const depth = unpackDepthFromRGBA(pixel);
  // The far plane (depth ≈ 1, or ≈ 0 when reversed) means nothing in front
  // of the camera at that pixel. Treat as void rather than returning a
  // point on the far plane.
  const { reversedDepth } = frame;
  if (reversedDepth ? depth <= 1e-6 : depth >= 1.0 - 1e-6) return null;
  return unprojectToWorld(frame.ndc, depth, frame.camera, reversedDepth);
}

/**
 * Decodes the {@link PickOutput.normal} pixel into a unit world-space
 * normal, or `null` over empty space.
 */
function decodeNormal(pixel: Uint8Array) {
  if (pixel[3] === 0) return null; // void pixel — nothing rendered here
  // No zero-length guard: the shader writes a unit normal, and byte
  // quantization can't land all three channels within 1/255 of the origin,
  // so the shortest vector this can decode is still well clear of zero.
  return new THREE.Vector3(
    (pixel[0] / 255) * 2 - 1,
    (pixel[1] / 255) * 2 - 1,
    (pixel[2] / 255) * 2 - 1,
  ).normalize();
}

async function itemIdToLocalId(
  fragments: FragmentsManager,
  modelId: string,
  itemId: number,
) {
  const model = fragments.list.get(modelId);
  if (!model) return null;
  const localIds = await model.getLocalIdsFromItemIds([itemId]);
  const localId = localIds?.[0];
  return localId ?? null;
}

/**
 * Optional exact model/tile ranges allowed to contribute to a pick. Ranges
 * address the tile's full index, as Fragments item draw chunks do; a
 * compacted tile maps them to its packed slots, and they are intersected with
 * the tile's drawable groups. Undefined permits all drawable geometry; an
 * empty map permits none.
 */
export type FastModelPickerCandidateMap = ReadonlyMap<
  string,
  ReadonlyMap<THREE.Mesh, readonly { start: number; count: number }[]>
>;

const CLIPPING_FRAGMENT = `
  #if NUM_CLIPPING_PLANES > 0
    for (int i = 0; i < UNION_CLIPPING_PLANES; i++) {
      vec4 plane = clippingPlanes[i];
      if (dot(vClipPosition, plane.xyz) > plane.w) discard;
    }
    #if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
      bool clipped = true;
      for (int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i++) {
        vec4 plane = clippingPlanes[i];
        clipped = dot(vClipPosition, plane.xyz) > plane.w && clipped;
      }
      if (clipped) discard;
    #endif
  #endif
`;

/**
 * GPU-readback picker that identifies what's under a screen position
 * without going through the worker raycast.
 *
 * - {@link getModelAt} returns the model id under the cursor.
 * - {@link getItemAt} returns the item itself (`modelId` + `localId`).
 * - {@link getPointAt} / {@link getNormalAt} return the surface point and normal.
 * - {@link getFullPick} returns all of the above from the same pick.
 *
 * Every query goes through {@link renderPick}: one render of the BIM scene
 * into a 4×4 multiple-render-target, through a camera whose frustum covers
 * only the pixel under the cursor. The pick shader writes the item id,
 * depth and normal of that pixel into one attachment each, so they always
 * describe the same fragment; each query reads back only the attachments
 * it needs.
 *
 * What can be picked is what is drawn. An item that fragments currently draws
 * at a reduced LOD — a line mesh carrying no `id` attribute — is not pickable,
 * and the pick resolves to whatever is behind it; the worker raycast tests the
 * authored geometry instead, so the two can disagree on small or distant
 * items, see {@link collectPickables}.
 *
 * Identity uses RGBA32UI: (modelIndex, itemId + 1, 0, 1). Zero is the
 * unwritten sentinel. Indices are assigned per pick and never accumulate.
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
   * When `true`, mirrors the id output of the whole viewport to a debug
   * canvas pinned in the top-right corner. Each model shows up as a
   * near-uniform red band (the low byte of its index) modulated by varying greens /
   * blues from the per-item id encoding.
   */
  debugMode = false;

  /**
   * Maximum models per pick; zero is reserved as the void sentinel.
   */
  static readonly MAX_MODELS = 0xffffffff;

  static readonly PICK_SIZE = 4;

  /** Fixed-size target; independent of viewport and device pixel ratio. */
  private _pickTarget?: THREE.WebGLRenderTarget = createPickTarget(
    FastModelPicker.PICK_SIZE,
    FastModelPicker.PICK_SIZE,
  );

  /** Viewport-sized target for the debug overlay, created on demand. */
  private _debugTarget?: THREE.WebGLRenderTarget;

  private _pickBuffers: PickBuffers = {
    id: new Uint32Array(4),
    depth: new Uint8Array(4),
    normal: new Uint8Array(4),
  };

  private _debugCanvas?: HTMLCanvasElement;
  private _debugContainer?: HTMLDivElement;

  /**
   * Template for the cached pick materials, sharing one shader program while
   * keeping each source material's local clipping and visible-group semantics.
   */
  private _pickMaterial: THREE.ShaderMaterial;

  /** Snapshot of the world camera with a narrowed projection. */
  private _pickCamera = new PickCamera();
  private _pickMatrix = new THREE.Matrix4();
  private _pickNdc = new THREE.Vector2();
  private _viewportSize = new THREE.Vector2();
  private _clearColor = new THREE.Color();
  /** The pick camera's world position, for measuring distance to a hit. */
  private _cameraPosition = new THREE.Vector3();

  /**
   * Per-pick state filled by {@link collectPickables}. `_meshIndices` is read
   * by the pick material while drawing; `_indexToModel` outlives the render
   * so the caller can decode the id output.
   */
  private _meshIndices = new Map<THREE.Object3D, number>();
  private _indexToModel = new Map<number, string>();
  private _modelIndices = new Map<string, number>();
  private _modelRoots = new Map<THREE.Object3D, string>();

  /** Undo log for {@link collectPickables}, drained by {@link restorePickables}. */
  private _hidden: THREE.Object3D[] = [];
  private _originalMaterials = new Map<
    THREE.Mesh,
    THREE.Material | THREE.Material[]
  >();
  private _pickMaterials = new Map<THREE.Material, THREE.ShaderMaterial>();
  private _pickMaterialArrays = new Map<THREE.Material[], THREE.Material[]>();
  private _usedMaterials = new Set<THREE.Material>();
  private _usedMaterialArrays = new Set<THREE.Material[]>();

  private _walkNodes: THREE.Object3D[] = [];
  private _walkOwners: (string | null)[] = [];

  /** The pick material's `clippingPlanes`, refilled by {@link collectLocalPlanes}. */
  private _localPlanes: THREE.Plane[] = [];
  private _originalGroups = new Map<
    THREE.Mesh,
    THREE.BufferGeometry["groups"]
  >();
  private _clearPixel = new Float32Array(4);
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

  constructor(components: Components, world: World) {
    if (!world.renderer) {
      throw new Error("A renderer is needed for the FastModelPicker to work!");
    }
    this.world = world;
    this.mouse = new Mouse(world.renderer.three.domElement);
    this.components = components;
    this._pickMaterial = this.buildPickMaterial();
    // The matrices are copied from the world camera on every pick; keep
    // `render()` from recomputing them out of the unused local transform.
    this._pickCamera.matrixAutoUpdate = false;
    this._pickCamera.matrixWorldAutoUpdate = false;
  }

  /**
   * Returns the model id under the given screen position, or `null` if
   * the cursor is over empty space.
   *
   * Cheaper than {@link getItemAt} because we don't resolve the
   * `localId`; we just read the model index.
   *
   * @param position - Normalized device coords. Defaults to the
   *   picker's last known mouse position.
   */
  async getModelAt(
    position?: THREE.Vector2,
    candidates?: FastModelPickerCandidateMap,
  ): Promise<string | null> {
    return this.pick(position, ID_REQUEST, candidates)?.item?.modelId ?? null;
  }

  /**
   * Returns `{ modelId, localId }` for the item under the given screen
   * position, or `null` if the cursor is over empty space.
   *
   * The vertex `id` attribute encodes the internal **itemId** (the
   * FlatBuffer `sample.item()` index, key for `boxes.sampleOf`) rather
   * than the user-facing localId, which unblocks the snap path's O(1)
   * sample lookup. The model resolves `localId` using its item map. Internal consumers that only need itemId (e.g. snap) can
   * read it from the result directly.
   *
   * @param position - Normalized device coords. Defaults to the
   *   picker's last known mouse position.
   */
  async getItemAt(
    position?: THREE.Vector2,
    candidates?: FastModelPickerCandidateMap,
  ): Promise<{ modelId: string; localId: number; itemId: number } | null> {
    const item = this.pick(position, ID_REQUEST, candidates)?.item;
    if (!item) return null;
    const fragments = this.components.get(FragmentsManager);
    const localId = await itemIdToLocalId(fragments, item.modelId, item.itemId);
    if (localId === undefined || localId === null) return null;
    return { modelId: item.modelId, localId, itemId: item.itemId };
  }

  /**
   * Returns the world-space point under the given screen position, or
   * `null` if the cursor is over empty space.
   *
   * Reads the packed `gl_FragCoord.z` of the picked pixel and unprojects
   * it through the pick camera. Useful for things like "set camera orbit
   * center to what the user just clicked on".
   *
   * @param position - Normalized device coords. Defaults to the
   *   picker's last known mouse position.
   */
  getPointAtSync(
    position?: THREE.Vector2,
    candidates?: FastModelPickerCandidateMap,
  ): THREE.Vector3 | null {
    return (
      this.pick(position, DEPTH_REQUEST, candidates)?.surface?.point ?? null
    );
  }

  async getPointAt(
    position?: THREE.Vector2,
    candidates?: FastModelPickerCandidateMap,
  ): Promise<THREE.Vector3 | null> {
    return this.getPointAtSync(position, candidates);
  }

  /**
   * Returns the world-space surface normal under the cursor, or `null`
   * if the cursor is over empty space.
   *
   * @param position - Normalized device coords. Defaults to the
   *   picker's last known mouse position.
   */
  async getNormalAt(
    position?: THREE.Vector2,
    candidates?: FastModelPickerCandidateMap,
  ): Promise<THREE.Vector3 | null> {
    return this.pick(position, NORMAL_REQUEST, candidates)?.normal ?? null;
  }

  /**
   * One-shot pick that produces the full result shape consumers need:
   * `{ modelId, localId, point, normal, distance }`, all from the same
   * render.
   *
   * Returns `null` if the cursor is over empty space, the id output
   * decodes to the void sentinel, or the depth round-trip yields the
   * far plane.
   */
  async getFullPick(
    position?: THREE.Vector2,
    candidates?: FastModelPickerCandidateMap,
  ): Promise<{
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
    // `pick` is synchronous and hands back values it owns, so the `localId`
    // round-trip below cannot drift the point, normal or distance.
    const pick = this.pick(position, FULL_REQUEST, candidates);
    if (!pick?.item || !pick.surface) return null;

    const fragments = this.components.get(FragmentsManager);
    const { modelId, itemId } = pick.item;
    const localId = await itemIdToLocalId(fragments, modelId, itemId);

    if (localId === undefined || localId === null) return null;
    return {
      modelId,
      itemId,
      localId,
      point: pick.surface.point,
      normal: pick.normal,
      distance: pick.surface.distance,
    };
  }

  /**
   * Toggle the debug overlay. When enabled the picker mirrors the id
   * output of the whole viewport to a small canvas pinned in the
   * top-right corner so you can see what the picks see.
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
    this.mouse.dispose();
    this.removeDebugCanvas();
    this._pickMaterial.dispose();
    for (const material of this._pickMaterials.values()) material.dispose();
    this._pickMaterials.clear();
    this._pickMaterialArrays.clear();
    this._pickTarget?.dispose();
    this._pickTarget = undefined;
    this._debugTarget?.dispose();
    this._debugTarget = undefined;
    this._lastIdentityPickStats = undefined;
    this.onDisposed.trigger();
    this.onDisposed.reset();
  }

  // ---------------------------------------------------------------------------
  // Pick path
  // ---------------------------------------------------------------------------

  /**
   * Renders one pick and decodes the outputs named in `request` into values
   * the caller owns. Synchronous by design: everything that depends on the
   * picker's reused state is resolved here, so nothing an entry point does
   * afterwards can race the next pick.
   */
  private pick(
    position: THREE.Vector2 | undefined,
    request: PickRequest,
    candidates?: FastModelPickerCandidateMap,
  ): Pick | null {
    if (!this.enabled || !this._pickTarget) return null;
    if (this.debugMode) this.updateDebugCanvas();
    const ndc = position ?? this.mouse.position;
    const buffers = this._pickBuffers;
    const frame = this.renderPick(
      ndc,
      request,
      this._pickTarget,
      buffers,
      candidates,
    );
    if (!frame) return null;

    const point = request.depth ? decodePoint(buffers.depth, frame) : null;
    return {
      item: request.id ? decodeId(buffers.id, frame.indexToModel) : null,
      surface: point
        ? {
            point,
            distance: point.distanceTo(
              this._cameraPosition.setFromMatrixPosition(
                frame.camera.matrixWorld,
              ),
            ),
          }
        : null,
      normal: request.normal ? decodeNormal(buffers.normal) : null,
    };
  }

  /**
   * Renders every {@link PickOutput} for the region around `ndc` in a single
   * render, then reads the outputs named in `request` from the centre pixel of
   * `target` into `out`.
   *
   * `target` needs one attachment per output. Its size is the size of the
   * rendered region in viewport pixels: 4×4 for a pick, the whole viewport
   * centred on the origin for the debug overlay.
   *
   * The scene is left exactly as found, even if rendering throws.
   */
  private renderPick(
    ndc: THREE.Vector2,
    request: PickRequest,
    target: THREE.WebGLRenderTarget,
    out: PickBuffers,
    candidates?: FastModelPickerCandidateMap,
  ): PickFrame | null {
    if (!this.enabled || !this.world.renderer) return null;
    // `overrideMaterial` only applies to a `THREE.Scene`.
    const scene = this.world.scene.three as THREE.Scene;
    if (!scene.isScene) return null;
    const fragments = this.components.get(FragmentsManager);
    if (!fragments.initialized || fragments.list.size === 0) return null;

    const renderer = this.world.renderer.three;
    const viewport = renderer.getSize(this._viewportSize);
    if (viewport.x === 0 || viewport.y === 0) return null;

    const camera = this.snapshotCamera(ndc, viewport, target);

    const material = this._pickMaterial;
    material.clippingPlanes = this.collectLocalPlanes(this.world.renderer);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClearColor = renderer.getClearColor(this._clearColor);
    const prevClearAlpha = renderer.getClearAlpha();
    const prevBackground = scene.background;
    const prevOverrideMaterial = scene.overrideMaterial;
    const { shadowMap } = renderer;
    const prevShadowAutoUpdate = shadowMap.autoUpdate;
    const prevShadowNeedsUpdate = shadowMap.needsUpdate;

    const prevScissorTest = renderer.getScissorTest();
    const stats = {
      prepareMs: 0,
      renderMs: 0,
      readbackMs: 0,
      restoreMs: 0,
      renderCalls: 0,
      renderTriangles: 0,
      tileCount: 0,
      visibleTileCount: 0,
    };
    const prepareStarted = performance.now();
    try {
      this.collectPickables(scene, fragments, candidates);
      stats.prepareMs = performance.now() - prepareStarted;
      stats.tileCount = this._meshIndices.size;
      stats.visibleTileCount = stats.tileCount;
      if (this._indexToModel.size === 0) return null;

      // A non-null scene background makes three force-clear colour AND depth
      // on render() and paints the background colour into pixels with no
      // geometry, which then decode to a bogus hit instead of void
      // (issues #737 / #773).
      scene.background = null;
      scene.overrideMaterial = null;
      // `render()` refreshes shadow maps every call. The pick reads no
      // shadows, and must not consume a refresh the app requested.
      shadowMap.autoUpdate = false;
      shadowMap.needsUpdate = false;

      const renderStarted = performance.now();
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = false;
      // Three clears the first integer attachment only. Clear the normalized
      // depth/normal outputs too so a miss cannot reuse the previous pick.
      renderer.clear(true, true, false);
      const gl = renderer.getContext() as WebGL2RenderingContext;
      gl.clearBufferfv(gl.COLOR, PickOutput.depth, this._clearPixel);
      gl.clearBufferfv(gl.COLOR, PickOutput.normal, this._clearPixel);
      renderer.render(scene, camera);
      stats.renderMs = performance.now() - renderStarted;
      stats.renderCalls = renderer.info.render.calls;
      stats.renderTriangles = renderer.info.render.triangles;
    } finally {
      const restoreStarted = performance.now();
      this.restorePickables();
      shadowMap.autoUpdate = prevShadowAutoUpdate;
      shadowMap.needsUpdate = prevShadowNeedsUpdate;
      scene.overrideMaterial = prevOverrideMaterial;
      scene.background = prevBackground;
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      renderer.setScissorTest(prevScissorTest);
      stats.restoreMs = performance.now() - restoreStarted;
      if (request.id) this._lastIdentityPickStats = stats;
    }

    // `readRenderTargetPixels` is the one synchronous GPU sync of the pick;
    // reading the other attachments afterwards is a plain copy.
    const x = Math.floor(target.width / 2);
    const y = Math.floor(target.height / 2);
    const readbackStarted = performance.now();
    for (const name of PICK_OUTPUT_NAMES) {
      if (!request[name]) continue;
      const pixel = out[name];
      // clear the previous pick.
      pixel.fill(0);
      const attachment = PickOutput[name];
      renderer.readRenderTargetPixels(
        target,
        x,
        y,
        1,
        1,
        pixel,
        undefined,
        attachment,
      );
    }

    stats.readbackMs = performance.now() - readbackStarted;
    this._pickNdc.set(
      ((x + 0.5) / target.width) * 2 - 1,
      ((y + 0.5) / target.height) * 2 - 1,
    );
    // Optional: renderers standing in for WebGLRenderer may not carry it.
    const capabilities = renderer.capabilities as
      | { reversedDepthBuffer?: boolean }
      | undefined;
    return {
      indexToModel: this._indexToModel,
      camera,
      ndc: this._pickNdc,
      reversedDepth: capabilities?.reversedDepthBuffer === true,
    };
  }

  /**
   * Copies the world camera into the pick camera and narrows its projection
   * to a `target`-sized region of the viewport centred on `ndc`, the
   * classic pick matrix: `P' = M · P`.
   *
   * - Frustum culling then skips every mesh whose bounds miss that region,
   *   so only meshes under the cursor are drawn at all.
   * - `M` leaves the depth row alone, so depth decodes as usual.
   * - The sampled pixel center maps exactly to `ndc`: no NDC → pixel rounding,
   *   no scissor, no device pixel ratio to account for.
   * - The world camera is never modified, and custom projections work.
   */
  private snapshotCamera(
    ndc: THREE.Vector2,
    viewport: THREE.Vector2,
    target: THREE.WebGLRenderTarget,
  ) {
    const source = this.world.camera.three;
    source.updateWorldMatrix(true, false);

    const camera = this._pickCamera;
    camera.matrixWorld.copy(source.matrixWorld);
    camera.matrixWorldInverse.copy(source.matrixWorldInverse);
    camera.layers.mask = source.layers.mask;

    const sx = viewport.x / target.width;
    const sy = viewport.y / target.height;
    // prettier-ignore
    this._pickMatrix.set(
      sx, 0, 0, -ndc.x * sx + ((Math.floor(target.width / 2) + 0.5) / target.width) * 2 - 1,
      0, sy, 0, -ndc.y * sy + ((Math.floor(target.height / 2) + 0.5) / target.height) * 2 - 1,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
    camera.projectionMatrix.multiplyMatrices(
      this._pickMatrix,
      source.projectionMatrix,
    );
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    return camera;
  }

  /**
   * The planes the pick material clips by, so picks match what is on screen.
   *
   * - Global planes (`three.clippingPlanes`) are applied by three to every
   *   material on its own. Listing them here too would clip by each twice.
   * - Local planes (`isLocal`, see `Clipper.localClippingPlanes`) stay out of
   *   that list and reach only the tile materials, so the pick material has
   *   to carry them itself.
   */
  private collectLocalPlanes(renderer: BaseRenderer) {
    const planes = this._localPlanes;
    planes.length = 0;
    for (const plane of renderer.clippingPlanes) {
      if ((plane as { isLocal?: boolean }).isLocal) planes.push(plane);
    }
    return planes;
  }

  /**
   * Walks the scene once and decides what the pick render draws:
   *
   * - Shells owned by a model, i.e. meshes carrying the per-vertex `id`
   *   attribute, are drawn and tagged with their model's index. Ownership
   *   is the nearest model root above the mesh: a delta model's object is
   *   parented under its parent model's object (see the fragments
   *   EditHelper) but keeps its own index.
   * - Every other renderable is hidden:
   *   - LOD line meshes, which fragments draws in place of small or distant
   *     items, carry no `id`. Drawn, the missing attribute would read as
   *     `(0, 0, 0, 1)` and write `itemId + 1 = 1`, i.e. a false hit on item 0,
   *     while occluding the real shell behind it. Hidden, the item they stand
   *     for simply isn't pickable, though the worker raycast still reports it.
   *   - Non-BIM objects (helpers, grids, annotation lines, sprites) would
   *     write their own colors into the pick outputs.
   *
   * Invisible subtrees are skipped: three won't draw them, and it leaves
   * fragments' own tile visibility (stale LOD stages, hidden items) as is.
   */
  private collectPickables(
    scene: THREE.Scene,
    fragments: FragmentsManager,
    candidates?: FastModelPickerCandidateMap,
  ) {
    this._indexToModel.clear();
    this._modelIndices.clear();
    for (const [modelId, model] of fragments.list) {
      this._modelRoots.set(model.object, modelId);
    }

    const nodes = this._walkNodes;
    const owners = this._walkOwners;
    nodes.push(scene);
    owners.push(null);
    while (nodes.length) {
      const node = nodes.pop()!;
      const inherited = owners.pop() as string | null;
      if (!node.visible) continue;
      const owner = this._modelRoots.get(node) ?? inherited;

      if (isRenderable(node)) {
        const index =
          owner === null ? 0 : this.pickableIndex(node, owner, candidates);
        if (!index) {
          node.visible = false;
          this._hidden.push(node);
          continue;
        }
        this._meshIndices.set(node, index);
      }

      for (const child of node.children) {
        nodes.push(child);
        owners.push(owner);
      }
    }
  }

  /**
   * The index to draw `node` with, or 0 if it isn't a pickable shell of
   * `modelId`. Indices are handed out on a model's first shell, so models with
   * nothing on screen don't use one up.
   */
  private pickableIndex(
    node: THREE.Object3D,
    modelId: string,
    candidates?: FastModelPickerCandidateMap,
  ) {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes?.id) return 0;
    if (candidates) {
      const ranges = candidates.get(modelId)?.get(mesh);
      if (!ranges || !this.applyCandidateGroups(mesh, ranges)) return 0;
    }

    let index = this._modelIndices.get(modelId);
    if (index === undefined) {
      index = this._indexToModel.size + 1;
      if (index > FastModelPicker.MAX_MODELS) return 0;
      this._modelIndices.set(modelId, index);
      this._indexToModel.set(index, modelId);
    }

    this.replaceMaterial(mesh);
    return index;
  }

  /**
   * Reuse pick shaders per source material. Three caches transformed local
   * clipping planes by material id, so a single mutable override material
   * cannot preserve different per-tile planes across consecutive draws.
   */
  private replaceMaterial(mesh: THREE.Mesh) {
    const source = mesh.material;
    this._originalMaterials.set(mesh, source);
    if (Array.isArray(source)) {
      if (!this._usedMaterialArrays.has(source)) {
        let materials = this._pickMaterialArrays.get(source);
        if (!materials) {
          materials = [];
          this._pickMaterialArrays.set(source, materials);
        }
        materials.length = source.length;
        source.forEach((material, i) => {
          materials![i] = this.getPickMaterial(material);
        });
        this._usedMaterialArrays.add(source);
      }
      mesh.material = this._pickMaterialArrays.get(source)!;
    } else {
      const material = this.getPickMaterial(source);
      mesh.material = this._originalGroups.has(mesh) ? [material] : material;
    }
  }

  private getPickMaterial(source: THREE.Material) {
    let material = this._pickMaterials.get(source);
    if (!material) {
      material = this._pickMaterial.clone();
      const pickMaterial = material;
      material.onBeforeRender = (
        _renderer,
        _scene,
        _camera,
        _geometry,
        object,
      ) => {
        pickMaterial.uniforms.modelIndex.value =
          this._meshIndices.get(object) ?? 0;
        pickMaterial.uniformsNeedUpdate = true;
      };
      this._pickMaterials.set(source, material);
    }
    if (!this._usedMaterials.has(source)) {
      material.visible = source.visible;
      material.clippingPlanes = source.clippingPlanes ?? this._localPlanes;
      material.clipIntersection = source.clipIntersection;
      this._usedMaterials.add(source);
    }
    return material;
  }

  private restorePickables() {
    for (const object of this._hidden) object.visible = true;
    for (const [mesh, groups] of this._originalGroups)
      mesh.geometry.groups = groups;
    for (const [mesh, material] of this._originalMaterials)
      mesh.material = material;
    this._originalGroups.clear();
    this._originalMaterials.clear();
    // Retain only materials used by this pick, bounded by the active scene.
    for (const [source, material] of this._pickMaterials) {
      if (this._usedMaterials.has(source)) continue;
      material.dispose();
      this._pickMaterials.delete(source);
    }
    for (const source of this._pickMaterialArrays.keys()) {
      if (!this._usedMaterialArrays.has(source))
        this._pickMaterialArrays.delete(source);
    }
    this._usedMaterials.clear();
    this._usedMaterialArrays.clear();
    this._hidden.length = 0;
    this._walkNodes.length = 0;
    this._walkOwners.length = 0;
    this._meshIndices.clear();
    this._modelRoots.clear();
  }

  /**
   * Intersects candidates, at the slots the tile's index draws them, with
   * visible material groups and the active draw range.
   */
  private applyCandidateGroups(
    mesh: THREE.Mesh,
    ranges: readonly { start: number; count: number }[],
  ) {
    const geometry = mesh.geometry;
    const source = mesh.material;
    const sourceGroups = Array.isArray(source)
      ? geometry.groups.filter(
          (group) => source[group.materialIndex ?? 0]?.visible,
        )
      : [{ ...geometry.drawRange, materialIndex: 0 }].filter(
          () => source.visible,
        );
    const drawStart = geometry.drawRange.start;
    const drawEnd = drawStart + geometry.drawRange.count;
    const groups: THREE.BufferGeometry["groups"] = [];
    for (const range of ranges) {
      const count = range.count === 0xffffffff ? Infinity : range.count;
      if (
        !Number.isInteger(range.start) ||
        range.start < 0 ||
        !(count === Infinity || (Number.isInteger(count) && count > 0))
      )
        continue;
      for (const drawn of toDrawnIndexRanges(geometry, range.start, count)) {
        for (const group of sourceGroups) {
          const start = Math.max(drawn.start, group.start, drawStart);
          const end = Math.min(
            drawn.start + drawn.count,
            group.start + group.count,
            drawEnd,
          );
          if (end > start)
            groups.push({
              start,
              count: end - start,
              materialIndex: group.materialIndex,
            });
        }
      }
    }
    if (!groups.length) return false;
    this._originalGroups.set(mesh, geometry.groups);
    geometry.groups = groups;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  /**
   * The pick shader. Writes one output per {@link PickOutput} attachment:
   *
   * - `id`: full-width unsigned model index and item id. Reconstructed from
   *   the four bytes supplied by Fragments, without truncating the high byte.
   * - `depth`: `gl_FragCoord.z` packed into four bytes, inverse of
   *   {@link unpackDepthFromRGBA}:
   *     r = fract(v * 256^3)  (least significant)
   *     g = fract(v * 256^2)
   *     b = fract(v * 256)
   *     a = v                 (most significant)
   *   `r.yzw -= r.xyz / 256` shaves the residual from each higher component
   *   so the encoded value is exact, and the final `* 256/255` upscale lands
   *   `v = 1.0` at all-255 bytes rather than rolling over to 0. Packed by
   *   hand: `ShaderMaterial` doesn't reliably resolve three's `packing`
   *   chunk for custom shaders.
   * - `normal`: world-space normal as `normal * 0.5 + 0.5` in RGB, alpha 1.
   *   Flipped on backfaces so consumers get the surface they're looking at.
   *   ~1° precision per axis, plenty for surface alignment, orbiting and
   *   snapping.
   *
   * Every output is written on every draw: rasterizing one pixel, the only
   * per-output cost worth saving is the readback, which
   * {@link renderPick} skips for outputs it wasn't asked for. Per-request
   * shader variants would each cost a program compile instead.
   */
  private buildPickMaterial(): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { modelIndex: { value: 0 } },
      vertexShader: `
        attribute vec4 id;
        uniform highp uint modelIndex;
        flat varying uvec4 vIdentity;
        varying vec3 vWorldNormal;
        #if NUM_CLIPPING_PLANES > 0
          varying vec3 vClipPosition;
        #endif
        void main() {
          uvec4 bytes = uvec4(id);
          uint item = (bytes.x << 24u) | (bytes.y << 16u) | (bytes.z << 8u) | bytes.w;
          vIdentity = uvec4(modelIndex, item, 0u, 1u);
          vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
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
        flat varying uvec4 vIdentity;
        varying vec3 vWorldNormal;
        #if NUM_CLIPPING_PLANES > 0
          varying vec3 vClipPosition;
          uniform vec4 clippingPlanes[NUM_CLIPPING_PLANES];
        #endif
        layout(location = ${PickOutput.id}) out highp uvec4 outId;
        layout(location = ${PickOutput.depth}) out highp vec4 outDepth;
        layout(location = ${PickOutput.normal}) out highp vec4 outNormal;
        void main() {
          ${CLIPPING_FRAGMENT}
          outId = vIdentity;

          float v = gl_FragCoord.z;
          vec4 r = vec4(
            fract(v * 16777216.0),
            fract(v * 65536.0),
            fract(v * 256.0),
            v
          );
          r.yzw -= r.xyz * (1.0 / 256.0);
          outDepth = r * (256.0 / 255.0);

          vec3 n = normalize(vWorldNormal);
          if (!gl_FrontFacing) n = -n;
          outNormal = vec4(n * 0.5 + 0.5, 1.0);
        }
      `,
      side: THREE.DoubleSide,
      // Three binds the `clippingPlanes` uniform only when it builds the
      // program for a `ShaderMaterial` with `clipping` on, but sizes
      // NUM_CLIPPING_PLANES either way. Left on, so the shader never sees
      // planes it has no values for. With no planes the loop compiles out.
      clipping: true,
    });

    return material;
  }

  private setupDebugCanvas() {
    if (this._debugCanvas) return;
    const size = this.world.renderer!.three.getSize(new THREE.Vector2());

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
    this._debugCanvas.width = size.x;
    this._debugCanvas.height = size.y;
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

  /**
   * Renders the pick for the whole viewport into {@link _debugTarget} and
   * mirrors its id output to the debug canvas.
   */
  private updateDebugCanvas() {
    if (!this._debugCanvas || !this.world.renderer) return;
    const renderer = this.world.renderer.three;
    const size = renderer.getSize(new THREE.Vector2());
    const width = Math.floor(size.x);
    const height = Math.floor(size.y);
    if (width === 0 || height === 0) return;

    this._debugTarget ??= createPickTarget(width, height);
    const target = this._debugTarget;
    target.setSize(width, height);
    if (!this.renderPick(ORIGIN, NO_REQUEST, target, this._pickBuffers)) return;

    const pixels = new Uint32Array(width * height * 4);
    renderer.readRenderTargetPixels(
      target,
      0,
      0,
      width,
      height,
      pixels,
      undefined,
      PickOutput.id,
    );

    const canvas = this._debugCanvas;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const imageData = ctx.createImageData(width, height);
    // Flip Y axis: WebGL has Y=0 at bottom, canvas 2D has Y=0 at top.
    const rowSize = width * 4;
    for (let y = 0; y < height; y++) {
      const srcOffset = y * rowSize;
      const dstOffset = (height - 1 - y) * rowSize;
      for (let x = 0; x < width; x++) {
        const src = srcOffset + x * 4;
        const dst = dstOffset + x * 4;
        const modelIndex = pixels[src];
        const itemId = pixels[src + 1];
        imageData.data[dst] = modelIndex % 256;
        imageData.data[dst + 1] = Math.floor(itemId / 65536) % 256;
        imageData.data[dst + 2] = itemId % 256;
        imageData.data[dst + 3] = modelIndex === 0 ? 0 : 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }
}
