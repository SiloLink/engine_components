import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { OrthoPerspectiveCamera } from "../../../../dist/index.mjs";

globalThis.window ??= { innerWidth: 800, innerHeight: 600 };

/** A camera on a resizeable renderer whose canvas size the test sets. */
function createCamera(previous = new THREE.Vector2(800, 600)) {
  const canvas = { width: 800, height: 600 };
  const camera = new OrthoPerspectiveCamera({});
  camera._currentWorld = {
    renderer: {
      isResizeable: () => true,
      getSize: () => new THREE.Vector2(canvas.width, canvas.height),
    },
  };
  camera.previousSize = previous;
  const resize = (width, height) => {
    canvas.width = width;
    canvas.height = height;
    camera.updateAspect();
  };
  return { camera, resize };
}

function frustum(camera) {
  const { left, right, top, bottom } = camera.threeOrtho;
  return [left, right, top, bottom];
}

test("an orthographic view survives the canvas being hidden and shown", () => {
  const { camera, resize } = createCamera();
  camera.three = camera.threeOrtho;
  Object.assign(camera.threeOrtho, { left: -4, right: 4, top: 3, bottom: -3 });

  resize(0, 0);
  assert.deepEqual(frustum(camera), [-4, 4, 3, -3]);

  resize(800, 600);
  assert.deepEqual(frustum(camera), [-4, 4, 3, -3]);

  // Later resizes still scale from the size the view was fitted to.
  resize(1600, 600);
  assert.deepEqual(frustum(camera), [-8, 8, 3, -3]);
});

test("a perspective camera keeps its aspect while the canvas has no size", () => {
  const { camera, resize } = createCamera();
  camera.three = camera.threePersp;
  resize(800, 600);
  assert.equal(camera.threePersp.aspect, 800 / 600);

  resize(0, 600);
  assert.equal(camera.threePersp.aspect, 800 / 600);

  resize(1200, 600);
  assert.equal(camera.threePersp.aspect, 2);
});

test("a camera created while its canvas had no size takes the first real size as reference", () => {
  const { camera, resize } = createCamera(new THREE.Vector2(0, 0));
  camera.three = camera.threeOrtho;
  Object.assign(camera.threeOrtho, { left: -4, right: 4, top: 3, bottom: -3 });

  resize(800, 600);
  assert.deepEqual(frustum(camera), [-4, 4, 3, -3]);

  resize(1600, 600);
  assert.deepEqual(frustum(camera), [-8, 8, 3, -3]);
});
