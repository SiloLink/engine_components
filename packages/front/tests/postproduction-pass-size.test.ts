import assert from "node:assert/strict";
import test from "node:test";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import {
  Postproduction,
  PostproductionAspect,
} from "../src/core/PostproductionRenderer/src";

/** A pass that keeps the size it was given, as the official passes do. */
function sizedPass() {
  return {
    enabled: true,
    width: 0,
    height: 0,
    setSize(width: number, height: number) {
      this.width = width;
      this.height = height;
    },
  };
}

/** Postproduction on a composer at pixel ratio 2, with recording passes. */
function createPostproduction() {
  const renderer = {
    getPixelRatio: () => 2,
    getSize: (target: { set(x: number, y: number): unknown }) =>
      target.set(800, 600),
    setClearColor() {},
    setRenderTarget() {},
    clear() {},
  };
  const postproduction = new Postproduction(
    {} as any,
    { three: renderer } as any,
  );
  const internals = postproduction as any;
  internals.composer = new EffectComposer(renderer as any);
  for (const key of [
    "_basePass",
    "_aoPass",
    "_outputPass",
    "_edgeDetectionPass",
    "_smaaPass",
    "_simpleOutlinePass",
    "_excludedObjectsPass",
    "_glossPass",
  ]) {
    internals[key] = sizedPass();
  }
  internals._initialized = true;
  return {
    postproduction,
    outline: internals._simpleOutlinePass,
    excluded: internals._excludedObjectsPass,
  };
}

test("passes keep device pixels whether resized or rebuilt", () => {
  const { postproduction, outline, excluded } = createPostproduction();
  const size = (pass: { width: number; height: number }) => [
    pass.width,
    pass.height,
  ];

  // A selection adds the outline pass, which the composer sizes.
  postproduction.outlinesEnabled = true;
  assert.deepEqual(size(outline), [1600, 1200]);

  // A resize names CSS pixels; every pass gets the composer's device size.
  postproduction.setSize(800, 600);
  assert.deepEqual(size(postproduction.composer!.renderTarget1), [1600, 1200]);
  assert.deepEqual(size(outline), [1600, 1200]);
  assert.deepEqual(size(excluded), [1600, 1200]);

  // Showing edges rebuilds the passes at the same resolution.
  postproduction.style = PostproductionAspect.COLOR_PEN;
  assert.deepEqual(size(outline), [1600, 1200]);
});
