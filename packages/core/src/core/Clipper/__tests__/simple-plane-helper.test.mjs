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

test("the plane handle axis is compact and symmetric with stock thickness", () => {
  const plane = createPlane(new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
  const root = plane.controls.getHelper().children[0];
  const zMeshes = (group) =>
    group.children.filter((child) => child.name === "Z" && child.isMesh);
  const bounds = (mesh) => {
    mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox;
  };
  const isShaft = (mesh) =>
    mesh.geometry.parameters.radiusTop ===
    mesh.geometry.parameters.radiusBottom;

  const [shaft] = zMeshes(root.gizmo.translate).filter(isShaft);
  assert.ok(Math.abs(bounds(shaft).min.z + 0.15) < 1e-6);
  assert.ok(Math.abs(bounds(shaft).max.z - 0.15) < 1e-6);
  assert.equal(shaft.geometry.parameters.radiusTop, 0.0075);

  const arrows = zMeshes(root.gizmo.translate).filter((mesh) => !isShaft(mesh));
  assert.equal(arrows.length, 2);
  const arrowEnds = arrows
    .map((mesh) => {
      const box = bounds(mesh);
      return box.max.z > 0 ? box.max.z : box.min.z;
    })
    .sort();
  assert.ok(Math.abs(arrowEnds[0] + 0.25) < 1e-6, `arrow ${arrowEnds[0]}`);
  assert.ok(Math.abs(arrowEnds[1] - 0.25) < 1e-6, `arrow ${arrowEnds[1]}`);

  const pickers = zMeshes(root.picker.translate);
  assert.equal(pickers.length, 2);
  const pickerEnds = pickers
    .map((mesh) => {
      const box = bounds(mesh);
      return box.max.z > 0.01 ? box.max.z : box.min.z;
    })
    .sort();
  assert.ok(Math.abs(pickerEnds[0] + 0.25) < 1e-6, `picker ${pickerEnds[0]}`);
  assert.ok(Math.abs(pickerEnds[1] - 0.25) < 1e-6, `picker ${pickerEnds[1]}`);

  // The other axes keep the stock shaft, which starts at the center.
  const xShaft = root.gizmo.translate.children.find(
    (child) => child.name === "X" && child.isMesh && isShaft(child),
  );
  assert.ok(Math.abs(bounds(xShaft).min.x) < 1e-9);
});
