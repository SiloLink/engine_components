import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BasePass } from "../src/core/PostproductionRenderer/src/base-pass";

test("BasePass composes base-only objects before publishing scene depth", () => {
  const order: string[] = [];
  const main = new THREE.Scene();
  const baseOnly = new THREE.Group();
  baseOnly.add(new THREE.Object3D());
  const camera = new THREE.PerspectiveCamera();
  const excluded = new THREE.MeshBasicMaterial();
  const alreadyHidden = new THREE.MeshBasicMaterial();
  alreadyHidden.visible = false;
  const pass = new BasePass(main, camera, null, null, null, () => {
    order.push("depth");
  });
  pass.excludedMaterials.add(excluded);
  pass.excludedMaterials.add(alreadyHidden);
  pass.addBaseOnlyObject(baseOnly, () => order.push("sync"));

  const renderer = {
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    getClearColor: () => undefined,
    getClearAlpha: () => 1,
    setClearColor: () => undefined,
    setClearAlpha: () => undefined,
    clearDepth: () => undefined,
    setRenderTarget: () => undefined,
    clear: () => undefined,
    render: (scene: THREE.Scene) => {
      assert.equal(scene.getObjectById(baseOnly.id), baseOnly);
      order.push(`main:${excluded.visible}/${alreadyHidden.visible}`);
    },
  };
  const readBuffer = { depthTexture: new THREE.DepthTexture() };

  pass.render(renderer as never, {} as never, readBuffer as never);

  assert.deepEqual(order, ["sync", "main:false/false", "depth"]);
  assert.equal(excluded.visible, true);
  assert.equal(alreadyHidden.visible, false);
  assert.equal(main.children.includes(baseOnly), false);

  baseOnly.clear();
  order.length = 0;
  pass.render(renderer as never, {} as never, readBuffer as never);
  assert.deepEqual(order, ["sync", "main:false/false", "depth"]);
  assert.equal(excluded.visible, true);
  assert.equal(alreadyHidden.visible, false);
  excluded.dispose();
  alreadyHidden.dispose();
});

test("BasePass renders base-only source materials with the main scene shading context", () => {
  const main = new THREE.Scene();
  const environment = new THREE.Texture();
  const fog = new THREE.Fog(0x112233, 1, 100);
  const light = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
  main.environment = environment;
  main.environmentIntensity = 0.75;
  main.environmentRotation.set(0.1, 0.2, 0.3);
  main.fog = fog;
  main.add(light);

  const baseOnly = new THREE.Group();
  const material = new THREE.MeshStandardMaterial();
  const proxy = new THREE.Mesh(new THREE.BufferGeometry(), material);
  baseOnly.add(proxy);
  const pass = new BasePass(
    main,
    new THREE.PerspectiveCamera(),
    null,
    null,
    null,
    () => undefined,
  );
  pass.addBaseOnlyObject(baseOnly);

  let observedProxy = false;
  const renderer = {
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    getClearColor: () => undefined,
    getClearAlpha: () => 1,
    setClearColor: () => undefined,
    setClearAlpha: () => undefined,
    clearDepth: () => undefined,
    setRenderTarget: () => undefined,
    clear: () => undefined,
    render: (scene: THREE.Scene) => {
      if (!scene.getObjectById(proxy.id)) return;
      observedProxy = true;
      assert.equal(scene.environment, environment);
      assert.equal(scene.environmentIntensity, main.environmentIntensity);
      assert.deepEqual(scene.environmentRotation, main.environmentRotation);
      assert.equal(scene.fog, fog);
      let hasVisibleLight = false;
      scene.traverse((object) => {
        if ((object as THREE.Light).isLight && object.visible) {
          hasVisibleLight = true;
        }
      });
      assert.equal(hasVisibleLight, true);
    },
  };

  pass.render(renderer as never, {} as never, {} as never);

  assert.equal(observedProxy, true);
  assert.equal(baseOnly.parent, null);
  material.dispose();
  proxy.geometry.dispose();
  environment.dispose();
});

test("BasePass restores excluded material visibility when main rendering fails", () => {
  const excluded = new THREE.MeshBasicMaterial();
  const baseOnly = new THREE.Group();
  baseOnly.add(new THREE.Object3D());
  const pass = new BasePass(
    new THREE.Scene(),
    new THREE.PerspectiveCamera(),
    null,
    null,
    null,
    () => undefined,
  );
  pass.excludedMaterials.add(excluded);
  pass.addBaseOnlyObject(baseOnly);
  const renderer = {
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    getClearColor: () => undefined,
    getClearAlpha: () => 1,
    setClearColor: () => undefined,
    setClearAlpha: () => undefined,
    clearDepth: () => undefined,
    setRenderTarget: () => undefined,
    clear: () => undefined,
    render: () => {
      assert.equal(excluded.visible, false);
      throw new Error("render failed");
    },
  };

  assert.throws(
    () => pass.render(renderer as never, {} as never, {} as never),
    /render failed/,
  );
  assert.equal(excluded.visible, true);
  assert.equal(baseOnly.parent, null);
  excluded.dispose();
});
