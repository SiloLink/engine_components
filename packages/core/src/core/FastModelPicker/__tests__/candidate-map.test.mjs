import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { FastModelPicker } from "../../../../dist/index.mjs";

const PICK_POSITION = new THREE.Vector2(0.25, -0.5);
const CANDIDATE_RANGES = [
  { start: 3, count: 6 },
  { start: 15, count: 9 },
];

function makeShell({ visible = true, groups = [] } = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("id", new THREE.Uint32BufferAttribute([1, 1, 1], 1));
  geometry.groups = groups.map((group) => ({ ...group }));
  const material = [
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
  ];
  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = visible;
  return mesh;
}

function makeRenderer() {
  let renderTarget = { name: "original-target" };
  let clearColor = new THREE.Color(0x123456);
  let clearAlpha = 0.5;
  let scissorTest = true;
  let scissor = new THREE.Vector4(1, 2, 3, 4);

  return {
    autoClear: true,
    clippingPlanes: [],
    info: { render: { calls: 4, triangles: 12 } },
    onRender: undefined,
    getRenderTarget: () => renderTarget,
    setRenderTarget: (next) => {
      renderTarget = next;
    },
    getClearColor: (target) => target.copy(clearColor),
    getClearAlpha: () => clearAlpha,
    setClearColor: (nextColor, nextAlpha = 1) => {
      clearColor = new THREE.Color(nextColor);
      clearAlpha = nextAlpha;
    },
    getScissorTest: () => scissorTest,
    setScissorTest: (next) => {
      scissorTest = next;
    },
    getScissor: (target) => target.copy(scissor),
    setScissor: (next) => {
      scissor = next.clone();
    },
    clear: () => undefined,
    render(scene, camera) {
      this.onRender?.(scene, camera);
    },
  };
}

function createHarness() {
  const candidate = makeShell({
    visible: false,
    groups: [{ start: 0, count: 30 }],
  });
  const context = makeShell({
    groups: [{ start: 0, count: 42, materialIndex: 2 }],
  });
  const lod = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  );
  const other = makeShell({
    groups: [{ start: 0, count: 18, materialIndex: 1 }],
  });
  const external = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  );

  const modelRoot = new THREE.Group();
  modelRoot.add(candidate, context, lod);
  const otherRoot = new THREE.Group();
  otherRoot.add(other);
  const scene = new THREE.Scene();
  scene.add(modelRoot, otherRoot, external);

  const model = {
    object: modelRoot,
    tiles: new Map([
      [1, candidate],
      [2, context],
      [3, lod],
    ]),
    getLocalIdsFromItemIds: async ([itemId]) => [itemId + 100],
  };
  const otherModel = {
    object: otherRoot,
    tiles: new Map([[4, other]]),
    getLocalIdsFromItemIds: async ([itemId]) => [itemId + 200],
  };
  const fragments = {
    initialized: true,
    list: new Map([
      ["candidate-model", model],
      ["other-model", otherModel],
    ]),
  };
  const renderer = makeRenderer();
  const camera = new THREE.PerspectiveCamera();
  const idMaterial = new THREE.ShaderMaterial({
    uniforms: { modelIndex: { value: 1 } },
  });
  const depthMaterial = new THREE.ShaderMaterial();
  const normalMaterial = new THREE.ShaderMaterial();
  const picker = Object.assign(Object.create(FastModelPicker.prototype), {
    enabled: true,
    debugMode: false,
    components: { get: () => fragments },
    world: {
      renderer: { three: renderer },
      scene: { three: scene },
      camera: { three: camera },
    },
    mouse: { position: new THREE.Vector2() },
    _renderTarget: { width: 4, height: 4 },
    _identityRenderTarget: { width: 4, height: 4 },
    _identityModelRoots: new Set(),
    _idMaterial: idMaterial,
    _idMaterials: [],
    _depthMaterial: depthMaterial,
    _normalMaterial: normalMaterial,
    _materialArrays: new Map(),
    _originalMaterials: new Map(),
    _originalVisibility: new Map(),
    _originalGroups: new Map(),
  });
  picker.createPickView = () => ({ camera, readX: 0, readY: 0 });
  picker.readIdentityPixelAt = () => new Uint32Array([1, 8, 0, 1]);
  picker.readPixelAt = () => new Uint8Array(4);

  const candidates = new Map([
    [
      "candidate-model",
      new Map([[candidate, CANDIDATE_RANGES.map((range) => ({ ...range }))]]),
    ],
  ]);
  const original = {
    visibility: new Map([
      [candidate, candidate.visible],
      [context, context.visible],
      [lod, lod.visible],
      [modelRoot, modelRoot.visible],
      [other, other.visible],
      [otherRoot, otherRoot.visible],
      [external, external.visible],
    ]),
    materials: new Map([
      [candidate, candidate.material],
      [context, context.material],
      [other, other.material],
    ]),
    groups: new Map([
      [candidate, candidate.geometry.groups.map((group) => ({ ...group }))],
      [context, context.geometry.groups.map((group) => ({ ...group }))],
      [other, other.geometry.groups.map((group) => ({ ...group }))],
    ]),
  };

  return {
    picker,
    renderer,
    fragments,
    candidates,
    candidate,
    context,
    lod,
    modelRoot,
    other,
    otherRoot,
    external,
    idMaterial,
    depthMaterial,
    normalMaterial,
    original,
  };
}

