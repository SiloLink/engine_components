import * as THREE from "three";
import { Pass } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Captures the regular scene depth without changing the PEN color input.
 */
export class SceneDepthPass extends Pass {
  scene: THREE.Scene;
  camera: THREE.Camera;

  private readonly _onSceneDepthRendered: (
    depthTexture: THREE.DepthTexture | null,
  ) => void;
  private readonly _clearColor = new THREE.Color(0xffffff);
  private readonly _previousClearColor = new THREE.Color();

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    onSceneDepthRendered: (depthTexture: THREE.DepthTexture | null) => void,
  ) {
    super();
    this.scene = scene;
    this.camera = camera;
    this._onSceneDepthRendered = onSceneDepthRendered;
    this.needsSwap = false;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ) {
    const previousAutoClear = renderer.autoClear;
    const previousClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this._previousClearColor);

    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(readBuffer);
      renderer.clear(false, true, false);
      renderer.render(this.scene, this.camera);
      this._onSceneDepthRendered(readBuffer.depthTexture);

      // PEN starts from an opaque white buffer. Restore that color after the
      // regular scene render while retaining its unbiased depth attachment.
      renderer.setClearColor(this._clearColor, 1);
      renderer.clear(true, false, false);
    } finally {
      renderer.autoClear = previousAutoClear;
      renderer.setClearColor(this._previousClearColor, previousClearAlpha);
    }
  }
}
