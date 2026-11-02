import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { SimpleOutlinePass } from "../src/core/PostproductionRenderer/src/simple-outline-pass";
import { toDrawnIndexRanges } from "../src/utils/tile-index-layout";

/** A SHELL tile with a 30-slot full index, drawn whole. */
function createTile() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(new Float32Array(90), 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(30), 1));
  geometry.addGroup(0, 30, 0);
  return new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial()]);
}

/** The record Fragments publishes after packing these full-index runs. */
function packing(runs: [number, number][]) {
  const offset: number[] = [];
  let slot = 0;
  for (const [, count] of runs) {
    offset.push(slot);
    slot += count;
  }
  return {
    start: Uint32Array.from(runs.map(([start]) => start)),
    count: Uint32Array.from(runs.map(([, count]) => count)),
    offset: Uint32Array.from(offset),
  };
}

/**
 * Leaves a tile as Fragments draws it after packing these shown full-index
 * runs `[start, count]` into its index; without runs, as it draws the full
 * index again.
 */
function setPacking(tile: THREE.Mesh, runs?: [number, number][]) {
  const { geometry } = tile;
  geometry.clearGroups();
  if (!runs) {
    geometry.setDrawRange(0, Infinity);
    geometry.addGroup(0, 30, 0);
    geometry.userData.compactIndex = false;
    delete geometry.userData.compactRuns;
    return;
  }
  const count = runs.reduce((sum, [, runCount]) => sum + runCount, 0);
  geometry.setDrawRange(0, count);
  geometry.addGroup(0, count, 0);
  geometry.userData.compactIndex = true;
  geometry.userData.compactRuns = packing(runs);
}

/** The part of WebGLRenderer the mask render and the fill hook drive. */
function createRenderer() {
  const fills: { material: THREE.Material; start: number; count: number }[] =
    [];
  return {
    fills,
    getClearColor: (color: THREE.Color) => color.set(0x000000),
    getClearAlpha: () => 1,
    setClearColor() {},
    setRenderTarget() {},
    clear() {},
    render() {},
    renderBufferDirect(
      _camera: THREE.Camera,
      _scene: THREE.Scene,
      _geometry: THREE.BufferGeometry,
      material: THREE.Material,
      _object: THREE.Object3D,
      range: { start: number; count: number },
    ) {
      fills.push({ material, start: range.start, count: range.count });
    },
  };
}

/** A pass with these groups and fills, by name and priority. */
function createPass(groups: [string, number][] = [["selection", 100]]) {
  const camera = new THREE.PerspectiveCamera();
  const pass = new SimpleOutlinePass(
    8,
    8,
    { camera: { three: camera } } as never,
    false,
  );
  const names = new Map<THREE.Material, string>();
  for (const [name, priority] of groups) {
    pass.addGroup(name, { fillOpacity: 0.75, priority });
    names.set(pass.getGroup(name)!.fillMaterial, name);
  }
  const target = new THREE.WebGLRenderTarget(8, 8);
  const renderer = createRenderer();
  const scene = new THREE.Scene();
  const proxyGroups = () =>
    (pass.getGroupContainer("selection").children as THREE.Mesh[]).map(
      (proxy) =>
        proxy.geometry.groups.map(({ start, count }) => ({ start, count })),
    );
  /** Renders the outline mask, as a style without scene fills does. */
  const renderMask = () => {
    pass.render(renderer as never, target, target);
    return proxyGroups();
  };
  /** Draws the tile's fills for the range three.js has drawn of it. */
  const drawFills = (tile: THREE.Mesh) => {
    renderer.fills.length = 0;
    pass.showSceneFills(scene);
    tile.onAfterRender(
      renderer as never,
      scene,
      camera,
      tile.geometry,
      (tile.material as THREE.Material[])[0],
      tile.geometry.groups[0] as never,
    );
    pass.hideSceneFills();
    return renderer.fills.map(({ material, start, count }) => ({
      group: names.get(material),
      start,
      count,
    }));
  };
  return { pass, renderMask, drawFills, proxyGroups };
}

const selected = (start: number, count: number) => ({
  group: "selection",
  start,
  count,
});

test("outlines follow the tile's index as Fragments packs and restores it", () => {
  const tile = createTile();
  const { pass, renderMask, drawFills, proxyGroups } = createPass();
  try {
    // An item in full-index slots [12, 18).
    pass.attachOutlinedTile(tile, { position: [12], size: [6] }, "selection");
    assert.deepEqual(proxyGroups(), [[{ start: 12, count: 6 }]]);

    // [0, 6), [12, 18) and [24, 30) are shown and packed into [0, 18).
    setPacking(tile, [
      [0, 6],
      [12, 6],
      [24, 6],
    ]);
    assert.deepEqual(renderMask(), [[{ start: 6, count: 6 }]]);
    assert.deepEqual(drawFills(tile), [selected(6, 6)]);

    // Another view packs the item elsewhere: the mask and the fill move along.
    setPacking(tile, [
      [3, 3],
      [12, 6],
      [24, 6],
    ]);
    assert.deepEqual(drawFills(tile), [selected(3, 6)]);
    assert.deepEqual(renderMask(), [[{ start: 3, count: 6 }]]);

    // While the item is hidden there is nothing to outline in the tile.
    setPacking(tile, [
      [0, 6],
      [18, 6],
      [24, 6],
    ]);
    assert.deepEqual(renderMask(), [[]]);
    assert.deepEqual(drawFills(tile), []);

    setPacking(tile);
    assert.deepEqual(renderMask(), [[{ start: 12, count: 6 }]]);
    assert.deepEqual(drawFills(tile), [selected(12, 6)]);
  } finally {
    pass.dispose();
  }
});

