import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { SimplePlane } from "../../../../dist/index.mjs";

/** A world whose camera object can be swapped, as a projection change does. */
function createWorld(camera) {
  const domElement = {
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }),
    ownerDocument: { addEventListener() {}, removeEventListener() {} },
  };
  const listeners = new Set();
  return {
    scene: { three: new THREE.Scene() },
    renderer: { setPlane() {}, three: { domElement } },
    camera: {
      three: camera,
      enabled: true,
      controls: {
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
        update: () => {
          for (const listener of listeners) listener();
        },
      },
    },
  };
}

function createPlane(world) {
  const components = {
    get: () => ({
      localClippingPlanes: true,
      list: { getKey: () => undefined },
    }),
  };
  return new SimplePlane(
    components,
    world,
    new THREE.Vector3(),
    new THREE.Vector3(0, 0, 1),
    new THREE.MeshBasicMaterial(),
    5,
    false,
  );
}

test("the handle follows the world's camera through projection changes", () => {
  const perspective = new THREE.PerspectiveCamera();
  const orthographic = new THREE.OrthographicCamera();
  const world = createWorld(perspective);
  const plane = createPlane(world);
  assert.equal(plane.controls.camera, perspective);

  // The camera controls report the switch before the next frame.
  world.camera.three = orthographic;
  world.camera.controls.update();
  assert.equal(plane.controls.camera, orthographic);

  // Switching back follows as well, through the plane's own update too.
  world.camera.three = perspective;
  plane.update();
  assert.equal(plane.controls.camera, perspective);
});

test("a plane created under an orthographic camera picks with it", () => {
  const orthographic = new THREE.OrthographicCamera();
  const plane = createPlane(createWorld(orthographic));
  assert.equal(plane.controls.camera, orthographic);
});

test("the camera follows even while plane auto scaling is off", () => {
  const perspective = new THREE.PerspectiveCamera();
  const orthographic = new THREE.OrthographicCamera();
  const world = createWorld(perspective);
  const plane = createPlane(world);
  plane.autoScale = false;
  world.camera.three = orthographic;
  world.camera.controls.update();
  assert.equal(plane.controls.camera, orthographic);
});
