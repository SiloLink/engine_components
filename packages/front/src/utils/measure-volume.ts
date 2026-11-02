import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { Volume } from "./volume";
import { MeasureMark } from "./measure-mark";
import {
  getTileIndexLayout,
  IndexRange,
  toDrawnIndexRanges,
} from "./tile-index-layout";

/**
 * The chunks a proxy draws, in its tile's full index, and the tile index
 * packing its groups follow.
 */
interface ProxyChunks {
  ranges: IndexRange[];
  layout: ReturnType<typeof getTileIndexLayout>;
}

/**
 * Visual representation of a {@link Volume} measurement.
 *
 * Items added to the volume are highlighted by **proxy meshes** that
 * alias each source tile's `BufferGeometry` attributes and `index`,
 * with `geometry.groups` set to the per-item draw ranges returned by
 * `FragmentsModel.getItemDrawChunks`, at the slots the tile's current
 * index draws them. No vertex / normal / index data
 * is duplicated — a proxy carries no GPU memory of its own beyond a
 * small `BufferGeometry` wrapper. On a 250k-item model this means the
 * cost of visualising a measurement is proportional to the number of
 * items the user has clicked, not the total geometry of the model.
 *
 * (Previous implementation materialised one full `THREE.Mesh` per
 * picked item by deep-copying the tile geometry through `Mesher`,
 * which dominated memory once a measurement contained more than a
 * handful of items.)
 */
export class MeasureVolume {
  private _components: OBC.Components;

  private _material: THREE.MeshLambertMaterial = new THREE.MeshLambertMaterial({
    color: "red",
    transparent: true,
    opacity: 0.75,
    side: THREE.DoubleSide,
    depthTest: false,
  });

  /**
   * Wrapped in a one-element array because three only honours
   * `geometry.groups` when the mesh's material is `Material[]`.
   */
  private get materialArray(): THREE.Material[] {
    return [this._material];
  }

  set material(value: THREE.MeshLambertMaterial) {
    this._material.dispose();
    this._material = value;
    for (const mesh of this.meshes) {
      mesh.material = [value];
    }
  }

  get material() {
    return this._material;
  }

  private _visible = true;

  set visible(value: boolean) {
    this._visible = value;
    this.label.visible = value;
    for (const mesh of this.meshes) {
      if (value) {
        this.world.scene.three.add(mesh);
      } else {
        mesh.removeFromParent();
      }
    }
  }

  get visible() {
    return this._visible;
  }

  set rounding(value: number) {
    this.label.rounding = value;
  }

  get rounding() {
    return this.label.rounding;
  }

  set units(value: "m3" | "cm3" | "mm3" | "km3") {
    this.label.units = value;
  }

  get units() {
    return this.label.units as "m3" | "cm3" | "mm3" | "km3";
  }

  private _color = new THREE.Color();

  set color(color: THREE.Color) {
    this._color = color;
    this.label.color = color;
    this._material.color.set(color);
  }

  get color() {
    return this._color;
  }

  readonly label: MeasureMark;
  world: OBC.World;
  volume: Volume;
  meshes: THREE.Mesh[] = [];
  private _disposed = false;
  private _revision = 0;
  private _tail: Promise<void> = Promise.resolve();
  private _pending = new Set<Promise<void>>();
  private _failure: { cause: unknown } | undefined;
  private _onItemsChanged = () => {
    this.update().catch(() => undefined);
  };

  // Fragments repacks a compacted tile index as the view changes, so the
  // proxies follow it before every frame.
  private _syncProxies = () => {
    for (const mesh of this.meshes) this.syncProxyGroups(mesh);
  };

  /** Includes constructor and item-change work, including a retired visual. */
  async whenSettled(): Promise<void> {
    while (this._pending.size) await Promise.allSettled([...this._pending]);
    const failure = this._failure;
    this._failure = undefined;
    if (failure) throw failure.cause;
  }

  constructor(
    components: OBC.Components,
    world: OBC.World,
    volume = new Volume(components),
  ) {
    this._components = components;
    this.world = world;
    this.volume = volume;
    this.label = new MeasureMark(world);
    this.visible = true;
    this._onItemsChanged();
    this.volume.onItemsChanged.add(this._onItemsChanged);
    this.world.renderer?.onBeforeUpdate.add(this._syncProxies);
  }

  applyPlanesVisibility(planes: THREE.Plane[]) {
    if (!this.label.wasVisible) return;
    let isBehind = false;
    for (const mesh of this.meshes) {
      for (const plane of planes) {
        if (plane.distanceToPoint(mesh.position) < 0) {
          isBehind = true;
          break;
        }
      }
      this.label.three.visible = !isBehind;
    }
  }

