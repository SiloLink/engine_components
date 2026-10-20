import * as OBC from "@thatopen/components";
import { DataSet, type FragmentsModel } from "@thatopen/fragments";
import * as THREE from "three";
import { PostproductionRenderer } from "../../core";
import { Highlighter } from "../Highlighter";

class OutlinerUpdateError extends Error {
  readonly errors: unknown[];

  constructor(errors: unknown[]) {
    super("Unable to update Fragments outlines.");
    this.name = "OutlinerUpdateError";
    this.errors = errors;
  }
}

const DEFAULT_GROUP = "default";

/**
 * Per-group visual configuration for the outliner.
 */
export interface OutlineGroupConfig {
  color?: THREE.Color;
  fillColor?: THREE.Color;
  fillOpacity?: number;
  thickness?: number;
  /**
   * Higher priority groups win at coplanar pixels (z-fighting resolution
   * between groups). Default is 0. Use integer steps; a difference of 1 is
   * enough to resolve typical coplanar cases.
   */
  priority?: number;
}

export interface OutlinerPickCandidateRange {
  readonly start: number;
  readonly count: number;
}

/**
 * Synchronous, defensive draw ranges suitable for a filtered fast-pick pass.
 * Structurally compatible with `FastModelPickerCandidateMap` in newer core
 * versions while keeping components-front buildable against its pinned core.
 */
export type OutlinerPickCandidateMap = ReadonlyMap<
  string,
  ReadonlyMap<THREE.Mesh, readonly OutlinerPickCandidateRange[]>
>;

interface OutlineGroupState {
  map: OBC.ModelIdMap;
  config: OutlineGroupConfig;
  /**
   * Tile meshes currently attached as outline proxies for this group,
   * grouped by model id. Used to diff against subsequent chunk queries
   * so we can detach tiles that no longer belong to the group.
   */
  attached: Map<string, Set<THREE.Mesh>>;
  /** Last successfully resolved chunks, keyed by model and current tile. */
  resolved: Map<string, Map<THREE.Mesh, readonly OutlinerPickCandidateRange[]>>;
  /** Models awaiting a refresh; a full selection update takes precedence. */
  dirtyModels: Set<string>;
  refreshAll: boolean;
  update?: Promise<void>;
  background: boolean;
  activeStyles: Set<string>;
  styleCallbacks: {
    [style: string]: {
      onHighlight: () => void;
      onClear: (map: OBC.ModelIdMap) => void;
    };
  };
}

/**
 * This component allows adding colored outlines with thickness to fragments in
 * a 3D scene. Supports multiple named outline groups so different selections
 * can be outlined with different colors / thicknesses at the same time. 📕
 * [Tutorial](https://docs.thatopen.com/Tutorials/Components/Front/Outliner). 📘
 * [API](https://docs.thatopen.com/api/@thatopen/components-front/classes/Outliner).
 */
export class Outliner extends OBC.Component implements OBC.Disposable {
  private _world?: OBC.World;
  // Keep the pass we actually populated. A renderer can replace its
  // postproduction instance before the Outliner receives a new world.
  private _outlinePass:
    | PostproductionRenderer["postproduction"]["outlinePass"]
    | null = null;

  /**
   * The world where the outliner operates.
   */
  set world(value: OBC.World | undefined) {
    const nextPass = value
      ? this.getRenderer(value).postproduction.outlinePass
      : null;
    if (value === this._world && nextPass === this._outlinePass) return;

    const previousPass = this._outlinePass;
    if (previousPass) {
      for (const [name, state] of this._groups) {
        const passGroup = previousPass.getGroup(name);
        if (passGroup) {
          state.config = {
            ...state.config,
            color: passGroup.outlineColor.clone(),
            fillColor: passGroup.fillColor.clone(),
            fillOpacity: passGroup.fillOpacity,
            thickness: passGroup.thickness,
            priority: passGroup.priority,
          };
        }

        this.invalidateGroup(name);
        this.detachAllFromPass(state, name, previousPass);
        if (name !== DEFAULT_GROUP) previousPass.removeGroup(name);
      }

      if (this._mesh && this._pointsExclusionPass) {
        this._pointsExclusionPass.removeExcludedMaterial(this._mesh.material);
      }
      this._pointsExclusionPass = null;
      this._mesh?.removeFromParent();
    }

    this._world = value;
    this._outlinePass = nextPass;
    if (!value) return;
    const points = this.ensurePoints();
    if (this.outlinePositions && this.enabled) {
      value.scene.three.add(points);
    }

    const pass = nextPass!;
    for (const [name, state] of this._groups) {
      pass.addGroup(name, this.toPassConfig(state.config));
      const hasItems = Object.values(state.map).some(
        (localIds) => localIds.size > 0,
      );
      if (!hasItems) continue;
      this.updateGroup(name, undefined, true);
    }
  }

