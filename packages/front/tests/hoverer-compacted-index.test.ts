import assert from "node:assert/strict";
import test from "node:test";
import * as OBC from "@thatopen/components";
import { DataMap } from "@thatopen/fragments";
import * as THREE from "three";
import { Hoverer } from "../src/fragments/Hoverer";

function createWorld() {
  const callbacks = new Set<() => void>();
  const onBeforeUpdate = {
    add: (callback: () => void) => callbacks.add(callback),
    remove: (callback: () => void) => callbacks.delete(callback),
    trigger: () => {
      for (const callback of [...callbacks]) callback();
    },
  };
  const scene = new THREE.Scene();
  const world = {
    isDisposing: false,
    scene: { three: scene },
    camera: { three: new THREE.PerspectiveCamera() },
    renderer: {
      three: { domElement: new EventTarget() },
      onBeforeUpdate,
    },
  };
  return { world, scene, callbacks, render: onBeforeUpdate.trigger };
}

function createTile() {
  const full = Uint16Array.from({ length: 30 }, (_, slot) => slot);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(90), 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(full, 1));
  geometry.userData.fullIndex = full;
  const tile = new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial()]);

  // Fragments preserves its BufferAttribute while first allocating a packed
  // array, subsequently repacking it, and restoring the complete layout.
  const pack = (runs?: [number, number][]) => {
    const index = geometry.index!;
    geometry.clearGroups();
    if (!runs) {
      index.array.set(full);
      geometry.setDrawRange(0, Infinity);
      geometry.addGroup(0, full.length, 0);
      geometry.userData.compactIndex = false;
      delete geometry.userData.compactRuns;
    } else {
      if (index.array === full) index.array = full.slice();
      const offsets: number[] = [];
      let offset = 0;
      for (const [start, count] of runs) {
        offsets.push(offset);
        index.array.set(full.subarray(start, start + count), offset);
        offset += count;
      }
      geometry.setDrawRange(0, offset);
      geometry.addGroup(0, offset, 0);
      geometry.userData.compactIndex = true;
      geometry.userData.compactRuns = {
        start: Uint32Array.from(runs, ([start]) => start),
        count: Uint32Array.from(runs, ([, count]) => count),
        offset: Uint32Array.from(offsets),
      };
    }
    index.needsUpdate = true;
  };
  return { tile, full, pack };
}

function setup() {
  const components = new OBC.Components();
  const fragments = components.get(OBC.FragmentsManager);
  const source = createTile();
  let queries = 0;
  const models = new DataMap<string, unknown>();
  models.set("model", {
    tiles: new Map([[1, source.tile]]),
    getItemDrawChunks: async () => {
      queries++;
      return [
        {
          tileId: 1,
          position: new Uint32Array([12]),
          size: new Uint32Array([6]),
        },
      ];
    },
  });
  Object.defineProperty(fragments, "core", {
    get: () => ({ models: { list: models } }),
  });
  const pickers = components.get(OBC.FastModelPickers);
  pickers.get = () =>
    ({
      getItemAt: async () => ({ modelId: "model", localId: 2 }),
    }) as never;
  const hoverer = new Hoverer(components);
  const view = createWorld();
  hoverer.world = view.world as never;
  hoverer.enabled = true;
  return { hoverer, source, view, queries: () => queries };
}