function assertCandidatePassState(harness, material) {
  assert.equal(harness.candidate.visible, true);
  assert.deepEqual(
    harness.candidate.geometry.groups,
    CANDIDATE_RANGES.map(({ start, count }) => ({
      start,
      count,
      materialIndex: 0,
    })),
  );
  assert.ok(Array.isArray(harness.candidate.material));
  assert.deepEqual(harness.candidate.material, [material]);

  assert.equal(harness.context.visible, false);
  assert.equal(harness.lod.visible, false);
  assert.equal(harness.modelRoot.visible, true);
  assert.equal(harness.otherRoot.visible, false);
  assert.equal(harness.external.visible, false);
}

function assertSourceStateRestored(harness) {
  for (const [object, visible] of harness.original.visibility) {
    assert.equal(object.visible, visible);
  }
  for (const [mesh, material] of harness.original.materials) {
    assert.equal(mesh.material, material);
  }
  for (const [mesh, groups] of harness.original.groups) {
    assert.deepEqual(mesh.geometry.groups, groups);
  }
}

test("undefined candidates preserve unrestricted picker behavior", () => {
  const harness = createHarness();
  let renders = 0;
  harness.renderer.onRender = () => {
    renders += 1;
    assert.equal(harness.candidate.visible, false);
    assert.equal(harness.context.visible, true);
    assert.deepEqual(harness.context.material, [
      harness.depthMaterial,
      harness.depthMaterial,
      harness.depthMaterial,
    ]);
    assert.equal(harness.other.visible, true);
    assert.deepEqual(harness.other.material, [
      harness.depthMaterial,
      harness.depthMaterial,
      harness.depthMaterial,
    ]);
    assert.equal(harness.lod.visible, false);
    assert.equal(harness.otherRoot.visible, true);
    assert.equal(harness.external.visible, false);
  };

  assert.equal(harness.picker.getPointAtSync(PICK_POSITION), null);
  assert.equal(renders, 1);
  assertSourceStateRestored(harness);
});

test("an empty candidate map is restrictive", async () => {
  const identityHarness = createHarness();
  let identityRenders = 0;
  identityHarness.renderer.onRender = () => {
    identityRenders += 1;
  };

  assert.equal(
    await identityHarness.picker.getModelAt(PICK_POSITION, new Map()),
    null,
  );
  assert.equal(identityRenders, 0);
  assertSourceStateRestored(identityHarness);

  const depthHarness = createHarness();
  let depthRenders = 0;
  depthHarness.renderer.onRender = () => {
    depthRenders += 1;
    assert.equal(depthHarness.modelRoot.visible, false);
    assert.equal(depthHarness.otherRoot.visible, false);
    assert.equal(depthHarness.external.visible, false);
  };

  assert.equal(
    depthHarness.picker.getPointAtSync(PICK_POSITION, new Map()),
    null,
  );
  assert.equal(depthRenders, 1);
  assertSourceStateRestored(depthHarness);
});

