import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  Postproduction,
  PostproductionAspect,
} from "../src/core/PostproductionRenderer/src";
import { SimpleOutlinePass } from "../src/core/PostproductionRenderer/src/simple-outline-pass";

const FILLS = "outline-scene-fills";

// The part of WebGLRenderer the composer drives, recording whether outline
// fills were active during each render.
class TraceRenderer {
  autoClear = true;
  autoClearColor = true;
  autoClearDepth = true;
  autoClearStencil = true;
  capabilities = { reversedDepthBuffer: false };
  domElement = { width: 8, height: 8 };
  outputColorSpace = THREE.SRGBColorSpace;
  toneMapping = THREE.NoToneMapping;
  toneMappingExposure = 1;
  readonly fillRenders: boolean[] = [];
  fillsActive = () => false;

  private _target: THREE.WebGLRenderTarget | null = null;
  private _clearColor = new THREE.Color();
  private _clearAlpha = 1;

  getPixelRatio() {
    return 1;
  }

  getSize(target: THREE.Vector2) {
    return target.set(8, 8);
  }

  getRenderTarget() {
    return this._target;
  }

  setRenderTarget(target: THREE.WebGLRenderTarget | null) {
    this._target = target;
  }

  getClearColor(target: THREE.Color) {
    return target.copy(this._clearColor);
  }

  setClearColor(color: THREE.ColorRepresentation, alpha = 1) {
    this._clearColor.set(color);
    this._clearAlpha = alpha;
  }

  getClearAlpha() {
    return this._clearAlpha;
  }

  setClearAlpha(alpha: number) {
    this._clearAlpha = alpha;
  }

  clear() {}

  clearDepth() {}

  render() {
    this.fillRenders.push(this.fillsActive());
  }
}

function createPostproduction() {
  const renderer = new TraceRenderer();
  const world = {
    scene: { three: new THREE.Scene() },
    camera: { three: new THREE.PerspectiveCamera() },
  };
  const components = { get: () => ({ initialized: false }) };
  const postproduction = new Postproduction(
    components as any,
    { three: renderer, currentWorld: world } as any,
  );
  postproduction.enabled = true;
  // A selected tile carries the fill hook only while fills are drawn.
  const tile = new THREE.Mesh(new THREE.BoxGeometry());
  postproduction.outlinePass.addGroup("selection", { fillOpacity: 0.75 });
  postproduction.outlinePass.attachOutlinedTile(
    tile,
    { position: [0], size: [6] },
    "selection",
  );
  renderer.fillsActive = () =>
    Object.prototype.hasOwnProperty.call(tile, "onAfterRender");
  return { postproduction, renderer, world };
}

const styles = Object.entries(PostproductionAspect).filter(
  (entry): entry is [string, PostproductionAspect] =>
    typeof entry[1] === "number",
);

test("color styles draw fills only inside the scene render; other styles composite them", () => {
  // SMAAPass decodes its lookup textures through images when constructed.
  const globals = globalThis as { Image?: unknown };
  const previousImage = globals.Image;
  globals.Image ??= function StubImage() {};
  try {
    for (const [name, style] of styles) {
      for (const outlines of [true, false]) {
        const { postproduction, renderer, world } = createPostproduction();
        try {
          postproduction.outlinesEnabled = outlines;
          postproduction.style = style;
          const colorRender = postproduction.composer!.passes.includes(
            postproduction.basePass,
          );
          const sceneFills = outlines && colorRender;
          const label = `${name}, outlines ${outlines}`;

          postproduction.update();

          // Exactly the base pass render draws the fills; edge, AO, gloss
          // and mask renders of the same scene never do.
          assert.equal(
            renderer.fillRenders.filter(Boolean).length,
            sceneFills ? 1 : 0,
            label,
          );
          assert.equal(
            postproduction.outlinePass.compositeFill,
            !sceneFills,
            label,
          );
          // Inactive again, so a direct render without postproduction cannot
          // draw them.
          assert.equal(renderer.fillsActive(), false, label);
        } finally {
          postproduction.dispose();
        }
        assert.equal(world.scene.three.getObjectByName(FILLS), undefined);
      }
    }
  } finally {
    globals.Image = previousImage;
  }
});