test("new chunks of a packed tile are drawn at their packed slots", () => {
  const tile = createTile();
  const { pass, drawFills, proxyGroups } = createPass();
  try {
    setPacking(tile, [
      [0, 6],
      [12, 6],
      [24, 6],
    ]);
    pass.attachOutlinedTile(tile, { position: [24], size: [6] }, "selection");
    assert.deepEqual(proxyGroups(), [[{ start: 12, count: 6 }]]);
    pass.attachOutlinedTile(
      tile,
      { position: [0], size: [0xffffffff] },
      "selection",
    );
    assert.deepEqual(proxyGroups(), [[{ start: 0, count: 18 }]]);
    assert.deepEqual(drawFills(tile), [selected(0, 18)]);
  } finally {
    pass.dispose();
  }
});

test("an item in several groups is filled once, by the highest, however the tile packs", () => {
  const tile = createTile();
  const { pass, drawFills } = createPass([
    ["selection", 100],
    ["batch", 90],
  ]);
  const batch = (start: number, count: number) => ({
    group: "batch",
    start,
    count,
  });
  try {
    // The selection is item [0, 6); the batch also holds item [12, 18).
    pass.attachOutlinedTile(tile, { position: [0], size: [6] }, "selection");
    pass.attachOutlinedTile(tile, { position: [0, 12], size: [6, 6] }, "batch");
    assert.deepEqual(drawFills(tile), [selected(0, 6), batch(12, 6)]);

    // Packed, the batch's two items meet in [0, 12).
    setPacking(tile, [
      [0, 6],
      [12, 6],
      [24, 6],
    ]);
    assert.deepEqual(drawFills(tile), [selected(0, 6), batch(6, 6)]);

    // Another view shows only half of the selected item.
    setPacking(tile, [
      [3, 3],
      [12, 6],
      [24, 6],
    ]);
    assert.deepEqual(drawFills(tile), [selected(0, 3), batch(3, 6)]);

    setPacking(tile);
    assert.deepEqual(drawFills(tile), [selected(0, 6), batch(12, 6)]);

    // Adjacent items of one group come as one chunk of the full index.
    pass.attachOutlinedTile(tile, { position: [0], size: [12] }, "batch");
    assert.deepEqual(drawFills(tile), [selected(0, 6), batch(6, 6)]);
  } finally {
    pass.dispose();
  }
});

test("full-index ranges map to the shown part of a packed index", () => {
  const tile = createTile();
  const ranges = [
    { start: 3, count: 12 },
    { start: 26, count: Infinity },
  ];
  assert.equal(toDrawnIndexRanges(tile.geometry, ranges), ranges);
  setPacking(tile, [
    [0, 6],
    [12, 6],
    [24, 6],
  ]);
  // Hidden slots [6, 12) drop out, and the shown parts that meet in the
  // packing merge.
  assert.deepEqual(toDrawnIndexRanges(tile.geometry, ranges), [
    { start: 3, count: 6 },
    { start: 14, count: 4 },
  ]);
  // Ranges in any order.
  assert.deepEqual(
    toDrawnIndexRanges(tile.geometry, [
      { start: 24, count: 6 },
      { start: 0, count: 6 },
    ]),
    [
      { start: 12, count: 6 },
      { start: 0, count: 6 },
    ],
  );
});

test("mapping agrees slot by slot with the packing of many runs", () => {
  // A fixed pseudo-random sequence, so a failure reproduces.
  let seed = 7;
  const random = (limit: number) => {
    seed = (seed * 48271) % 2147483647;
    return seed % limit;
  };
  const geometry = new THREE.BufferGeometry();
  for (let layout = 0; layout < 20; layout++) {
    const runs: [number, number][] = [];
    for (let start = random(5); start < 20_000; ) {
      const count = 1 + random(40);
      runs.push([start, count]);
      start += count + 1 + random(40);
    }
    geometry.userData = { compactIndex: true, compactRuns: packing(runs) };
    const packedSlot = new Map<number, number>();
    let slot = 0;
    for (const [start, count] of runs)
      for (let i = start; i < start + count; i++) packedSlot.set(i, slot++);

    const ranges = Array.from({ length: 200 }, () => ({
      start: random(20_000),
      count: random(10) === 0 ? Infinity : 1 + random(400),
    }));
    // Every shown slot of the ranges, in their order, merged where packed
    // slots meet.
    const expected: { start: number; count: number }[] = [];
    for (const { start, count } of ranges) {
      for (let i = start; i < Math.min(start + count, 20_100); i++) {
        const at = packedSlot.get(i);
        if (at === undefined) continue;
        const previous = expected[expected.length - 1];
        if (previous && previous.start + previous.count === at)
          previous.count += 1;
        else expected.push({ start: at, count: 1 });
      }
    }
    assert.deepEqual(toDrawnIndexRanges(geometry, ranges), expected);
  }
});