  get world() {
    return this._world;
  }

  /**
   * A set of Highlighter styles linked with the default outline group.
   * @remarks Use this or addItems directly but avoid using both at the same
   * time to prevent unwanted results. For per-group routing, wire the
   * Highlighter events manually with a group name:
   * `highlighter.events.select.onHighlight.add(m => outliner.addItems(m, "my-group"))`
   */
  styles = new DataSet<string>();

  // display a point for very far elements
  outlinePositions = false;

  private _mesh: THREE.Points<
    THREE.BufferGeometry,
    THREE.PointsMaterial
  > | null = null;
  private _pointsExclusionPass:
    | PostproductionRenderer["postproduction"]["excludedObjectsPass"]
    | null = null;

  private get _points() {
    return this.ensurePoints();
  }

  private ensurePoints() {
    if (!this._mesh) {
      this._mesh = new THREE.Points(
        new THREE.BufferGeometry(),
        new THREE.PointsMaterial({
          size: 10,
          sizeAttenuation: false,
          depthTest: false,
        }),
      );
    }
    if (this.world) {
      const pass = this.getRenderer().postproduction.excludedObjectsPass;
      if (pass !== this._pointsExclusionPass) {
        this._pointsExclusionPass?.removeExcludedMaterial(this._mesh.material);
        pass.addExcludedMaterial(this._mesh.material);
        this._pointsExclusionPass = pass;
      }
    }
    return this._mesh;
  }

  /** {@link OBC.Component.enabled} */
  get enabled() {
    if (!this.world || this.world.isDisposing) {
      return false;
    }

    const renderer = this.getRenderer();
    return renderer.postproduction.outlinesEnabled;
  }

  /** {@link OBC.Component.enabled} */
  set enabled(value: boolean) {
    if (!this.world || this.world.isDisposing) {
      return;
    }

    const renderer = this.getRenderer();
    renderer.postproduction.outlinesEnabled = value;

    if (this.outlinePositions) {
      this._points.material.color = this.color;
      this.world.scene.three.add(this._points);
    }
  }

  /** Outline color for the default group. */
  get color() {
    return this.getRenderer().postproduction.outlinePass.outlineColor;
  }

  set color(value: THREE.Color) {
    const pass = this.getRenderer().postproduction.outlinePass;
    pass.outlineColor = value;
    this.updateDefaultConfig({ color: value });
    this._points.material.color.copy(value);
  }

  /** Thickness for the default group. */
  get thickness() {
    return this.getRenderer().postproduction.outlinePass.thickness;
  }

  set thickness(value: number) {
    this.getRenderer().postproduction.outlinePass.thickness = value;
    this.updateDefaultConfig({ thickness: value });
  }

  /** Fill color for the default group. */
  get fillColor() {
    return this.getRenderer().postproduction.outlinePass.fillColor;
  }

  set fillColor(value: THREE.Color) {
    this.getRenderer().postproduction.outlinePass.fillColor = value;
    this.updateDefaultConfig({ fillColor: value });
  }

  /** Fill opacity for the default group. */
  get fillOpacity() {
    return this.getRenderer().postproduction.outlinePass.fillOpacity;
  }

  set fillOpacity(value: number) {
    this.getRenderer().postproduction.outlinePass.fillOpacity = value;
    this.updateDefaultConfig({ fillOpacity: value });
  }

  readonly onDisposed = new OBC.Event();

  /**
   * A unique identifier for the component.

   * This UUID is used to register the component within the Components system.
   */
  static readonly uuid = "2fd3bcc5-b3b6-4ded-9f64-f47a02854a10" as const;

  private _groups = new Map<string, OutlineGroupState>();
  /**
   * Per-model unsubscribe handles for the tile lifecycle listeners
   * registered in {@link bindModelTileEvents}. Run on dispose so we
   * don't leak references after the Outliner goes away.
   */
  private _tileListeners = new Map<
    string,
    { model: FragmentsModel; unbind: () => void }
  >();
  private _pendingUpdates = new Set<Promise<unknown>>();
  private _backgroundErrors: unknown[] = [];
  private _updateRevisions = new Map<string, number>();
  private _modelEventsUnbind: (() => void) | null = null;
  private _highlighterStylesUnbind: (() => void) | null = null;

