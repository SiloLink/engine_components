import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  GlossPass,
  Postproduction,
  PostproductionAspect,
} from "../src/core/PostproductionRenderer/src";
import { EdgeDetectionPass } from "../src/core/PostproductionRenderer/src/edge-detection-pass";

// Models the part of WebGLRenderer that decides what gets cleared: an
// explicit clear, or a render while `autoClear` is on, clears the bound
// target, including a depth texture attached to it.
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
  readonly depthClears = new Map<THREE.DepthTexture, number>();

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

  clear(_color = true, depth = true) {
    const depthTexture = this._target?.depthTexture;
    if (!depth || !depthTexture) return;
    this.depthClears.set(
      depthTexture,
      (this.depthClears.get(depthTexture) ?? 0) + 1,
    );
  }

  clearDepth() {
    this.clear(false, true);
  }

  render(scene: THREE.Object3D) {
    const background = (scene as THREE.Scene).background as THREE.Color | null;
    if (this.autoClear || background?.isColor) {
      this.clear(this.autoClearColor, this.autoClearDepth);
    }
  }
}

function createWorld() {
  return {
    scene: { three: new THREE.Scene() },
    camera: { three: new THREE.PerspectiveCamera() },
  };
}

function createPostproduction() {
  const renderer = new TraceRenderer();
  const world = createWorld();
  const components = { get: () => ({ initialized: false }) };
  const postproduction = new Postproduction(
    components as any,
    { three: renderer, currentWorld: world } as any,
  );
  postproduction.enabled = true;
  return { postproduction, renderer };
}

const styles = Object.entries(PostproductionAspect).filter(
  (entry): entry is [string, PostproductionAspect] =>
    typeof entry[1] === "number",
);

// Renders one frame and reports whether the scene depth captured for the
// outline fill was cleared before the outline pass read it.
function outlineReadsClearedDepth(style: PostproductionAspect, gloss: boolean) {
  const { postproduction, renderer } = createPostproduction();
  postproduction.glossEnabled = gloss;
  postproduction.outlinesEnabled = true;
  postproduction.style = style;

  const internals = postproduction as any;
  let captured: THREE.DepthTexture | null = null;
  let clearsAtCapture = 0;
  const onCaptured = (depth: THREE.DepthTexture | null) => {
    captured = depth;
    clearsAtCapture = depth ? renderer.depthClears.get(depth) ?? 0 : 0;
  };
  for (const pass of [internals._basePass, internals._sceneDepthPass]) {
    const capture = pass._onSceneDepthRendered;
    pass._onSceneDepthRendered = (depth: THREE.DepthTexture | null) => {
      onCaptured(depth);
      capture(depth);
    };
  }
  const outline = postproduction.outlinePass;
  const renderOutline = outline.render.bind(outline);
  let cleared: boolean | undefined;
  outline.render = (...args: Parameters<typeof outline.render>) => {
    const depth = internals._sceneDepthTexture as THREE.DepthTexture | null;
    assert.ok(depth, "the scene depth was captured");
    assert.equal(depth, captured);
    cleared = (renderer.depthClears.get(depth) ?? 0) !== clearsAtCapture;
    renderOutline(...args);
  };

  try {
    postproduction.update();
    assert.equal(renderer.autoClear, true, "autoClear is restored");
  } finally {
    postproduction.dispose();
  }
  assert.notEqual(cleared, undefined, "the outline pass rendered");
  return cleared;
}

test("every style keeps the captured scene depth intact for the outline fill", () => {
  // SMAAPass decodes its lookup textures through images when constructed.
  const globals = globalThis as { Image?: unknown };
  const previousImage = globals.Image;
  globals.Image ??= function StubImage() {};
  try {
    const cleared: string[] = [];
    for (const [name, style] of styles) {
      for (const gloss of [false, true]) {
        if (outlineReadsClearedDepth(style, gloss)) {
          cleared.push(`${name}${gloss ? " with gloss" : ""}`);
        }
      }
    }
    assert.deepEqual(cleared, []);
  } finally {
    globals.Image = previousImage;
  }
});

test("edge and gloss composites keep the depth texture of their target", () => {
  const renderer = new TraceRenderer();
  const world = createWorld();
  const composites = {
    edge: new EdgeDetectionPass(
      { three: renderer, currentWorld: world } as any,
      { initialized: false } as any,
    ),
    gloss: new GlossPass(new THREE.Vector2(8, 8), world as any),
  };
  for (const [name, pass] of Object.entries(composites)) {
    const target = () =>
      new THREE.WebGLRenderTarget(8, 8, {
        depthTexture: new THREE.DepthTexture(8, 8),
      });
    const writeBuffer = target();
    const readBuffer = target();

    pass.render(renderer as any, writeBuffer, readBuffer);

    assert.equal(
      renderer.depthClears.get(writeBuffer.depthTexture!),
      undefined,
      name,
    );
    assert.equal(renderer.autoClear, true, `${name}: autoClear restored`);
    pass.dispose();
    writeBuffer.dispose();
    readBuffer.dispose();
  }
});
