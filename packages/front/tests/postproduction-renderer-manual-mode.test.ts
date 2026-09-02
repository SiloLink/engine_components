import assert from "node:assert/strict";
import test from "node:test";
import * as OBC from "@thatopen/components";
import * as THREE from "three";
import { PostproductionRenderer } from "../src/core/PostproductionRenderer";
import { PostproductionAspect } from "../src/core/PostproductionRenderer/src";

function createManualRenderer(options: {
  postproductionEnabled: boolean;
  postproductionStyle: PostproductionAspect;
  manualDefaultStyle: PostproductionAspect;
  turnOffOnManualMode: boolean;
}) {
  const nativeRenderCalls: string[] = [];
  const postproductionUpdateCalls: string[] = [];
  const postproduction = {
    enabled: options.postproductionEnabled,
    onStyleChanged: { enabled: true },
    style: options.postproductionStyle,
    update: () => postproductionUpdateCalls.push("update"),
  };
  const renderer = Object.assign(
    Object.create(PostproductionRenderer.prototype),
    {
      _postproduction: postproduction,
      _previousEnabled: false,
      _previousStyle: options.postproductionStyle,
      _timeout: undefined,
      currentWorld: {
        camera: { three: new THREE.PerspectiveCamera() },
        scene: { three: new THREE.Scene() },
      },
      enabled: true,
      manualDefaultStyle: options.manualDefaultStyle,
      manualModeDelay: 5,
      mode: OBC.RendererMode.MANUAL,
      needsUpdate: true,
      onAfterUpdate: { trigger: () => undefined },
      onBeforeUpdate: { trigger: () => undefined },
      three: { render: () => nativeRenderCalls.push("render") },
      turnOffOnManualMode: options.turnOffOnManualMode,
    },
  ) as PostproductionRenderer;

  return {
    nativeRenderCalls,
    postproduction,
    postproductionUpdateCalls,
    renderer,
  };
}

test("manual mode does not schedule a duplicate frame without a temporary state override", async () => {
  const { postproductionUpdateCalls, renderer } = createManualRenderer({
    postproductionEnabled: true,
    postproductionStyle: PostproductionAspect.COLOR,
    manualDefaultStyle: PostproductionAspect.COLOR,
    turnOffOnManualMode: false,
  });

  renderer.update();
  assert.equal(postproductionUpdateCalls.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(postproductionUpdateCalls.length, 1);
});

test("manual mode keeps the trailing frame when restoring a temporary state override", async () => {
  const {
    nativeRenderCalls,
    postproduction,
    postproductionUpdateCalls,
    renderer,
  } = createManualRenderer({
    postproductionEnabled: true,
    postproductionStyle: PostproductionAspect.COLOR,
    manualDefaultStyle: PostproductionAspect.COLOR,
    turnOffOnManualMode: true,
  });

  renderer.update();
  assert.equal(nativeRenderCalls.length, 1);
  assert.equal(postproductionUpdateCalls.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(postproduction.enabled, true);
  assert.equal(postproductionUpdateCalls.length, 1);
});
