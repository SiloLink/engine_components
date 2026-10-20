import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as OBC from "@thatopen/components";

test("the components core is a peer that installers resolve once", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(pkg.dependencies?.["@thatopen/components"], undefined);
  assert.ok(pkg.peerDependencies["@thatopen/components"]);
  assert.ok(pkg.devDependencies["@thatopen/components"]);
});

for (const file of ["index.js", "index.min.js"]) {
  test(`${file} shares the application's core component and renderer classes`, async () => {
    const front = await import(new URL(`../dist/${file}`, import.meta.url));

    assert.ok(front.Outliner.prototype instanceof OBC.Component);
    assert.ok(front.Highlighter.prototype instanceof OBC.Component);
    assert.ok(
      front.PostproductionRenderer.prototype instanceof OBC.SimpleRenderer,
    );
  });
}