test("a fill paints the outlined part of each range right after its surface", () => {
  const clippingPlanes: THREE.Plane[] = [];
  const world = {
    renderer: { clippingPlanes },
    camera: { three: new THREE.PerspectiveCamera() },
  };
  for (const reversed of [false, true]) {
    const pass = new SimpleOutlinePass(8, 8, world as any, reversed);
    pass.addGroup("selection", {
      fillColor: new THREE.Color(0x007dff),
      fillOpacity: 0.75,
      priority: 100,
    });
    pass.addGroup("batch", { fillOpacity: 0.75, priority: 90 });
    pass.addGroup("focus", { fillOpacity: 0, thickness: 0, priority: 40 });
    const { fillMaterial } = pass.getGroup("selection")!;
    assert.equal(fillMaterial.transparent, true);
    assert.equal(fillMaterial.opacity, 0.75);
    assert.equal(fillMaterial.color.getHex(), 0x007dff);
    assert.equal(fillMaterial.depthWrite, false);
    assert.equal(fillMaterial.depthFunc, THREE.LessEqualDepth);
    assert.equal(fillMaterial.polygonOffset, true);
    assert.equal(fillMaterial.polygonOffsetFactor, -1);
    // three.js negates only the factor for a reversed depth buffer.
    assert.equal(fillMaterial.polygonOffsetUnits, reversed ? 1 : -1);
    assert.equal(fillMaterial.clippingPlanes, clippingPlanes);

    const geometry = new THREE.BoxGeometry();
    const tile = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial());
    const focused = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial());
    // three.js batches the ranges of a tile only while it has no own hook.
    const hooked = (mesh: THREE.Mesh) =>
      Object.prototype.hasOwnProperty.call(mesh, "onAfterRender");
    pass.attachOutlinedTile(tile, { position: [6], size: [12] }, "selection");
    pass.attachOutlinedTile(tile, { position: [6], size: [12] }, "batch");
    pass.attachOutlinedTile(focused, { position: [0], size: [36] }, "focus");
    assert.equal(hooked(tile), false);

    const draws: { material: THREE.Material; start: number; count: number }[] =
      [];
    const renderer = {
      renderBufferDirect: (
        _camera: unknown,
        _scene: unknown,
        drawnGeometry: THREE.BufferGeometry,
        material: THREE.Material,
        object: THREE.Object3D,
        range: THREE.GeometryGroup,
      ) => {
        assert.equal(drawnGeometry, geometry);
        assert.equal(object, tile);
        draws.push({ material, start: range.start, count: range.count });
      },
    };
    const scene = new THREE.Scene();
    const drawn = (range: THREE.GeometryGroup | null) => {
      draws.length = 0;
      tile.onAfterRender(
        renderer as any,
        scene,
        world.camera.three,
        geometry,
        tile.material,
        range as any,
      );
      return draws.map(({ material, start, count }) => [
        material === fillMaterial,
        start,
        count,
      ]);
    };
    const range = (start: number, count: number) => ({
      start,
      count,
      materialIndex: 0,
    });

    // Only the scene render paints fills, and only filled tiles get a hook:
    // a focus or context group without fill keeps its tiles batched.
    pass.showSceneFills(scene);
    assert.equal(hooked(tile), true);
    assert.equal(hooked(focused), false);
    // The overlap with the drawn range, once, in the higher-priority fill.
    assert.deepEqual(drawn(range(0, 12)), [[true, 6, 6]]);
    assert.deepEqual(drawn(range(12, 24)), [[true, 12, 6]]);
    assert.deepEqual(drawn(null), [[true, 6, 12]]);
    assert.deepEqual(drawn(range(24, 12)), []);
    pass.hideSceneFills();
    assert.equal(hooked(tile), false);
    assert.deepEqual(drawn(null), []);

    // Group settings apply from the next scene render.
    pass.configureGroup("selection", { fillOpacity: 0 });
    pass.configureGroup("batch", { fillOpacity: 0 });
    pass.showSceneFills(scene);
    assert.equal(hooked(tile), false);
    pass.hideSceneFills();

    // A hook the tile already had keeps running and comes back afterwards.
    let previousCalls = 0;
    const previous = () => {
      previousCalls++;
    };
    tile.onAfterRender = previous;
    pass.configureGroup("selection", { fillOpacity: 0.75 });
    pass.showSceneFills(scene);
    pass.showSceneFills(scene);
    assert.deepEqual(drawn(null), [[true, 6, 12]]);
    assert.equal(previousCalls, 1);
    pass.hideSceneFills();
    assert.equal(tile.onAfterRender, previous);
    // Detaching during a scene render releases the hook as well.
    pass.showSceneFills(scene);
    pass.detachOutlinedTile(tile, "selection");
    pass.detachOutlinedTile(tile, "batch");
    assert.equal(tile.onAfterRender, previous);
    pass.dispose();
    geometry.dispose();
    (tile.material as THREE.Material).dispose();
    (focused.material as THREE.Material).dispose();
  }
});

test("a mesh added to a group gets a fill that follows it until it leaves", () => {
  const world = { camera: { three: new THREE.PerspectiveCamera() } };
  const pass = new SimpleOutlinePass(8, 8, world as any, false);
  const geometry = new THREE.BoxGeometry();
  const mesh = new THREE.Mesh(geometry);
  mesh.position.set(1, 2, 3);
  pass.addMeshToGroup(mesh, "selection");
  const scene = new THREE.Scene();

  pass.showSceneFills(scene);
  const fills = scene.getObjectByName(FILLS)!;
  const fill = fills.children[0] as THREE.Mesh;
  assert.equal(fill.geometry, geometry);
  assert.equal(fill.material, pass.getGroup("selection")!.fillMaterial);
  assert.deepEqual(
    new THREE.Vector3().setFromMatrixPosition(fill.matrixWorld).toArray(),
    [1, 2, 3],
  );

  mesh.removeFromParent();
  pass.showSceneFills(scene);
  assert.equal(fill.parent, null);
  pass.dispose();
  geometry.dispose();
});
