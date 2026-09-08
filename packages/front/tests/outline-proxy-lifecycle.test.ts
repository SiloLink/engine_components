import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { WebGLGeometries } from "three/src/renderers/webgl/WebGLGeometries.js";
import { SimpleOutlinePass } from "../src/core/PostproductionRenderer/src/simple-outline-pass";

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
