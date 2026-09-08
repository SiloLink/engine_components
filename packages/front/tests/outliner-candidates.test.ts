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

test("zero-style groups keep their resolved mask geometry dormant", () => {
  const pass = createPass();
  pass.addGroup("focus", { thickness: 0, fillOpacity: 0 });
  const geometry = new THREE.BoxGeometry();
  const tile = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  pass.attachOutlinedTile(tile, { position: [0], size: [6] }, "focus");
  const mask = pass.getGroupContainer("focus").children[0] as THREE.Mesh;
  assert.equal(mask.visible, false);
  assert.equal(mask.geometry.attributes, geometry.attributes);
  assert.deepEqual(mask.geometry.groups, [
    { start: 0, count: 6, materialIndex: 0 },
  ]);
  pass.configureGroup("focus", { thickness: 2 });
  assert.equal(mask.visible, true);
  pass.configureGroup("focus", { thickness: 0 });
  assert.equal(mask.visible, false);
  pass.dispose();
  geometry.dispose();
  tile.material.dispose();
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