  constructor(components: OBC.Components) {
    super(components);
    components.add(Outliner.uuid, this);
    this.ensureGroup(DEFAULT_GROUP);
    this.setupEvents();
  }

  // ---------------------------------------------------------------------------
  // Group API
  // ---------------------------------------------------------------------------

  /**
   * Creates (or reconfigures) a named outline group. Each group renders with
   * its own outline color, fill and thickness independently of the others.
   *
   * @param name - Unique group name. "default" is reserved for the legacy
   * singular API and cannot be removed.
   * @param config - Optional visual configuration.
   */
  create(name: string, config: OutlineGroupConfig = {}) {
    const state = this.ensureGroup(name);
    state.config = this.mergeGroupConfig(state.config, config);
    if (this.world) {
      this.getRenderer().postproduction.outlinePass.addGroup(
        name,
        this.toPassConfig(state.config),
      );
    }
  }

  /**
   * Updates an existing group's visual configuration.
   */
  configure(name: string, config: OutlineGroupConfig) {
    const state = this._groups.get(name);
    if (!state) return;
    state.config = this.mergeGroupConfig(state.config, config);
    if (!this.world) return;
    this.getRenderer().postproduction.outlinePass.configureGroup(
      name,
      this.toPassConfig(state.config),
    );
  }

  /**
   * Removes a group together with all items routed to it.
   */
  remove(name: string) {
    if (name === DEFAULT_GROUP) return;
    const group = this._groups.get(name);
    if (!group) return;

    const highlighter = this.components.get(Highlighter);
    for (const style of Object.keys(group.styleCallbacks)) {
      const { onHighlight, onClear } = group.styleCallbacks[style];
      const events = highlighter.events[style];
      if (events) {
        events.onHighlight.remove(onHighlight);
        events.onClear.remove(onClear);
      }
    }

    this.invalidateGroup(name);
    this.detachAll(group, name);
    this._groups.delete(name);

    if (this.world) {
      this.getRenderer().postproduction.outlinePass.removeGroup(name);
    }
  }

  /** Returns the names of all currently created groups. */
  list() {
    return [...this._groups.keys()];
  }

  /**
   * Returns the already-resolved tile ranges for the requested groups without
   * a worker call. The returned maps, arrays and range objects are defensive
   * copies; overlapping or adjacent ranges are coalesced per tile.
   */
  getPickCandidates(groupNames: Iterable<string>): OutlinerPickCandidateMap {
    const collected = new Map<
      string,
      Map<THREE.Mesh, OutlinerPickCandidateRange[]>
    >();

    for (const name of new Set(groupNames)) {
      const state = this._groups.get(name);
      if (!state) continue;
      for (const [modelId, tiles] of state.resolved) {
        let modelCandidates = collected.get(modelId);
        if (!modelCandidates) {
          modelCandidates = new Map();
          collected.set(modelId, modelCandidates);
        }
        for (const [tile, ranges] of tiles) {
          let tileRanges = modelCandidates.get(tile);
          if (!tileRanges) {
            tileRanges = [];
            modelCandidates.set(tile, tileRanges);
          }
          for (const range of ranges)
            tileRanges.push({ start: range.start, count: range.count });
        }
      }
    }

    const result = new Map<
      string,
      ReadonlyMap<THREE.Mesh, readonly OutlinerPickCandidateRange[]>
    >();
    for (const [modelId, tiles] of collected) {
      const modelCandidates = new Map<
        THREE.Mesh,
        readonly OutlinerPickCandidateRange[]
      >();
      for (const [tile, ranges] of tiles) {
        const coalesced = this.coalesceRanges(ranges);
        if (coalesced.length > 0) modelCandidates.set(tile, coalesced);
      }
      if (modelCandidates.size > 0) result.set(modelId, modelCandidates);
    }
    return result;
  }

