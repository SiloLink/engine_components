import assert from "node:assert/strict";
import test from "node:test";
import * as OBC from "@thatopen/components";

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
