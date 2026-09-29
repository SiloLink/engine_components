import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { DataMap } from "@thatopen/fragments";
import { WebGLAttributes } from "three/src/renderers/webgl/WebGLAttributes.js";
import { WebGLGeometries } from "three/src/renderers/webgl/WebGLGeometries.js";
import { Outliner } from "../src/fragments/Outliner";
import { SimpleOutlinePass } from "../src/core/PostproductionRenderer/src/simple-outline-pass";

test("tile retirement cannot render an uploaded, CPU-released attribute while chunks are pending", async () => {
  const components = new OBC.Components();
  const fragments = components.get(OBC.FragmentsManager);
  const models = new DataMap();
  Object.defineProperty(fragments, "core", {
    get: () => ({ models: { list: models } }),
  });
  const world = {
    camera: { three: new THREE.PerspectiveCamera() },
    isDisposing: false,
  };
  const pass = new SimpleOutlinePass(64, 64, world as never, () => null, false);
  Object.assign(world, {
    renderer: {
      postproduction: {
        outlinePass: pass,
        excludedObjectsPass: { addExcludedMaterial() {} },
      },
    },
  });
  const outliner = new Outliner(components);
  outliner.world = world as never;
  outliner.create("selection");
  const source = new THREE.BufferGeometry();
  const position = new THREE.Float32BufferAttribute(
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    3,
  );
  position.onUpload(() => {
    Reflect.deleteProperty(position, "array");
  });
  source.setAttribute("position", position);
  const tile = new THREE.Mesh(source, new THREE.MeshBasicMaterial());
  const tiles = new DataMap<number, THREE.Mesh>();
  tiles.set(1, tile);
  tiles.onBeforeDelete.add(({ value }) => value.geometry.dispose());
  let resolveChunks!: (value: never[]) => void;
  const pendingChunks = new Promise<never[]>((resolve) => {
    resolveChunks = resolve;
  });
  models.set("model", {
    tiles,
    onViewUpdated: new OBC.Event(),
    getItemDrawChunks: () =>
      tiles.size
        ? Promise.resolve([{ tileId: 1, position: [0], size: [3] }])
        : pendingChunks,
  });
  const gl = {
    FLOAT: 5126,
    ARRAY_BUFFER: 34962,
    createBuffer: () => ({}),
    bindBuffer() {},
    bufferData() {},
    deleteBuffer() {},
  };
  const attributes = WebGLAttributes(gl);
  const geometries = WebGLGeometries(
    gl,
    attributes,
    { memory: { geometries: 0 } },
    { releaseStatesOfGeometry() {} },
  );
  geometries.get(tile, source);
  geometries.update(source);
  assert.equal(position.array, undefined);
  await outliner.addItems({ model: new Set([1]) }, "selection");
  const renderMask = () => {
    for (const proxy of pass.getGroupContainer("selection")
      .children as THREE.Mesh[]) {
      geometries.get(proxy, proxy.geometry);
      geometries.update(proxy.geometry);
    }
  };
  assert.doesNotThrow(renderMask);
  tiles.delete(1);
  try {
    assert.doesNotThrow(renderMask);
    assert.equal(outliner.getPickCandidates(["selection"]).size, 0);
  } finally {
    resolveChunks([]);
    await outliner.whenSettled();
    outliner.clean("selection");
    pass.dispose();
    tile.material.dispose();
  }
});

for (const cleanup of ["detach", "remove-group", "dispose"] as const) {
  test(`${cleanup} releases outline geometry registrations without freeing source buffers`, () => {
    const pass = new SimpleOutlinePass(
      64,
      64,
      { camera: { three: new THREE.PerspectiveCamera() } } as never,
      () => null,
      false,
    );
    pass.addGroup("selection");
    const source = new THREE.BoxGeometry();
    const tile = new THREE.Mesh(source, new THREE.MeshBasicMaterial());
    const info = { memory: { geometries: 0 } };
    const removed: unknown[] = [];
    const released: THREE.BufferGeometry[] = [];
    const geometries = WebGLGeometries(
      {},
      { remove: (attribute: unknown) => removed.push(attribute) },
      info,
      {
        releaseStatesOfGeometry: (geometry: THREE.BufferGeometry) =>
          released.push(geometry),
      },
    );
    geometries.get(tile, source);
    const sourceAttributes = source.attributes;
    const sourceIndex = source.index;
    pass.attachOutlinedTile(tile, { position: [0], size: [6] }, "selection");
    const proxy = pass.getGroupContainer("selection").children[0] as THREE.Mesh;
    geometries.get(proxy, proxy.geometry);
    assert.equal(info.memory.geometries, 2);

    if (cleanup === "detach") pass.detachOutlinedTile(tile, "selection");
    else if (cleanup === "remove-group") pass.removeGroup("selection");
    else pass.dispose();

    assert.equal(info.memory.geometries, 1);
    assert.deepEqual(released, [proxy.geometry]);
    assert.deepEqual(removed, []);
    assert.equal(source.attributes, sourceAttributes);
    assert.equal(source.index, sourceIndex);
    assert.ok(source.attributes.position);
    assert.equal(proxy.parent, null);
    if (cleanup !== "dispose") pass.dispose();
    source.dispose();
    tile.material.dispose();
  });
}