  /**
   * Wires a Highlighter style to a specific outline group. Equivalent to
   * `outliner.styles.add(style)` but routes the items to the given group
   * instead of the default.
   */
  bindStyle(style: string, group = DEFAULT_GROUP) {
    const highlighter = this.components.get(Highlighter);
    if (!highlighter.styles.has(style)) return false;
    this.ensureGroup(group);
    this.wireStyle(style, group);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Items API
  // ---------------------------------------------------------------------------

  /**
   * Adds items to be outlined in a specific group (defaults to "default").
   */
  async addItems(modelIdMap: OBC.ModelIdMap, group = DEFAULT_GROUP) {
    const state = this.ensureGroup(group);
    OBC.ModelIdMapUtils.add(state.map, modelIdMap);
    state.resolved = new Map();
    await this.updateGroup(group);
  }

  /**
   * Removes items from a specific group (defaults to "default").
   */
  async removeItems(modelIdMap: OBC.ModelIdMap, group = DEFAULT_GROUP) {
    const state = this._groups.get(group);
    if (!state) return;
    OBC.ModelIdMapUtils.remove(state.map, modelIdMap);
    state.resolved = new Map();
    await this.updateGroup(group);
  }

  /**
   * Adds `modelIdMap` to the group's selection (the default group if omitted)
   * and refreshes that group's outline. Identical to {@link addItems}; calling
   * it with no map just refreshes the group without changing what it holds.
   *
   * Note this changed: `modelIdMap` used to be accepted and ignored, so the
   * call was always a plain refresh and the group's selection only ever came
   * from {@link addItems}. It now joins the group's map, which is what the
   * argument always claimed to do. Pass nothing for the old behaviour.
   *
   * @deprecated call {@link addItems} instead.
   */
  async update(modelIdMap?: OBC.ModelIdMap, group?: string) {
    await this.addItems(modelIdMap ?? {}, group);
  }

  /** Waits for automatic tile and model lifecycle outline updates to settle. */
  async whenSettled() {
    while (this._pendingUpdates.size > 0) {
      await Promise.allSettled([...this._pendingUpdates]);
    }
    if (this._backgroundErrors.length > 0) {
      const errors = this._backgroundErrors.splice(0);
      throw new OutlinerUpdateError(errors);
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Cleans up outlines. Without arguments, clears every group. With a group
   * name, clears that group only.
   */
  clean(group?: string) {
    if (group !== undefined) {
      const state = this._groups.get(group);
      if (!state) return;
      this.invalidateGroup(group);
      state.map = {};
      state.resolved = new Map();
      state.activeStyles.clear();
      this.detachAll(state, group);
      if (group === DEFAULT_GROUP) this.cleanPoints();
      return;
    }

    for (const [name, state] of this._groups) {
      this.invalidateGroup(name);
      state.map = {};
      state.resolved = new Map();
      state.activeStyles.clear();
      this.detachAll(state, name);
    }
    this.cleanPoints();
  }

  /** {@link Disposable.dispose} */
  dispose() {
    this.styles.clear();
    if (this._modelEventsUnbind) {
      this._modelEventsUnbind();
      this._modelEventsUnbind = null;
    }
    for (const [, listener] of this._tileListeners) listener.unbind();
    this._tileListeners.clear();
    if (this._highlighterStylesUnbind) {
      this._highlighterStylesUnbind();
      this._highlighterStylesUnbind = null;
    }
    for (const name of [...this._groups.keys()]) {
      if (name === DEFAULT_GROUP) continue;
      this.remove(name);
    }
    this.clean();
    this.world = undefined;
    this.onDisposed.trigger(Outliner.uuid);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private toPassConfig(config: OutlineGroupConfig) {
    return {
      outlineColor: config.color,
      fillColor: config.fillColor,
      fillOpacity: config.fillOpacity,
      thickness: config.thickness,
      priority: config.priority,
    };
  }

  private mergeGroupConfig(
    current: OutlineGroupConfig,
    update: OutlineGroupConfig,
  ): OutlineGroupConfig {
    return {
      color: update.color?.clone() ?? current.color?.clone(),
      fillColor: update.fillColor?.clone() ?? current.fillColor?.clone(),
      fillOpacity: update.fillOpacity ?? current.fillOpacity,
      thickness: update.thickness ?? current.thickness,
      priority: update.priority ?? current.priority,
    };
  }

  private updateDefaultConfig(config: OutlineGroupConfig) {
    const state = this.ensureGroup(DEFAULT_GROUP);
    state.config = this.mergeGroupConfig(state.config, config);
  }

  private ensureGroup(name: string): OutlineGroupState {
    let state = this._groups.get(name);
    if (state) return state;
    state = {
      map: {},
      config: {},
      attached: new Map(),
      resolved: new Map(),
      dirtyModels: new Set(),
      refreshAll: false,
      background: false,
      activeStyles: new Set(),
      styleCallbacks: {},
    };
    this._groups.set(name, state);
    return state;
  }

  private setupEvents() {
    const highlighter = this.components.get(Highlighter);

    // Only add the style if it exists in the highlighter
    this.styles.guard = (style) => {
      return highlighter.styles.has(style);
    };

    this.styles.onItemAdded.add((style) => {
      this.wireStyle(style, DEFAULT_GROUP);
    });

    this.styles.onBeforeDelete.add((style) => {
      this.unwireStyle(style, DEFAULT_GROUP);
    });

    const onHighlighterStyleDeleted = (style: string) => {
      this.styles.delete(style);
      // Also tear down any named-group wirings for this style.
      for (const [name] of this._groups) this.unwireStyle(style, name);
    };
    highlighter.styles.onItemDeleted.add(onHighlighterStyleDeleted);
    this._highlighterStylesUnbind = () => {
      highlighter.styles.onItemDeleted.remove(onHighlighterStyleDeleted);
    };
  }

  private wireStyle(style: string, groupName: string) {
    const highlighter = this.components.get(Highlighter);
    const events = highlighter.events[style];
    if (!events) return;

    const state = this.ensureGroup(groupName);
    if (state.styleCallbacks[style]) return; // already wired

    const onHighlight = () => {
      state.activeStyles.add(style);
      this.updateFromStyles(groupName);
    };
    const onClear = () => {
      state.activeStyles.delete(style);
      this.updateFromStyles(groupName);
    };
    state.styleCallbacks[style] = { onHighlight, onClear };
    events.onHighlight.add(onHighlight);
    events.onClear.add(onClear);
  }

  private unwireStyle(style: string, groupName: string) {
    const state = this._groups.get(groupName);
    if (!state) return;
    const callbacks = state.styleCallbacks[style];
    if (!callbacks) return;
    const highlighter = this.components.get(Highlighter);
    const events = highlighter.events[style];
    if (events) {
      events.onHighlight.remove(callbacks.onHighlight);
      events.onClear.remove(callbacks.onClear);
    }
    state.activeStyles.delete(style);
    delete state.styleCallbacks[style];
  }

  private async updateFromStyles(groupName: string) {
    const highlighter = this.components.get(Highlighter);
    const state = this._groups.get(groupName);
    if (!state) return;
    const maps: OBC.ModelIdMap[] = [];
    for (const style of state.activeStyles) {
      const map = highlighter.selection[style];
      if (!map) continue;
      maps.push(map);
    }
    state.map = OBC.ModelIdMapUtils.join(maps);
    state.resolved = new Map();
    await this.updateGroup(groupName);
  }

  /**
   * Resolves the group's current selection into per-tile index chunks
   * via {@link FragmentsModel.getItemDrawChunks}, then asks the pass to
   * attach a proxy per affected tile. Tiles that previously had a proxy
   * but no longer match the selection are detached.
   *
   * Cost is bounded by the number of affected tiles (not selected items)
   * and by one worker round-trip per model in the selection. Adding
   * thousands of items costs the same as adding one if they all live in
   * the same tile, and a few thousand items spread across the model
   * still hits at most a few hundred tiles.
   *
   * Outline color, fill, and thickness come from the pass's group config.
   * The Outliner only feeds it the geometry slices.
   */
  private updateGroup(name: string, modelId?: string, background = false) {
    const state = this.ensureGroup(name);
    this._updateRevisions.set(name, (this._updateRevisions.get(name) ?? 0) + 1);
    if (modelId === undefined) state.refreshAll = true;
    else state.dirtyModels.add(modelId);
    state.background ||= background;
    if (state.update) return state.update;

    // One microtask combines synchronous tile batches. Requests made while a
    // query runs share its promise and queue a subsequent refresh instead of
    // starting another worker query for the same group.
    const update = Promise.resolve().then(async () => {
      try {
        while (state.refreshAll || state.dirtyModels.size > 0) {
          const modelIds = state.refreshAll ? undefined : state.dirtyModels;
          state.refreshAll = false;
          state.dirtyModels = new Set();
          const revision = this._updateRevisions.get(name)!;
          try {
            await this.performGroupUpdate(name, state, revision, modelIds);
          } catch (error) {
            // Only the latest requested result can commit. A failed query
            // superseded by a refresh or cleanup no longer owns the result.
            if (this._updateRevisions.get(name) === revision) throw error;
          }
          if (this._groups.get(name) !== state) break;
          if (state.refreshAll || state.dirtyModels.size > 0) {
            // The superseded result did not commit: carry its models into
            // the next query as well as models dirtied while it was running.
            if (!modelIds) state.refreshAll = true;
            else for (const id of modelIds) state.dirtyModels.add(id);
          }
        }
      } catch (error) {
        if (state.background) this._backgroundErrors.push(error);
        throw error;
      } finally {
        state.update = undefined;
        state.background = false;
      }
    });
    state.update = this.trackUpdate(update);
    // Automatic lifecycle callers have no promise consumer. The same promise
    // still rejects for explicit callers; whenSettled reports background errors.
    state.update.catch(() => undefined);
    return state.update;
  }

  private async performGroupUpdate(
    name: string,
    state: OutlineGroupState,
    revision: number,
    modelIds?: Set<string>,
  ) {
    const world = this.world;
    if (!world) return;
    const renderer = this.getRenderer(world);
    const pass = renderer.postproduction.outlinePass;

    // Make sure the pass knows about this group (palette + material +
    // container). The Outliner's ensureGroup only tracks selection state.
    if (!pass.hasGroup(name)) {
      pass.addGroup(name, this.toPassConfig(state.config));
    }

    const map = OBC.ModelIdMapUtils.clone(state.map);
    const fragments = this.components.get(OBC.FragmentsManager);
    // Points and chunks commit together under the same revision guard.
    const points =
      name === DEFAULT_GROUP && this.outlinePositions
        ? fragments.getPositions(map)
        : undefined;

    const nextAttached = new Map(modelIds ? state.attached : undefined);
    const nextResolved = new Map<
      string,
      Map<THREE.Mesh, readonly OutlinerPickCandidateRange[]>
    >(modelIds ? state.resolved : undefined);
    if (modelIds) {
      for (const modelId of modelIds) {
        nextAttached.delete(modelId);
        nextResolved.delete(modelId);
      }
    }

    // Run the chunk query per model in parallel. Each query returns one
    // entry per affected tile with parallel `position` / `size` arrays.
    const queries: Array<
      Promise<{
        modelId: string;
        model: FragmentsModel;
        chunks: Array<{
          tileId: number;
          position: Uint32Array;
          size: Uint32Array;
        }>;
      }>
    > = [];
    for (const [modelId, localIds] of Object.entries(map)) {
      if (modelIds && !modelIds.has(modelId)) continue;
      if (localIds.size === 0) continue;
      this.bindModelTileEvents(modelId);
      const model = fragments.list.get(modelId);
      if (!model) continue;
      queries.push(
        (async () => {
          // `getItemDrawChunks` accepts an iterable; we pass the Set
          // straight through to avoid materializing an array for very
          // large selections.
          const chunks = await model.getItemDrawChunks(localIds);
          return { modelId, model, chunks };
        })(),
      );
    }

    // Wait for every query even on failure before starting the next refresh.
    const [settled, [positions]] = await Promise.all([
      Promise.allSettled(queries),
      Promise.allSettled([points]),
    ]);
    if (!this.isGroupUpdateCurrent(name, state, revision, world, pass)) return;
    const results = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });

    if (positions.status === "rejected") throw positions.reason;
    if (positions.value) this.updatePoints(positions.value);

    // Attach (or refresh) every tile that came back; track attachments
    // for next-time diffs.
    for (const { modelId, model: queriedModel, chunks } of results) {
      const currentModel = fragments.list.get(modelId);
      if (currentModel !== queriedModel) continue;
      const attached = new Set<THREE.Mesh>();
      const resolved = new Map<
        THREE.Mesh,
        readonly OutlinerPickCandidateRange[]
      >();
      for (const entry of chunks) {
        const tile = currentModel.tiles.get(entry.tileId);
        if (!tile) continue;
        pass.attachOutlinedTile(
          tile,
          { position: entry.position, size: entry.size },
          name,
        );
        attached.add(tile);
        resolved.set(tile, this.copyChunkRanges(entry.position, entry.size));
      }
      nextAttached.set(modelId, attached);
      if (resolved.size > 0) nextResolved.set(modelId, resolved);
    }

    // No awaits follow the revision check: diff against the proxies drawn now.
    for (const [modelId, prev] of state.attached) {
      const next = nextAttached.get(modelId) ?? new Set<THREE.Mesh>();
      for (const tile of prev) {
        if (!next.has(tile)) pass.detachOutlinedTile(tile, name);
      }
    }

    state.attached = nextAttached;
    state.resolved = nextResolved;
  }

  private isGroupUpdateCurrent(
    name: string,
    state: OutlineGroupState,
    revision: number,
    world: OBC.World,
    pass: PostproductionRenderer["postproduction"]["outlinePass"],
  ) {
    return (
      this._groups.get(name) === state &&
      this._updateRevisions.get(name) === revision &&
      this.world === world &&
      this._outlinePass === pass &&
      !world.isDisposing &&
      this.getRenderer(world).postproduction.outlinePass === pass
    );
  }

  private invalidateGroup(name: string) {
    this._updateRevisions.set(name, (this._updateRevisions.get(name) ?? 0) + 1);
    const state = this._groups.get(name);
    if (state) {
      state.refreshAll = false;
      state.dirtyModels.clear();
      state.background = false;
    }
  }

  private trackUpdate<T>(update: Promise<T>): Promise<T> {
    this._pendingUpdates.add(update);
    const remove = () => this._pendingUpdates.delete(update);
    return update.then(
      (value) => {
        remove();
        return value;
      },
      (error) => {
        remove();
        throw error;
      },
    );
  }

  /**
   * Detach every proxy this group has attached and clear the tracking
   * map. Used by `clean` and `remove`.
   */
  private detachAll(state: OutlineGroupState, group = DEFAULT_GROUP) {
    if (!this.world) {
      state.attached = new Map();
      state.resolved = new Map();
      return;
    }
    const pass = this._outlinePass;
    if (!pass) {
      state.attached = new Map();
      state.resolved = new Map();
      return;
    }
    this.detachAllFromPass(state, group, pass);
  }

  private detachAllFromPass(
    state: OutlineGroupState,
    group: string,
    pass: PostproductionRenderer["postproduction"]["outlinePass"],
  ) {
    for (const [, tiles] of state.attached) {
      for (const tile of tiles) pass.detachOutlinedTile(tile, group);
    }
    state.attached = new Map();
    state.resolved = new Map();
  }

  /**
   * Subscribe to a model's tile lifecycle events so we can refresh
   * outline proxies when tiles load (LOD swap, viewport change, etc.)
   * or unload. Idempotent per model id.
   */
  private bindModelTileEvents(modelId: string) {
    this.ensureModelEvents();
    const fragments = this.components.get(OBC.FragmentsManager);
    const model = fragments.list.get(modelId);
    const existing = this._tileListeners.get(modelId);
    if (existing && existing.model === model) return;
    if (existing) {
      existing.unbind();
      this._tileListeners.delete(modelId);
    }
    if (!model) return;
    const refresh = () => {
      this.refreshModel(modelId);
    };
    const refreshAttached = () => {
      this.refreshAttachedModel(modelId);
    };
    model.tiles.onItemSet.add(refresh);
    model.tiles.onItemUpdated.add(refresh);
    model.tiles.onItemDeleted.add(refresh);
    model.tiles.onCleared.add(refresh);
    model.onViewUpdated.add(refreshAttached);
    this._tileListeners.set(modelId, {
      model,
      unbind: () => {
        model.tiles.onItemSet.remove(refresh);
        model.tiles.onItemUpdated.remove(refresh);
        model.tiles.onItemDeleted.remove(refresh);
        model.tiles.onCleared.remove(refresh);
        model.onViewUpdated.remove(refreshAttached);
      },
    });
  }

  private ensureModelEvents() {
    if (this._modelEventsUnbind) return;
    const models = this.components.get(OBC.FragmentsManager).list;
    const onSet = ({ key }: { key: string }) => this.refreshModel(key);
    const onDeleted = (key: string) => this.refreshModel(key);
    const onCleared = () => {
      for (const modelId of [...this._tileListeners.keys()]) {
        this.refreshModel(modelId);
      }
    };
    models.onItemSet.add(onSet);
    models.onItemUpdated.add(onSet);
    models.onItemDeleted.add(onDeleted);
    models.onCleared.add(onCleared);
    this._modelEventsUnbind = () => {
      models.onItemSet.remove(onSet);
      models.onItemUpdated.remove(onSet);
      models.onItemDeleted.remove(onDeleted);
      models.onCleared.remove(onCleared);
    };
  }

  private refreshModel(modelId: string) {
    this.bindModelTileEvents(modelId);
    // Fragments releases retired tile buffers synchronously. Detach their mask
    // proxies and pick ranges before any asynchronous replacement chunk query:
    // uploaded attributes may no longer retain CPU arrays for another render.
    const model = this.components.get(OBC.FragmentsManager).list.get(modelId);
    const liveTiles = new Set(model?.tiles.values());
    for (const [groupName, state] of this._groups) {
      const attached = state.attached.get(modelId);
      const resolved = state.resolved.get(modelId);
      if (!attached) continue;
      for (const tile of attached) {
        if (liveTiles.has(tile)) continue;
        this._outlinePass?.detachOutlinedTile(tile, groupName);
        attached.delete(tile);
        resolved?.delete(tile);
      }
      if (attached.size === 0) state.attached.delete(modelId);
      if (resolved?.size === 0) state.resolved.delete(modelId);
    }
    for (const [groupName, state] of this._groups) {
      const localIds = state.map[modelId];
      if (localIds && localIds.size > 0) {
        this.updateGroup(groupName, modelId, true);
      }
    }
  }

  /**
   * UPDATE requests mutate a loaded tile's material array and geometry groups
   * in place, without firing DataMap set/delete events. Refresh the existing
   * proxies synchronously at the model's view-finished boundary, reusing the
   * committed worker chunks.
   */
  private refreshAttachedModel(modelId: string) {
    const pass = this._outlinePass;
    if (!pass) return;
    for (const [groupName, state] of this._groups) {
      const tiles = state.attached.get(modelId);
      if (!tiles) continue;
      for (const tile of tiles) pass.refreshOutlinedTile(tile, groupName);
    }
  }

  private copyChunkRanges(
    positions: ArrayLike<number>,
    sizes: ArrayLike<number>,
  ): readonly OutlinerPickCandidateRange[] {
    const ranges: OutlinerPickCandidateRange[] = [];
    const count = Math.min(positions.length, sizes.length);
    for (let i = 0; i < count; i++) {
      const size = sizes[i];
      ranges.push({
        start: positions[i],
        count: size === 0xffffffff ? Infinity : size,
      });
    }
    return ranges;
  }

  private coalesceRanges(
    input: readonly OutlinerPickCandidateRange[],
  ): readonly OutlinerPickCandidateRange[] {
    const ranges = input
      .filter(
        ({ start, count }) => Number.isFinite(start) && start >= 0 && count > 0,
      )
      .map(({ start, count }) => ({ start, count }))
      .sort((a, b) => a.start - b.start);
    if (ranges.length === 0) return [];

    const result: OutlinerPickCandidateRange[] = [];
    let start = ranges[0].start;
    let end = this.rangeEnd(ranges[0]);
    for (let i = 1; i < ranges.length; i++) {
      const range = ranges[i];
      const nextEnd = this.rangeEnd(range);
      if (range.start <= end) {
        end = Math.max(end, nextEnd);
        continue;
      }
      result.push({ start, count: end === Infinity ? Infinity : end - start });
      start = range.start;
      end = nextEnd;
    }
    result.push({ start, count: end === Infinity ? Infinity : end - start });
    return result;
  }

  private rangeEnd(range: OutlinerPickCandidateRange) {
    return range.count === Infinity ? Infinity : range.start + range.count;
  }

  private cleanPoints() {
    if (this._mesh) {
      this._pointsExclusionPass?.removeExcludedMaterial(this._mesh.material);
      this._pointsExclusionPass = null;
      const disposer = this.components.get(OBC.Disposer);
      disposer.destroy(this._mesh, true, true);
    }
    this._mesh = null;
  }

  private updatePoints(positions: THREE.Vector3[]) {
    this._points.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        new Float32Array(positions.length * 3),
        3,
      ),
    );

    for (let i = 0; i < positions.length; i++) {
      const { x, y, z } = positions[i];
      this._points.geometry.attributes.position.array[i * 3] = x;
      this._points.geometry.attributes.position.array[i * 3 + 1] = y;
      this._points.geometry.attributes.position.array[i * 3 + 2] = z;
    }

    this._points.geometry.attributes.position.needsUpdate = true;
  }

  private getRenderer(world = this.world) {
    if (!world) {
      throw new Error("You must set a world to use the outliner!");
    }

    const renderer = world.renderer as PostproductionRenderer;
    if (!renderer.postproduction) {
      throw new Error(
        "The world given to the outliner must use the postproduction renderer.",
      );
    }

    return renderer;
  }
}
