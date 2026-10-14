import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  EdgeDetectionPass,
  EdgeDetectionPassMode,
} from "../src/core/PostproductionRenderer/src/edge-detection-pass";

/** What three.js draws: visible drawables on a layer the camera sees. */
function drawnBy(scene: THREE.Scene, camera: THREE.Camera) {
  const drawn: string[] = [];
  scene.traverseVisible((object) => {
    const drawable =
      (object as THREE.Mesh).isMesh || (object as THREE.Line).isLine;
    if (drawable && object.layers.test(camera.layers)) drawn.push(object.name);
  });
  return drawn.sort();
}

function createScene() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const model = new THREE.Group();
  const tile = new THREE.Mesh(new THREE.BoxGeometry(), [
    new THREE.MeshBasicMaterial(),
  ]);
  tile.name = "tile";
  const lodGeometry = new THREE.BufferGeometry();
  Object.assign(lodGeometry, { isLODGeometry: true });
  const lod = new THREE.Mesh(lodGeometry, new THREE.LineBasicMaterial());
  lod.name = "lod";
  // A grid hangs from the model object, but is not one of its tiles.
  const grid = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial(),
  );
  grid.name = "grid";
  model.add(tile, lod, grid);
  const measurement = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshBasicMaterial(),
  );
  measurement.name = "measurement";
  scene.add(model, measurement);
  const fragments = {
    initialized: true,
    core: {
      models: {
        list: new Map([
          [
            "model",
            {
              tiles: new Map([
                [0, tile],
                [1, lod],
              ]),
            },
          ],
        ]),
      },
    },
  };
  return { camera, fragments, lod, scene, tile };
}

for (const mode of [
  EdgeDetectionPassMode.DEFAULT,
  EdgeDetectionPassMode.GLOBAL,
]) {
  test(`the edge buffer draws model tiles only (mode ${mode})`, () => {
    const { camera, fragments, lod, scene, tile } = createScene();
    const pass = new EdgeDetectionPass(
      {
        clippingPlanes: [],
        currentWorld: { scene: { three: scene }, camera: { three: camera } },
        three: { capabilities: { reversedDepthBuffer: false } },
      } as any,
      fragments as any,
    );
    pass.mode = mode;
    let edgeBuffer: string[] | null = null;
    const renderer = {
      autoClear: true,
      setRenderTarget() {},
      render(target: THREE.Object3D, view: THREE.Camera) {
        if (target === scene) edgeBuffer = drawnBy(scene, view);
      },
    };
    const target = new THREE.WebGLRenderTarget(1, 1);

    pass.render(renderer as any, target, target);

    assert.deepEqual(edgeBuffer, ["lod", "tile"]);
    // Nothing is left behind: tiles and camera see the usual layers again.
    assert.equal(tile.layers.mask, 1);
    assert.equal(lod.layers.mask, 1);
    assert.equal(camera.layers.mask, 1);
    pass.dispose();
    target.dispose();
  });
}

test("a tile already on the model layer keeps it after the edge buffer", () => {
  const { camera, fragments, lod, scene, tile } = createScene();
  tile.layers.enable(31);
  const pass = new EdgeDetectionPass(
    {
      clippingPlanes: [],
      currentWorld: { scene: { three: scene }, camera: { three: camera } },
      three: { capabilities: { reversedDepthBuffer: false } },
    } as any,
    fragments as any,
  );
  const renderer = { autoClear: true, setRenderTarget() {}, render() {} };
  const target = new THREE.WebGLRenderTarget(1, 1);

  pass.render(renderer as any, target, target);

  assert.equal(tile.layers.isEnabled(31), true);
  assert.equal(lod.layers.isEnabled(31), false);
  pass.dispose();
  target.dispose();
});
