import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { AOPass } from "./ao-pass";
import { EdgeDetectionPass } from "./edge-detection-pass";
import { SimpleOutlinePass } from "./simple-outline-pass";
import { ExcludedObjectsPass } from "./excluded-objects-pass";
import { PostproductionRenderer } from "..";
import { BasePass } from "./base-pass";
import { GlossPass } from "./gloss-pass";

// Export the GlossPass for external use
export { GlossPass };
export { AOPass } from "./ao-pass";
export { EdgeDetectionPassMode } from "./edge-detection-pass";

export enum PostproductionAspect {
  COLOR = 0,
  PEN = 1,
  PEN_SHADOWS = 2,
  COLOR_PEN = 3,
  COLOR_SHADOWS = 4,
  COLOR_PEN_SHADOWS = 5,
}

export class Postproduction {
  invisibleMaterials = new Set<THREE.Material>();
  composer?: EffectComposer;

  readonly onStyleChanged = new OBC.Event<PostproductionAspect>();

  private _enabled = false;
  private _initialized = false;

  private _basePass?: BasePass;
  private _aoPass?: AOPass;
  private _outputPass?: OutputPass;
  private _edgeDetectionPass?: EdgeDetectionPass;
  private _smaaPass?: SMAAPass;
  private _simpleOutlinePass?: SimpleOutlinePass;
  private _excludedObjectsPass?: ExcludedObjectsPass;
  private _glossPass?: GlossPass;
  private _style = PostproductionAspect.COLOR;
  private _outlinesEnabled = false;
  private _glossEnabled = false;
  private _smaaEnabled = false;
  private _excludedObjectsEnabled = false;
  private _msaaEnabled = false;
  private _components: OBC.Components;
  private _renderer: PostproductionRenderer;
  private _clearColor = new THREE.Color();

  defaultAoParameters = {
    radius: 0.25,
    distanceExponent: 5.7,
    thickness: 10,
    scale: 2,
    samples: 16,
    distanceFallOff: 1,
    screenSpaceRadius: true,
  };

  get basePass() {
    if (!this._basePass) {
      throw new Error("Base pass not initialized");
    }
    return this._basePass;
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
    if (value && !this._initialized) {
      this.initialize();
    }
    if (!value) {
      for (const material of this.basePass.isolatedMaterials) {
        material.visible = true;
      }
    }
  }

  get aoPass() {
    if (!this._aoPass) {
      throw new Error("AO pass not initialized");
    }
    return this._aoPass;
  }

  get outlinePass() {
    if (!this._simpleOutlinePass) {
      throw new Error("Outline pass not initialized");
    }
    return this._simpleOutlinePass;
  }

  get edgesPass() {
    if (!this._edgeDetectionPass) {
      throw new Error("Edge detection pass not initialized");
    }
    return this._edgeDetectionPass;
  }

  get excludedObjectsPass() {
    if (!this._excludedObjectsPass) {
      throw new Error("Excluded objects pass not initialized");
    }
    return this._excludedObjectsPass;
  }

  get glossPass() {
    if (!this._glossPass) {
      throw new Error("Gloss pass not initialized");
    }
    return this._glossPass;
  }

  get outlinesEnabled() {
    return this._outlinesEnabled;
  }

  set outlinesEnabled(value: boolean) {
    this._outlinesEnabled = value;
    this.style = this._style;
  }

  get excludedObjectsEnabled() {
    return this._excludedObjectsEnabled;
  }

  set excludedObjectsEnabled(value: boolean) {
    this._excludedObjectsEnabled = value;
    this.style = this._style;
  }

  get glossEnabled() {
    return this._glossEnabled;
  }

  set glossEnabled(value: boolean) {
    this._glossEnabled = value;
    this.style = this._style;
  }

  get smaaEnabled() {
    return this._smaaEnabled;
  }

  set smaaEnabled(value: boolean) {
    this._smaaEnabled = value;
    this.style = this._style;
  }

  /**
   * Whether the composer's render targets are multisampled. The composer
   * allocates them without multisampling, which drops the MSAA of the default
   * framebuffer the moment postproduction is switched on; turning this on
   * gives them back their samples. Off by default: multisampled targets cost
   * memory and bandwidth on every frame, so this is opt-in and, while off,
   * the targets are exactly the ones postproduction has always allocated.
   */
  get msaaEnabled() {
    return this._msaaEnabled;
  }

  set msaaEnabled(value: boolean) {
    this._msaaEnabled = value;
    this.applySamples();
  }

  get style() {
    return this._style;
  }

