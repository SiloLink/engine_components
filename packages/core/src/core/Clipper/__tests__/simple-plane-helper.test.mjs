import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { SimplePlane } from "../../../../dist/index.mjs";

/** Enough of a World and Components for a plane that never renders. */
function createPlane(origin, normal) {
  const domElement = {
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }),
    ownerDocument: { addEventListener() {}, removeEventListener() {} },
  };
  const world = {
    scene: { three: new THREE.Scene() },
    renderer: { setPlane() {}, three: { domElement } },
    camera: { three: new THREE.PerspectiveCamera(), enabled: true },
  };
  const components = {
    get: () => ({
      localClippingPlanes: true,
      list: { getKey: () => undefined },
    }),
  };
  return new SimplePlane(
    components,
    world,
    origin,
    normal,
    new THREE.MeshBasicMaterial(),
    5,
    false,
  );
}

const facing = (helper) =>
  new THREE.Vector3(0, 0, 1).applyQuaternion(helper.quaternion);

test("the helper faces along the normal wherever the plane sits", () => {
  const plane = createPlane(
    new THREE.Vector3(5, 10, 15),
    new THREE.Vector3(1, 0, 0),
  );
  assert.ok(facing(plane.helper).distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-9);

  // Turn the plane while it is away from the origin, as a rotated box does.
  const turned = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
  plane.setFromNormalAndCoplanarPoint(turned, new THREE.Vector3(7, 10, 12));
  assert.ok(facing(plane.helper).distanceTo(turned) < 1e-9);
  assert.deepEqual(plane.helper.position.toArray(), [7, 10, 12]);
  assert.ok(plane.three.distanceToPoint(new THREE.Vector3(7, 10, 12)) < 1e-9);

  // Turning back restores an axis-aligned helper.
  plane.setFromNormalAndCoplanarPoint(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 10, 15),
  );
  assert.ok(facing(plane.helper).distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-9);
});