for (const fade of [false, true]) {
  test(`a stationary hover follows compaction after ${fade ? "its fade ends" : "attaching without a fade"}`, async (t) => {
    const callbacks: FrameRequestCallback[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "requestAnimationFrame",
    );
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => callbacks.push(callback),
    });
    t.after(() => {
      if (descriptor)
        Object.defineProperty(globalThis, "requestAnimationFrame", descriptor);
      else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    });
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    const { hoverer, source, view, queries } = setup();
    t.after(() => hoverer.dispose());
    hoverer.fade = fade;
    await hoverer.hover();
    if (fade) {
      now += hoverer.fadeDuration;
      callbacks.shift()!(now);
    }
    assert.equal(callbacks.length, 0, "no hover animation remains pending");
    const [proxy] = view.scene.children as THREE.Mesh[];
    const vertices = () =>
      proxy.geometry.groups.flatMap(({ start, count }) =>
        Array.from(proxy.geometry.index!.array.slice(start, start + count)),
      );
    const expected = [12, 13, 14, 15, 16, 17];
    assert.deepEqual(vertices(), expected);
    assert.equal(proxy.geometry.index, source.tile.geometry.index);
    assert.equal(proxy.geometry.attributes, source.tile.geometry.attributes);

    source.pack([
      [0, 6],
      [12, 6],
      [24, 6],
    ]);
    view.render();
    assert.deepEqual(vertices(), expected);
    assert.deepEqual(proxy.geometry.groups, [
      { start: 6, count: 6, materialIndex: 0 },
    ]);

    source.pack([
      [3, 3],
      [12, 6],
      [24, 6],
    ]);
    source.tile.matrixWorld.makeTranslation(3, 4, 5);
    view.render();
    assert.deepEqual(vertices(), expected);
    assert.deepEqual(proxy.geometry.groups, [
      { start: 3, count: 6, materialIndex: 0 },
    ]);
    assert.deepEqual(
      proxy.matrixWorld.elements,
      source.tile.matrixWorld.elements,
    );

    // Source index edits retain the packing and bump the same GPU attribute's
    // version. The proxy must see the new order without a second index buffer.
    const version = proxy.geometry.index!.version;
    source.full.set([15, 16, 17, 12, 13, 14], 12);
    source.tile.geometry.index!.array.set(source.full.subarray(12, 18), 3);
    source.tile.geometry.index!.needsUpdate = true;
    view.render();
    assert.deepEqual(vertices(), [15, 16, 17, 12, 13, 14]);
    assert.equal(proxy.geometry.index!.version, version + 1);
    assert.equal(proxy.geometry.index, source.tile.geometry.index);

    source.pack([
      [0, 6],
      [18, 6],
      [24, 6],
    ]);
    view.render();
    assert.deepEqual(vertices(), []);
    source.pack();
    view.render();
    assert.deepEqual(vertices(), [15, 16, 17, 12, 13, 14]);
    assert.deepEqual(proxy.geometry.groups, [
      { start: 12, count: 6, materialIndex: 0 },
    ]);
    assert.equal(
      queries(),
      1,
      "repacking does not query the hovered item again",
    );
  });
}

test("a hover attaches at the packed slots of an already compacted tile", async () => {
  const { hoverer, source, view } = setup();
  hoverer.fade = false;
  source.pack([
    [0, 6],
    [12, 6],
    [24, 6],
  ]);
  try {
    await hoverer.hover();
    const [proxy] = view.scene.children as THREE.Mesh[];
    assert.equal(proxy.geometry.index, source.tile.geometry.index);
    assert.deepEqual(proxy.geometry.groups, [
      { start: 6, count: 6, materialIndex: 0 },
    ]);
  } finally {
    hoverer.dispose();
  }
});

test("renderer synchronization detaches on world change, disable and disposal", async () => {
  const { hoverer, view } = setup();
  hoverer.fade = false;
  try {
    assert.equal(view.callbacks.size, 1);
    hoverer.enabled = true;
    assert.equal(view.callbacks.size, 1);
    await hoverer.hover();
    const next = createWorld();
    hoverer.world = next.world as never;
    assert.equal(view.callbacks.size, 0);
    assert.equal(view.scene.children.length, 0);
    assert.equal(next.callbacks.size, 1);
    await hoverer.hover();
    assert.equal(next.scene.children.length, 1);
    hoverer.enabled = false;
    assert.equal(next.callbacks.size, 0);
    assert.equal(next.scene.children.length, 0);
    hoverer.enabled = true;
    assert.equal(next.callbacks.size, 1);
    next.world.isDisposing = true;
    hoverer.dispose();
    assert.equal(next.callbacks.size, 0);
  } finally {
    hoverer.dispose();
  }
});