  set style(value: PostproductionAspect) {
    if (!this.composer) return;
    if (
      !this.composer ||
      !this._basePass ||
      !this._smaaPass ||
      !this._outputPass ||
      !this._aoPass ||
      !this._edgeDetectionPass ||
      !this._simpleOutlinePass ||
      !this._excludedObjectsPass ||
      !this._glossPass
    ) {
      return;
    }

    if (this._style === PostproductionAspect.PEN_SHADOWS) {
      this._aoPass.updateGtaoMaterial(this.defaultAoParameters);
    }

    this._style = value;
    this.clear();

    if (value === PostproductionAspect.COLOR) {
      this.composer.addPass(this._basePass);
      if (this._glossEnabled) {
        this.composer.addPass(this._glossPass);
      }
      if (this._outlinesEnabled) {
        this.composer.addPass(this._simpleOutlinePass);
      }
      if (this._excludedObjectsEnabled) {
        this.composer.addPass(this._excludedObjectsPass);
      }
      if (this._smaaEnabled) {
        this.composer.addPass(this._smaaPass);
      }
      this.composer.addPass(this._outputPass);
    }

    if (value === PostproductionAspect.PEN) {
      this.composer.addPass(this._edgeDetectionPass);
      if (this._outlinesEnabled) {
        this.composer.addPass(this._simpleOutlinePass);
      }
      if (this._excludedObjectsEnabled) {
        this.composer.addPass(this._excludedObjectsPass);
      }
      if (this._smaaEnabled) {
        this.composer.addPass(this._smaaPass);
      }
    }

    if (value === PostproductionAspect.PEN_SHADOWS) {
      this.composer.addPass(this._basePass);
      this.composer.addPass(this._aoPass);
      this._aoPass.output = GTAOPass.OUTPUT.AO;
      this.composer.addPass(this._edgeDetectionPass);
      if (this._outlinesEnabled) {
        this.composer.addPass(this._simpleOutlinePass);
      }
      if (this._excludedObjectsEnabled) {
        this.composer.addPass(this._excludedObjectsPass);
      }
      if (this._smaaEnabled) {
        this.composer.addPass(this._smaaPass);
      }
      this.composer.addPass(this._outputPass);
    }

    if (value === PostproductionAspect.COLOR_PEN) {
      this.composer.addPass(this._basePass);
      if (this._glossEnabled) {
        this.composer.addPass(this._glossPass);
      }
      this.composer.addPass(this._edgeDetectionPass);
      if (this._outlinesEnabled) {
        this.composer.addPass(this._simpleOutlinePass);
      }
      if (this._excludedObjectsEnabled) {
        this.composer.addPass(this._excludedObjectsPass);
      }
      if (this._smaaEnabled) {
        this.composer.addPass(this._smaaPass);
      }
      this.composer.addPass(this._outputPass);
    }

    if (value === PostproductionAspect.COLOR_SHADOWS) {
      this.composer.addPass(this._basePass);
      if (this._glossEnabled) {
        this.composer.addPass(this._glossPass);
      }
      this.composer.addPass(this._aoPass);
      this._aoPass.output = GTAOPass.OUTPUT.Default;
      if (this._outlinesEnabled) {
        this.composer.addPass(this._simpleOutlinePass);
      }
      if (this._excludedObjectsEnabled) {
        this.composer.addPass(this._excludedObjectsPass);
      }
      if (this._smaaEnabled) {
        this.composer.addPass(this._smaaPass);
      }
      this.composer.addPass(this._outputPass);
    }

    if (value === PostproductionAspect.COLOR_PEN_SHADOWS) {
      this.composer.addPass(this._basePass);
      if (this._glossEnabled) {
        this.composer.addPass(this._glossPass);
      }
      this.composer.addPass(this._aoPass);
      this._aoPass.output = GTAOPass.OUTPUT.Default;
      this.composer.addPass(this._edgeDetectionPass);
      if (this._outlinesEnabled) {
        this.composer.addPass(this._simpleOutlinePass);
      }
      if (this._excludedObjectsEnabled) {
        this.composer.addPass(this._excludedObjectsPass);
      }
      if (this._smaaEnabled) {
        this.composer.addPass(this._smaaPass);
      }
      this.composer.addPass(this._outputPass);
    }

    // A color render draws outline fills inside the scene so they blend like
    // the outlined geometry. Styles without one overlay them in the composite.
    const sceneFills =
      this._outlinesEnabled && this.composer.passes.includes(this._basePass);
    this._basePass.outlineFills = sceneFills ? this._simpleOutlinePass : null;
    this._simpleOutlinePass.compositeFill = !sceneFills;

    this.onStyleChanged.trigger(value);
  }

  constructor(components: OBC.Components, renderer: PostproductionRenderer) {
    this._components = components;
    this._renderer = renderer;
  }

