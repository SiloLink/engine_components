import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { EdgeDetectionPass } from "../src/core/PostproductionRenderer/src/edge-detection-pass";
import { SimpleOutlinePass } from "../src/core/PostproductionRenderer/src/simple-outline-pass";

// The Clipper keeps local planes only in the renderer's own list and edits it
// in place, so a material that references that same array is clipped by every
// current plane without further bookkeeping.
function createRenderer() {
  return {
    clippingPlanes: [] as THREE.Plane[],
    currentWorld: null,
    three: { capabilities: { reversedDepthBuffer: false } },
  };
}

test("edge detection renders face IDs with the renderer's clipping planes", () => {
  const renderer = createRenderer();
  const pass = new EdgeDetectionPass(renderer as any, {} as any);
  const material = (pass as any)._overrideMaterial as THREE.ShaderMaterial;
  assert.equal(material.clipping, true);
  assert.equal(material.clippingPlanes, renderer.clippingPlanes);

  const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 2);
  renderer.clippingPlanes.push(plane);
  assert.deepEqual(material.clippingPlanes, [plane]);
  pass.dispose();
});

test("outline masks and fills render with the world's clipping planes", () => {
  const renderer = createRenderer();
  const world = {
    renderer,
    scene: { three: new THREE.Scene() },
    camera: { three: new THREE.PerspectiveCamera() },
  };
  const pass = new SimpleOutlinePass(8, 8, world as any, false);
  pass.addGroup("selection");
  const { material, fillMaterial } = pass.getGroup("selection")!;
  assert.equal(material.clipping, true);
  for (const outline of [material, fillMaterial]) {
    assert.equal(outline.clippingPlanes, renderer.clippingPlanes);
  }

  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -3);
  renderer.clippingPlanes.push(plane);
  assert.deepEqual(material.clippingPlanes, [plane]);
  assert.deepEqual(fillMaterial.clippingPlanes, [plane]);
  pass.dispose();
});