test("identity, depth, and normal passes render only candidate ranges", async () => {
  for (const { name, material, pick } of [
    {
      name: "identity",
      material: "idMaterial",
      pick: (harness) =>
        harness.picker.getModelAt(PICK_POSITION, harness.candidates),
    },
    {
      name: "depth",
      material: "depthMaterial",
      pick: (harness) =>
        harness.picker.getPointAtSync(PICK_POSITION, harness.candidates),
    },
    {
      name: "normal",
      material: "normalMaterial",
      pick: (harness) =>
        harness.picker.getNormalAt(PICK_POSITION, harness.candidates),
    },
  ]) {
    const harness = createHarness();
    let renders = 0;
    harness.renderer.onRender = () => {
      renders += 1;
      assertCandidatePassState(harness, harness[material]);
    };

    await pick(harness);
    assert.equal(renders, 1, `${name} should render exactly once`);
    assertSourceStateRestored(harness);
  }
});

test("candidate state is restored when identity or tile-material renders throw", async () => {
  for (const { name, pick } of [
    {
      name: "identity",
      pick: (harness) =>
        harness.picker.getModelAt(PICK_POSITION, harness.candidates),
    },
    {
      name: "depth",
      pick: (harness) =>
        harness.picker.getPointAtSync(PICK_POSITION, harness.candidates),
    },
  ]) {
    const harness = createHarness();
    harness.renderer.onRender = () => {
      assertCandidatePassState(
        harness,
        name === "identity" ? harness.idMaterial : harness.depthMaterial,
      );
      throw new Error(`${name} render failed`);
    };

    await assert.rejects(
      async () => pick(harness),
      new RegExp(`${name} render failed`),
    );
    assertSourceStateRestored(harness);
  }
});

test("all public pick methods forward the exact candidate map", async () => {
  const harness = createHarness();
  const { picker, candidates } = harness;
  const calls = [];
  picker.runIdPass = async (position, receivedCandidates) => {
    calls.push(["id", position, receivedCandidates]);
    return { modelId: "candidate-model", itemId: 7 };
  };

  assert.equal(
    await picker.getModelAt(PICK_POSITION, candidates),
    "candidate-model",
  );
  assert.deepEqual(await picker.getItemAt(PICK_POSITION, candidates), {
    modelId: "candidate-model",
    localId: 107,
    itemId: 7,
  });

  picker.renderDepthPass = (position, receivedCandidates) => {
    calls.push(["depth", position, receivedCandidates]);
    return { readX: 0, readY: 0 };
  };
  assert.equal(picker.getPointAtSync(PICK_POSITION, candidates), null);

  picker.getPointAtSync = (position, receivedCandidates) => {
    calls.push(["point", position, receivedCandidates]);
    return new THREE.Vector3(1, 2, 3);
  };
  assert.deepEqual(
    await picker.getPointAt(PICK_POSITION, candidates),
    new THREE.Vector3(1, 2, 3),
  );

  picker.renderNormalPass = (position, receivedCandidates) => {
    calls.push(["normal", position, receivedCandidates]);
    return { readX: 0, readY: 0 };
  };
  assert.equal(await picker.getNormalAt(PICK_POSITION, candidates), null);

  picker.getItemAt = async (position, receivedCandidates) => {
    calls.push(["full-item", position, receivedCandidates]);
    return { modelId: "candidate-model", localId: 107, itemId: 7 };
  };
  picker.getPointAt = async (position, receivedCandidates) => {
    calls.push(["full-point", position, receivedCandidates]);
    return new THREE.Vector3(1, 2, 3);
  };
  picker.getNormalAt = async (position, receivedCandidates) => {
    calls.push(["full-normal", position, receivedCandidates]);
    return new THREE.Vector3(0, 1, 0);
  };
  assert.ok(await picker.getFullPick(PICK_POSITION, candidates));

  assert.deepEqual(
    calls.map(([name, position, receivedCandidates]) => [
      name,
      position,
      receivedCandidates,
    ]),
    [
      ["id", PICK_POSITION, candidates],
      ["id", PICK_POSITION, candidates],
      ["depth", PICK_POSITION, candidates],
      ["point", PICK_POSITION, candidates],
      ["normal", PICK_POSITION, candidates],
      ["full-item", PICK_POSITION, candidates],
      ["full-point", PICK_POSITION, candidates],
      ["full-normal", PICK_POSITION, candidates],
    ],
  );
});