  update() {
    if (!this.composer) return;
    for (const material of this.invisibleMaterials) {
      material.userData.wasVisibleForPostproduction = material.visible;
      material.visible = false;
    }
    const renderer = this._renderer.three;
    renderer.getClearColor(this._clearColor);
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0xffffff, 1);
    renderer.setRenderTarget(this.composer.renderTarget1);
    renderer.clear();
    renderer.setRenderTarget(this.composer.renderTarget2);
    renderer.clear();
    renderer.setRenderTarget(null);
    renderer.setClearColor(this._clearColor, prevClearAlpha);
    this.composer.render();
    for (const material of this.invisibleMaterials) {
      material.visible = material.userData.wasVisibleForPostproduction;
    }
  }

  dispose() {
    this.composer?.dispose();
    this._aoPass?.dispose();
    this._outputPass?.dispose();
    this._edgeDetectionPass?.dispose();
    this._smaaPass?.dispose();
    this._simpleOutlinePass?.dispose();
    this._excludedObjectsPass?.dispose();
    this._glossPass?.dispose();
  }

  /**
   * Sizes the composer and every pass in device pixels. Width and height are
   * CSS pixels, which the composer scales by its pixel ratio; the passes it
   * does not hold take the same device size, so a pass keeps its resolution
   * whether it was last sized here or when the composer added it.
   */
  setSize(width: number, height: number) {
    if (width === 0 || height === 0) {
      return;
    }
    if (!this.composer) {
      return;
    }
    this.composer.setSize(width, height);
    const { width: deviceWidth, height: deviceHeight } =
      this.composer.renderTarget1;
    if (this._simpleOutlinePass) {
      this._simpleOutlinePass.setSize(deviceWidth, deviceHeight);
    }
    if (this._excludedObjectsPass) {
      this._excludedObjectsPass.setSize(deviceWidth, deviceHeight);
    }
    if (this._glossPass) {
      this._glossPass.setSize(deviceWidth, deviceHeight);
    }
  }

  updateCamera() {
    const camera = this._renderer.currentWorld!.camera.three;
    if (this._basePass) {
      this._basePass.camera = camera;
    }
    if (this._aoPass) {
      this._aoPass.camera = camera;
    }
    if (this._glossPass) {
      this._glossPass.renderCamera = camera;
    }
  }

  clear() {
    if (!this.composer) return;
    const passes = [...this.composer.passes];
    for (const pass of passes) {
      this.composer.removePass(pass);
    }
    this._renderer.three.setClearColor(0x000000, 0);
    this._renderer.three.setRenderTarget(this.composer.renderTarget1);
    this._renderer.three.clear();
    this._renderer.three.setRenderTarget(this.composer.renderTarget2);
    this._renderer.three.clear();
    this._renderer.three.setRenderTarget(null);
  }

  /**
   * Sample count used when {@link Postproduction.msaaEnabled} is on. An
   * internal detail: 4 is the usual sweet spot and the hardware ceiling
   * clamps it anyway, so there is no reason to make callers pick a number.
   */
  private static readonly MSAA_SAMPLES = 4;

  private applySamples() {
    if (!this.composer) return;
    const max = this._renderer.three.capabilities.maxSamples;
    const wanted = this._msaaEnabled ? Postproduction.MSAA_SAMPLES : 0;
    const samples = Math.max(0, Math.min(wanted, max));
    const targets = [this.composer.renderTarget1, this.composer.renderTarget2];
    for (const target of targets) {
      if (target.samples === samples) continue;
      target.samples = samples;
      // the framebuffer is re-created with the new sample count on next use
      target.dispose();
    }
  }

  private initialize() {
    this._initialized = true;

    const scene = this._renderer.currentWorld!.scene.three as THREE.Scene;
    const camera = this._renderer.currentWorld!.camera.three;

    // Configure renderer for transparency
    this._renderer.three.setClearColor(0x000000, 0);

    const reversedDepth =
      (this._renderer.three.capabilities as { reversedDepthBuffer?: boolean })
        .reversedDepthBuffer === true;
    this.composer = new EffectComposer(this._renderer.three);
    // EffectComposer allocates its ping-pong targets with samples = 0, which
    // drops the MSAA of the default framebuffer as soon as postproduction is
    // on. With msaaEnabled off this is a no-op (the targets already have 0
    // samples); it is here so a world configured before initialize still gets
    // the samples it asked for.
    this.applySamples();

    const basePass = new BasePass(scene, camera, null, null, null);
    this._basePass = basePass;

    this._smaaPass = new SMAAPass();

    const fragmentsManager = this._components.get(OBC.FragmentsManager);

    this._aoPass = new AOPass(
      fragmentsManager,
      scene,
      camera,
      this._renderer.three.domElement.width,
      this._renderer.three.domElement.height,
    );
    this._aoPass.output = GTAOPass.OUTPUT.Default;
    this._edgeDetectionPass = new EdgeDetectionPass(
      this._renderer,
      fragmentsManager,
    );

    this._outputPass = new OutputPass();

    this._simpleOutlinePass = new SimpleOutlinePass(
      this._renderer.three.domElement.width,
      this._renderer.three.domElement.height,
      this._renderer.currentWorld!,
      reversedDepth,
    );

    this._excludedObjectsPass = new ExcludedObjectsPass(
      this._renderer,
      this._renderer.currentWorld!,
    );

    this._glossPass = new GlossPass(
      new THREE.Vector2(
        this._renderer.three.domElement.width,
        this._renderer.three.domElement.height,
      ),
      this._renderer.currentWorld!,
    );

    this.style = PostproductionAspect.COLOR;
  }
}
