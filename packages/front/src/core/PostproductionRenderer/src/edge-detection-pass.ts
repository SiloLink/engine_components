import * as THREE from "three";
import {
  Pass,
  FullScreenQuad,
} from "three/examples/jsm/postprocessing/Pass.js";
import * as OBC from "@thatopen/components";

/**
 * The mode of the edge detection pass.
 */
export enum EdgeDetectionPassMode {
  /**
   * Looks good, including LODs, but less performant.
   */
  DEFAULT,
  /**
   * Doesn't include LODs, but much more performant.
   */
  GLOBAL,
}

export class EdgeDetectionPass extends Pass {
  private _edgeCompositeMaterial: THREE.ShaderMaterial;
  private _fsQuad: FullScreenQuad;
  private _vertexColorRenderTarget: THREE.WebGLRenderTarget;
  // @ts-ignore
  private _fragments: OBC.FragmentsManager;
  private _renderer: OBC.BaseRenderer;
  private _overrideMaterial: THREE.ShaderMaterial;
  // World-space (view-space) coplanar priority offset in scene units. Applied
  // toward the camera so higher-priority coplanar surfaces win the depth tie
  // without ever overrunning a real occluder farther than this distance.
  private _depthBiasStrength = 0.005;

  private _mode = EdgeDetectionPassMode.DEFAULT;

  /**
   * When enabled, invisible materials still produce edges,
   * giving an X-ray effect where hidden geometry is shown as outlines.
   */
  xray = false;

  get mode() {
    return this._mode;
  }

  set mode(value: EdgeDetectionPassMode) {
    this._mode = value;
  }

  get width() {
    return this._edgeCompositeMaterial.uniforms.width.value;
  }

  set width(value: number) {
    this._edgeCompositeMaterial.uniforms.width.value = value;
  }

  get color() {
    return this._edgeCompositeMaterial.uniforms.edgeColor.value;
  }

  set color(value: THREE.Color) {
    this._edgeCompositeMaterial.uniforms.edgeColor.value = value;
  }

  get depthBiasStrength() {
    return this._depthBiasStrength;
  }

  set depthBiasStrength(value: number) {
    this._depthBiasStrength = value;
    if (this._overrideMaterial) {
      this._overrideMaterial.uniforms.depthBiasStrength.value = value;
    }
  }

