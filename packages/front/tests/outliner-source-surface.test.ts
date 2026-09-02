import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DataSet } from "@thatopen/fragments";
import { Highlighter } from "../src/fragments/Highlighter";
import { Outliner } from "../src/fragments/Outliner";
import { SimpleOutlinePass } from "../src/core/PostproductionRenderer/src/simple-outline-pass";

function createPass() {
  const world = { camera: { three: new THREE.PerspectiveCamera() } };
  return new SimpleOutlinePass(64, 64, world as never, () => null, false);
}

test("source-material surfaces preserve source groups without a zero-style mask", () => {
  const pass = createPass();
  pass.addGroup("focus", {
    surfaceMode: "source-material",
    thickness: 0,
    fillOpacity: 0,
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(new Float32Array(18), 3),
  );
  geometry.setIndex(new THREE.Uint16BufferAttribute([0, 1, 2, 3, 4, 5], 1));
  geometry.addGroup(0, 3, 0);
  geometry.addGroup(3, 3, 1);
  const red = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const blue = new THREE.MeshBasicMaterial({ color: 0x0000ff });
  const tile = new THREE.Mesh(geometry, [red, blue]);

  pass.attachOutlinedTile(
    tile,
    { position: new Uint32Array([1]), size: new Uint32Array([4]) },
    "focus",
  );

  const mask = pass.getGroupContainer("focus").children[0] as THREE.Mesh;
  assert.equal(mask.visible, false);

  const sourceContainer = pass.sourceSurfaceRoot.children[0];
  const source = sourceContainer.children[0] as THREE.Mesh;
  assert.equal(source.geometry.attributes, geometry.attributes);
  assert.equal(source.geometry.index, geometry.index);
  assert.deepEqual(source.geometry.groups, [
    { start: 1, count: 2, materialIndex: 0 },
    { start: 3, count: 2, materialIndex: 1 },
  ]);
  const cloned = source.material as THREE.Material[];
  assert.equal(cloned.length, 2);
  assert.notEqual(cloned[0], red);
  assert.notEqual(cloned[1], blue);
  assert.deepEqual((cloned[0] as THREE.MeshBasicMaterial).color, red.color);
  assert.deepEqual((cloned[1] as THREE.MeshBasicMaterial).color, blue.color);

  pass.dispose();
  red.dispose();
  blue.dispose();
});

test("source-material surfaces refresh current groups and material clones", () => {
  const pass = createPass();
  pass.addGroup("focus", { surfaceMode: "source-material" });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(new Float32Array(18), 3),
  );
  geometry.setIndex(new THREE.Uint16BufferAttribute([0, 1, 2, 3, 4, 5], 1));
  geometry.addGroup(0, 6, 0);
  const first = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const second = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
  const tile = new THREE.Mesh(geometry, [first]);
  pass.attachOutlinedTile(tile, { position: [0], size: [6] }, "focus");

  geometry.clearGroups();
  geometry.addGroup(2, 2, 0);
  tile.material = [second];
  pass.refreshOutlinedTile(tile, "focus");

  const sourceContainer = pass.sourceSurfaceRoot.children[0];
  const source = sourceContainer.children[0] as THREE.Mesh;
  assert.deepEqual(source.geometry.groups, [
    { start: 2, count: 2, materialIndex: 0 },
  ]);
  assert.deepEqual(
    (
      (
        source.material as THREE.MeshBasicMaterial[]
      )[0] as THREE.MeshBasicMaterial
    ).color,
    second.color,
  );

  pass.configureGroup("focus", { surfaceMode: "none" });
  assert.equal(pass.sourceSurfaceRoot.children.length, 0);
  pass.configureGroup("focus", { surfaceMode: "source-material" });
  assert.equal(pass.sourceSurfaceRoot.children.length, 1);

  pass.detachOutlinedTile(tile, "focus");
  assert.equal(sourceContainer.children.length, 0);
  assert.equal(pass.sourceSurfaceRoot.children.length, 0);
  pass.dispose();
  first.dispose();
  second.dispose();
});

test("getPickCandidates returns defensive, coalesced committed ranges", () => {
  const styles = new DataSet<string>();
  const highlighter = { styles, events: {}, selection: {} };
  const components = {
    add: () => undefined,
    get: (component: unknown) => {
      if (component === Highlighter) return highlighter;
      throw new Error("Unexpected component lookup");
    },
  };
  const outliner = new Outliner(components as never);
  outliner.create("a");
  outliner.create("b");
  const tile = new THREE.Mesh();
  const groups = (
    outliner as unknown as {
      _groups: Map<
        string,
        {
          resolved: Map<
            string,
            Map<THREE.Mesh, readonly { start: number; count: number }[]>
          >;
        }
      >;
    }
  )._groups;
  groups.get("a")!.resolved = new Map([
    [
      "model",
      new Map([
        [
          tile,
          [
            { start: 0, count: 3 },
            { start: 2, count: 4 },
            { start: 6, count: 2 },
          ],
        ],
      ]),
    ],
  ]);
  groups.get("b")!.resolved = new Map([
    ["model", new Map([[tile, [{ start: 10, count: Infinity }]]])],
  ]);

  const first = outliner.getPickCandidates(["a", "b"]);
  assert.deepEqual(first.get("model")!.get(tile), [
    { start: 0, count: 8 },
    { start: 10, count: Infinity },
  ]);
  (
    first.get("model")!.get(tile) as { start: number; count: number }[]
  )[0].start = 99;

  const second = outliner.getPickCandidates(["a", "b"]);
  assert.notEqual(second, first);
  assert.deepEqual(second.get("model")!.get(tile)![0], {
    start: 0,
    count: 8,
  });
  assert.equal(outliner.getPickCandidates(["missing"]).size, 0);
});