  private async updateMesh(revision: number) {
    this.cleanMeshes();
    const fragments = this._components.get(OBC.FragmentsManager);
    if (!fragments.initialized) return;

    for (const [modelId, localIds] of Object.entries(this.volume.items)) {
      const model = fragments.list.get(modelId);
      if (!model) continue;
      if (!localIds || (localIds as Set<number>).size === 0) continue;
      const chunks = await model.getItemDrawChunks(localIds);
      if (this._disposed || revision !== this._revision) return;
      if (fragments.list.get(modelId) !== model) continue;
      if (!chunks || chunks.length === 0) continue;
      for (const entry of chunks) {
        const tile = model.tiles.get(entry.tileId);
        if (!tile) continue;
        const proxy = this.buildProxy(tile, entry.position, entry.size);
        if (this.visible) this.world.scene.three.add(proxy);
        this.meshes.push(proxy);
      }
    }
  }

  /**
   * Build a single proxy mesh for one tile + its picked draw chunks.
   * Aliases the source geometry's attributes and index, so the proxy
   * holds no GPU buffers of its own. Material is wrapped in
   * `Material[]` because three only honours `geometry.groups` when
   * the mesh's material is an array.
   *
   * Mirrors the Hoverer / Outliner proxy pattern.
   */
  private buildProxy(
    tile: THREE.Mesh,
    positions: Uint32Array,
    sizes: Uint32Array,
  ): THREE.Mesh {
    const sourceGeom = tile.geometry as THREE.BufferGeometry;
    const proxyGeom = new THREE.BufferGeometry();
    proxyGeom.attributes = sourceGeom.attributes;
    if (sourceGeom.index) proxyGeom.setIndex(sourceGeom.index);
    proxyGeom.boundingBox = sourceGeom.boundingBox;
    proxyGeom.boundingSphere = sourceGeom.boundingSphere;

    const ranges: IndexRange[] = [];
    const n = Math.min(positions.length, sizes.length);
    for (let i = 0; i < n; i++) {
      const raw = sizes[i];
      ranges.push({
        start: positions[i],
        count: raw === 0xffffffff ? Infinity : raw,
      });
    }

    const proxy = new THREE.Mesh(proxyGeom, this.materialArray);
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    // The source tile's matrixWorld is owned by fragments and updated
    // when the model is repositioned; mirroring it here keeps the
    // proxy in lockstep without three running a redundant matrix
    // recompute every frame.
    proxy.frustumCulled = false;
    proxy.matrixWorld.copy(tile.matrixWorld);
    proxy.userData.__measureVolumeSource = tile;
    const chunks: ProxyChunks = { ranges, layout: undefined };
    proxy.userData.__measureVolumeChunks = chunks;
    this.syncProxyGroups(proxy, true);
    return proxy;
  }

  /**
   * Points a proxy's groups at the slots its tile's index holds its chunks
   * in. Without `force` this does nothing unless Fragments repacked the
   * index since the last call.
   */
  private syncProxyGroups(proxy: THREE.Mesh, force = false) {
    const tile = proxy.userData.__measureVolumeSource as THREE.Mesh;
    const chunks = proxy.userData.__measureVolumeChunks as ProxyChunks;
    const layout = getTileIndexLayout(tile.geometry);
    if (!force && layout === chunks.layout) return;
    chunks.layout = layout;
    proxy.geometry.clearGroups();
    for (const { start, count } of toDrawnIndexRanges(
      tile.geometry,
      chunks.ranges,
    ))
      proxy.geometry.addGroup(start, count, 0);
  }

  update(): Promise<void> {
    if (this._disposed) return Promise.resolve();
    const revision = ++this._revision;
    const task = this._tail.then(async () => {
      if (this._disposed || revision !== this._revision) return;
      await this.updateMesh(revision);
      if (this._disposed || revision !== this._revision) return;
      const value = await this.volume.getRawValue();
      if (this._disposed || revision !== this._revision) return;
      const center = await this.volume.getCenter();
      if (this._disposed || revision !== this._revision) return;
      this.label.visible = this.visible && value !== 0;
      this.label.value = value;
      if (center) this.label.three.position.copy(center);
      if (this.world.renderer) {
        if ("needsUpdate" in this.world.renderer)
          this.world.renderer.needsUpdate = true;
        this.world.renderer.update();
      }
    });
    this._pending.add(task);
    this._tail = task.then(
      () => {
        this._pending.delete(task);
      },
      (cause) => {
        this._pending.delete(task);
        this._failure = { cause };
      },
    );
    return task;
  }

  private cleanMeshes() {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      // We don't call `geometry.dispose()` on the proxy: its
      // attributes and index are aliased from the source tile, and
      // disposing would free the source's GPU buffers and break the
      // model render. The lightweight `BufferGeometry` wrapper itself
      // is GC'd along with the mesh.
    }
    this.meshes = [];
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._revision += 1;
    this.volume.onItemsChanged.remove(this._onItemsChanged);
    this.world.renderer?.onBeforeUpdate.remove(this._syncProxies);
    this.label.dispose();
    this.cleanMeshes();
    this._material.dispose();
    this.volume.items = {};
  }
}