  constructor(
    renderer: OBC.BaseRenderer,
    fragments: OBC.FragmentsManager,
    width: number = 1,
  ) {
    super();

    this._renderer = renderer;
    this._fragments = fragments;

    // Create override material with depth bias based on vertex colors
    // Higher vertex colors will render on top (closer to camera)
    // The face-ID raster follows the renderer's clipping planes, so edges
    // stop at a section cut like the geometry they are detected on. The
    // renderer's list is edited in place; the material sees the current planes.
    this._overrideMaterial = new THREE.ShaderMaterial({
      clipping: true,
      clippingPlanes: renderer.clippingPlanes,
      side: THREE.DoubleSide,
      uniforms: {
        depthBiasStrength: { value: this._depthBiasStrength },
      },
      // Note: we don't use `vertexColors: true` or the three.js color_pars
      // / color_vertex includes here. In recent three.js versions those
      // includes declare `vColor` as vec4 when the geometry has a 4-channel
      // color attribute, which breaks the vec3 assignment below. Strict
      // GLSL validators (WebView2 / ANGLE) reject the implicit
      // vec3→vec4 conversion even though Chrome's validator tolerates it.
      // See engine_components#728. Declaring `color` and `vColor` manually
      // keeps types consistent across vertex and fragment shaders.
      vertexShader: `
        #include <common>
        #include <clipping_planes_pars_vertex>

        attribute vec3 color;
        varying vec3 vColor;
        uniform float depthBiasStrength;

        void main() {
          vColor = color;

          #include <begin_vertex>
          #include <project_vertex>

          // Coplanar priority, applied as a small WORLD-space nudge toward the
          // camera in view space (+Z is toward the camera), then re-projected.
          // A constant clip-space bias falls off ~1/d while the real depth gap
          // falls off ~1/d^2, so at distance it overran genuine occluders and
          // leaked their edges (#718). A view-space offset instead behaves like
          // a real epsilon separation: its projected depth gap scales like real
          // geometry, so it breaks coplanar ties at every distance without ever
          // pulling an occluder forward. Convention-independent (correct under
          // standard-Z and reversed-Z). mvPosition comes from <project_vertex>,
          // so instancing/batching are already applied.
          //
          // Two terms (mirrors beta's per-faceId band + hash, adapted to view
          // space): luminance priority so brighter surfaces render on top, plus
          // a deterministic per-colour hash so coplanar surfaces of EQUAL
          // priority still get a stable winner instead of z-fighting. The hash
          // is a fraction of the priority step, so priority still dominates.
          float priority = dot(color, vec3(0.299, 0.587, 0.114));
          float tie = fract(
            sin(dot(color, vec3(12.9898, 78.233, 37.719))) * 43758.5453
          );
          mvPosition.z += (priority + (tie - 0.5) * 0.25) * depthBiasStrength;
          gl_Position = projectionMatrix * mvPosition;

          #include <clipping_planes_vertex>
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        #include <clipping_planes_pars_fragment>

        void main() {
          #include <clipping_planes_fragment>
          gl_FragColor = vec4(vColor, 1.0);
        }
      `,
    });

    this._edgeCompositeMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tEdgeData: { value: null },
        width: { value: width },
        edgeColor: { value: new THREE.Color(0x888888) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tEdgeData;
        uniform float width;
        uniform vec3 edgeColor;
        varying vec2 vUv;

        void main() {
          vec2 texel = vec2(1.0 / float(textureSize(tEdgeData, 0).x), 1.0 / float(textureSize(tEdgeData, 0).y));
          vec2 offset = texel * width;

          vec4 center = texture2D(tEdgeData, vUv);
          vec4 right = texture2D(tEdgeData, vUv + vec2(offset.x, 0.0));
          vec4 up = texture2D(tEdgeData, vUv + vec2(0.0, offset.y));

          float diff = 0.0;
          diff += distance(center.rgb, right.rgb);
          diff += distance(center.rgb, up.rgb);
          vec4 color = texture2D(tDiffuse, vUv);
          float edge = step(0.0001, diff);
          gl_FragColor = mix(color, vec4(edgeColor, 1.0), edge);
        }
      `,
    });

    this._fsQuad = new FullScreenQuad(this._edgeCompositeMaterial);

    // When the renderer runs reversed-Z, give this pass a float32 depth
    // attachment so precision stays near-uniform across the range: the real
    // depth test then separates near-coplanar surfaces on its own, so coplanar
    // z-fighting is resolved structurally rather than by bias. On a standard-Z
    // renderer we keep the default integer depth (float32 there would actually
    // be worse at distance), so this is a no-op unless the consumer opted into
    // `reversedDepthBuffer`.
    const options: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    };
    const reversedZ =
      (this._renderer.three.capabilities as { reversedDepthBuffer?: boolean })
        .reversedDepthBuffer === true;
    if (reversedZ) {
      const depthTexture = new THREE.DepthTexture(1, 1);
      depthTexture.type = THREE.FloatType;
      options.depthTexture = depthTexture;
    }
    this._vertexColorRenderTarget = new THREE.WebGLRenderTarget(1, 1, options);
  }

  setSize(width: number, height: number) {
    this._vertexColorRenderTarget.setSize(width, height);
  }

  setWidth(width: number) {
    this._edgeCompositeMaterial.uniforms.width.value = width;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ) {
    const currentWorld = this._renderer.currentWorld as OBC.World;
    const scene = currentWorld!.scene.three as THREE.Scene;

    // Render vertex colors

    const currentScene = currentWorld.scene.three as THREE.Scene;
    const prevFog = currentScene.fog;
    const prevBackground = currentScene.background;
    currentScene.fog = null;
    currentScene.background = null;

    try {
      if (this._mode === EdgeDetectionPassMode.DEFAULT) {
        const previousMaterials = new Map<
          THREE.Mesh,
          THREE.Material | THREE.Material[]
        >();
        try {
          this.setMaterialToMesh(previousMaterials);
          renderer.setRenderTarget(this._vertexColorRenderTarget);
          renderer.render(scene, currentWorld!.camera.three);
        } finally {
          this.restoreMaterials(previousMaterials);
        }
      } else if (this._mode === EdgeDetectionPassMode.GLOBAL) {
        const previousOverrideMaterial = scene.overrideMaterial;
        scene.overrideMaterial = this._overrideMaterial;
        try {
          renderer.setRenderTarget(this._vertexColorRenderTarget);
          renderer.render(scene, currentWorld!.camera.three);
        } finally {
          scene.overrideMaterial = previousOverrideMaterial;
        }
      }
    } finally {
      currentScene.fog = prevFog;
      currentScene.background = prevBackground;
    }

    // Detect and composite edges in one fullscreen stage. The previous
    // two-stage path wrote a binary edge mask to a full-size intermediate
    // target only to sample it immediately in the combine shader.
    this._edgeCompositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this._edgeCompositeMaterial.uniforms.tEdgeData.value =
      this._vertexColorRenderTarget.texture;
    this._fsQuad.material = this._edgeCompositeMaterial;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
    }

    // The composite overwrites every pixel. Clearing the target first would
    // also clear its depth texture, which can be the captured scene depth
    // that later passes, such as the outline fill, test against.
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      this._fsQuad.render(renderer);
    } finally {
      renderer.autoClear = previousAutoClear;
    }
  }

  dispose() {
    this._edgeCompositeMaterial.dispose();
    this._overrideMaterial.dispose();
    this._fsQuad.dispose();
    this._vertexColorRenderTarget.dispose();
  }

  private setMaterialToMesh(
    previousMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]>,
  ) {
    if (!this._fragments.initialized) return;
    const overrideArrays = new Map<number, THREE.Material[]>();
    for (const [, model] of this._fragments.core.models.list) {
      for (const [, mesh] of model.tiles) {
        if ("isLODGeometry" in mesh.geometry) {
          continue;
        }

        const previousMaterial = mesh.material;
        previousMaterials.set(mesh, previousMaterial);
        // Fragments meshes are batched: each mesh has a material array
        // indexed by group `materialIndex`. Highlighted samples live in
        // groups whose materialIndex > 0 (pointing to the highlight
        // material slot). Replacing `mesh.material` with a length-1 array
        // leaves those groups resolving to `undefined`, so Three.js
        // silently skips them and they produce no edges — which is the
        // root of issue #707 (highlighted items look see-through under
        // outline styles).
        //
        // Mirror the original material array length so every group maps
        // to the override material. Arrays of the same length can be shared
        // during this render, avoiding per-mesh allocations without leaving
        // restoration state on the mesh after the pass completes.
        if (this.xray) {
          mesh.material = this._overrideMaterial;
        } else if (Array.isArray(previousMaterial)) {
          let overrideArray = overrideArrays.get(previousMaterial.length);
          if (!overrideArray) {
            overrideArray = new Array<THREE.Material>(
              previousMaterial.length,
            ).fill(this._overrideMaterial);
            overrideArrays.set(previousMaterial.length, overrideArray);
          }
          mesh.material = overrideArray;
        } else {
          mesh.material = [this._overrideMaterial];
        }
      }
    }
  }

  private restoreMaterials(
    previousMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]>,
  ) {
    for (const [mesh, material] of previousMaterials) {
      mesh.material = material;
      delete mesh.userData.edgePassPreviousMaterial;
      delete mesh.userData.edgePassOverrideArray;
    }
    previousMaterials.clear();
  }
}
