import * as THREE from "three";
import { Pass } from "three/examples/jsm/postprocessing/Pass.js";

interface BaseOnlyObject {
  object: THREE.Object3D;
  beforeRender?: () => void;
}

// Copied from three.js RenderPass.js, extended to allow for material override
// useful to exclude lod materials
export class BasePass extends Pass {
  scene: THREE.Scene;
  camera: THREE.Camera;
  overrideMaterial: THREE.Material | null;
  clearColor: THREE.Color | null;
  clearAlpha: number | null;
  clearDepth: boolean;
  needsSwap: boolean;

  isolatedMaterials: THREE.Material[] = [];

  /**
   * Materials hidden only while the main scene is rendered by this pass.
   * Their exact visibility is restored before every later composer pass.
   */
  excludedMaterials = new Set<THREE.Material>();

  /** Objects rendered only in the unbiased base pass. They are attached to
   * the main scene for that render so source materials use the world's real
   * lights, environment, and fog, then detached before later scene passes.
   */
  private readonly _baseOnlyObjects = new Map<THREE.Object3D, BaseOnlyObject>();

  private _oldClearColor: THREE.Color;
  private _onSceneDepthRendered: (
    depthTexture: THREE.DepthTexture | null,
  ) => void;

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    overrideMaterial = null,
    clearColor = null,
    clearAlpha = null,
    onSceneDepthRendered: (depthTexture: THREE.DepthTexture | null) => void,
  ) {
    super();

    this.scene = scene;

    this.camera = camera;

    this.overrideMaterial = overrideMaterial;

    this.clearColor = clearColor;

    this.clearAlpha = clearAlpha;

    this.clear = true;

    this.clearDepth = false;
    this._onSceneDepthRendered = onSceneDepthRendered;

    this.needsSwap = false;
    this._oldClearColor = new THREE.Color();
  }

  addBaseOnlyObject(object: THREE.Object3D, beforeRender?: () => void) {
    if (object.parent) {
      throw new Error(
        "Base-only objects must remain detached between renders.",
      );
    }
    this._baseOnlyObjects.set(object, { object, beforeRender });
  }

  removeBaseOnlyObject(object: THREE.Object3D) {
    this._baseOnlyObjects.delete(object);
    object.removeFromParent();
  }

  render(
    renderer: THREE.WebGLRenderer,
    // @ts-ignore
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    /* , deltaTime, maskActive */
  ) {
    for (const material of this.isolatedMaterials) {
      if (material.userData.wasVisibleBasePass !== undefined) {
        material.visible = material.userData.wasVisibleBasePass;
      }
    }

    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    let oldClearAlpha;
    let oldOverrideMaterial;

    if (this.overrideMaterial !== null) {
      oldOverrideMaterial = this.scene.overrideMaterial;

      this.scene.overrideMaterial = this.overrideMaterial;
    }

    if (this.clearColor !== null) {
      renderer.getClearColor(this._oldClearColor);
      renderer.setClearColor(this.clearColor, renderer.getClearAlpha());
    }

    if (this.clearAlpha !== null) {
      oldClearAlpha = renderer.getClearAlpha();
      renderer.setClearAlpha(this.clearAlpha);
    }

    if (this.clearDepth === true) {
      renderer.clearDepth();
    }

    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);

    if (this.clear === true) {
      // TODO: Avoid using autoClear properties, see https://github.com/mrdoob/three.js/pull/15571#issuecomment-465669600
      renderer.clear(
        renderer.autoClearColor,
        renderer.autoClearDepth,
        renderer.autoClearStencil,
      );
    }

    const attachedBaseOnlyObjects: THREE.Object3D[] = [];
    const excludedVisibility = new Map<THREE.Material, boolean>();
    try {
      for (const entry of this._baseOnlyObjects.values()) {
        entry.beforeRender?.();
        if (entry.object.parent) {
          throw new Error(
            "Base-only objects must remain detached between renders.",
          );
        }
        this.scene.add(entry.object);
        attachedBaseOnlyObjects.push(entry.object);
      }
      for (const material of this.excludedMaterials) {
        excludedVisibility.set(material, material.visible);
        material.visible = false;
      }
      renderer.render(this.scene, this.camera);
    } finally {
      for (const [material, visible] of excludedVisibility) {
        material.visible = visible;
      }
      for (const object of attachedBaseOnlyObjects) object.removeFromParent();
    }
    this._onSceneDepthRendered(readBuffer.depthTexture);

    // restore

    if (this.clearColor !== null) {
      renderer.setClearColor(this._oldClearColor);
    }

    if (this.clearAlpha !== null) {
      // @ts-ignore
      renderer.setClearAlpha(oldClearAlpha);
    }

    if (this.overrideMaterial !== null) {
      // @ts-ignore
      this.scene.overrideMaterial = oldOverrideMaterial;
    }

    renderer.autoClear = oldAutoClear;

    for (const material of this.isolatedMaterials) {
      material.userData.wasVisibleBasePass = material.visible;
      material.visible = false;
    }
  }
}
