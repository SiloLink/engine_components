import assert from "node:assert/strict";
import test from "node:test";
import * as OBC from "@thatopen/components";
import { DataMap } from "@thatopen/fragments";
import * as THREE from "three";
import { Outliner } from "../src/fragments/Outliner";

type Chunk = {
  tileId: number;
  position: Uint32Array;
  size: Uint32Array;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function chunks(tileId = 1): Chunk[] {
  return [
    { tileId, position: new Uint32Array([0]), size: new Uint32Array([3]) },
  ];
}

function createModel() {
  const tiles = new DataMap<number, THREE.Mesh>();
  tiles.set(1, new THREE.Mesh());
  const calls: number[][] = [];
  const model = {
    tiles,
    onViewUpdated: new OBC.Event(),
    query: async (_ids: Iterable<number>): Promise<Chunk[]> => chunks(),
    getItemDrawChunks: (ids: Iterable<number>) => {
      calls.push([...ids]);
      return model.query(ids);
    },
  };
  return { model, calls };
}

function setup() {
  const components = new OBC.Components();
  const fragments = components.get(OBC.FragmentsManager);
  const models = new DataMap<string, ReturnType<typeof createModel>["model"]>();
  Object.defineProperty(fragments, "core", {
    get: () => ({ models: { list: models } }),
  });
  const attached = new Map<string, Set<THREE.Mesh>>();
  const pass = {
    addGroup: (name: string) => {
      if (!attached.has(name)) attached.set(name, new Set());
    },
    hasGroup: (name: string) => attached.has(name),
    attachOutlinedTile: (tile: THREE.Mesh, _chunks: unknown, name: string) => {
      attached.get(name)!.add(tile);
    },
    detachOutlinedTile: (tile: THREE.Mesh, name: string) => {
      attached.get(name)?.delete(tile);
    },
    removeGroup: (name: string) => attached.delete(name),
  };
  const outliner = new Outliner(components);
  outliner.world = {
    isDisposing: false,
    renderer: {
      postproduction: {
        outlinePass: pass,
        excludedObjectsPass: {
          addExcludedMaterial() {},
          removeExcludedMaterial() {},
        },
      },
    },
  } as never;
  return { outliner, models, attached };
}

test("deprecated update adds its map and a plain refresh keeps the selection", async () => {
  const { outliner, models } = setup();
  const a = createModel();
  models.set("a", a.model);
  await outliner.addItems({ a: new Set([1]) }, "selection");
  await outliner.update({ a: new Set([2]) }, "selection");
  await outliner.update(undefined, "selection");
  assert.deepEqual(a.calls, [[1], [1, 2], [1, 2]]);
});

test("a synchronous tile burst queries only the dirty model once per group", async () => {
  const { outliner, models } = setup();
  const a = createModel();
  const b = createModel();
  const c = createModel();
  models.set("a", a.model);
  models.set("b", b.model);
  models.set("c", c.model);
  for (let i = 0; i < 4; i++) {
    await outliner.addItems(
      { a: new Set([1]), b: new Set([1]), c: new Set([1]) },
      `group-${i}`,
    );
  }
  a.calls.length = b.calls.length = c.calls.length = 0;
  for (let i = 0; i < 64; i++) a.model.tiles.set(i + 2, new THREE.Mesh());
  await outliner.whenSettled();
  assert.equal(a.calls.length, 4);
  assert.equal(b.calls.length, 0);
  assert.equal(c.calls.length, 0);
  assert.equal(outliner.getPickCandidates(["group-0"]).size, 3);
});

test("an in-flight group refresh drains newer requests before callers settle", async () => {
  const { outliner, models, attached } = setup();
  const a = createModel();
  models.set("a", a.model);
  const first = deferred<Chunk[]>();
  const second = deferred<Chunk[]>();
  const started = deferred<void>();
  const restarted = deferred<void>();
  a.model.query = () => {
    if (a.calls.length === 1) {
      started.resolve();
      return first.promise;
    }
    restarted.resolve();
    return second.promise;
  };
  let firstSettled = false;
  const initial = outliner
    .addItems({ a: new Set([1]) }, "selection")
    .then(() => {
      firstSettled = true;
    });
  await started.promise;
  const latest = outliner.addItems({ a: new Set([2]) }, "selection");
  await Promise.resolve();
  assert.equal(
    a.calls.length,
    1,
    "the newer request must not overlap the running query",
  );
  first.resolve(chunks());
  await restarted.promise;
  assert.equal(firstSettled, false);
  assert.equal(
    attached.get("selection")!.size,
    0,
    "stale chunks must not attach",
  );
  assert.deepEqual(a.calls[1], [1, 2]);
  second.resolve(chunks());
  await Promise.all([initial, latest, outliner.whenSettled()]);
  assert.equal(attached.get("selection")!.size, 1);
});

test("retired tiles detach immediately and a same-ID model replacement wins", async () => {
  const { outliner, models, attached } = setup();
  const a = createModel();
  models.set("a", a.model);
  await outliner.addItems({ a: new Set([1]) }, "selection");
  const oldTile = a.model.tiles.get(1)!;
  const first = deferred<Chunk[]>();
  const started = deferred<void>();
  a.model.query = () => {
    started.resolve();
    return first.promise;
  };
  a.model.tiles.set(2, new THREE.Mesh());
  await started.promise;
  const replacement = createModel();
  models.set("a", replacement.model);
  assert.equal(attached.get("selection")!.has(oldTile), false);
  assert.equal(outliner.getPickCandidates(["selection"]).size, 0);
  first.resolve(chunks());
  await outliner.whenSettled();
  assert.deepEqual(
    [...attached.get("selection")!],
    [replacement.model.tiles.get(1)],
  );
  a.calls.length = 0;
  a.model.tiles.set(3, new THREE.Mesh());
  await outliner.whenSettled();
  assert.equal(a.calls.length, 0);
});

test("clean and remove cancel queued work without resurrecting groups", async () => {
  const { outliner, models, attached } = setup();
  const a = createModel();
  models.set("a", a.model);
  const cleaned = outliner.addItems({ a: new Set([1]) }, "cleaned");
  const removed = outliner.addItems({ a: new Set([1]) }, "removed");
  outliner.clean("cleaned");
  outliner.remove("removed");
  await Promise.all([cleaned, removed, outliner.whenSettled()]);
  assert.equal(a.calls.length, 0);
  assert.equal(attached.get("cleaned")?.size ?? 0, 0);
  assert.equal(outliner.list().includes("removed"), false);
});

test("a failed burst reports one background error and subsequent refreshes recover", async () => {
  const { outliner, models } = setup();
  const a = createModel();
  models.set("a", a.model);
  await outliner.addItems({ a: new Set([1]) }, "selection");
  const failure = new Error("chunk query failed");
  a.model.query = async () => {
    throw failure;
  };
  for (let i = 0; i < 8; i++) a.model.tiles.set(i + 2, new THREE.Mesh());
  await assert.rejects(
    outliner.whenSettled(),
    (error: Error & { errors: unknown[] }) => {
      assert.deepEqual(error.errors, [failure]);
      return true;
    },
  );
  a.model.query = async () => chunks();
  a.model.tiles.set(10, new THREE.Mesh());
  await outliner.whenSettled();
  assert.equal(outliner.getPickCandidates(["selection"]).size, 1);
});

test("a failed model does not release the group while another query is pending", async () => {
  const { outliner, models } = setup();
  const a = createModel();
  const b = createModel();
  models.set("a", a.model);
  models.set("b", b.model);
  const pending = deferred<Chunk[]>();
  const started = deferred<void>();
  a.model.query = async () => {
    throw new Error("superseded failure");
  };
  b.model.query = () => {
    started.resolve();
    return pending.promise;
  };
  const initial = outliner.addItems(
    { a: new Set([1]), b: new Set([1]) },
    "selection",
  );
  await started.promise;
  a.model.query = async () => chunks();
  b.model.query = async () => chunks();
  const latest = outliner.update(undefined, "selection");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(b.calls.length, 1);
  pending.resolve(chunks());
  await Promise.all([initial, latest]);
  assert.equal(a.calls.length, 2);
  assert.equal(b.calls.length, 2);
  assert.equal(outliner.getPickCandidates(["selection"]).size, 2);
});

test("explicit latest-query errors reject callers without becoming background errors", async () => {
  const { outliner, models } = setup();
  const a = createModel();
  models.set("a", a.model);
  const failure = new Error("explicit query failed");
  a.model.query = async () => {
    throw failure;
  };
  await assert.rejects(
    outliner.addItems({ a: new Set([1]) }, "selection"),
    failure,
  );
  await outliner.whenSettled();
});

test("a newer model event retains every uncommitted dirty model and skips clean models", async () => {
  const { outliner, models } = setup();
  const a = createModel();
  const b = createModel();
  const c = createModel();
  models.set("a", a.model);
  models.set("b", b.model);
  models.set("c", c.model);
  await outliner.addItems(
    { a: new Set([1]), b: new Set([1]), c: new Set([1]) },
    "selection",
  );
  a.calls.length = b.calls.length = c.calls.length = 0;
  const first = deferred<Chunk[]>();
  const started = deferred<void>();
  a.model.query = () => {
    started.resolve();
    return first.promise;
  };
  a.model.tiles.set(2, new THREE.Mesh());
  await started.promise;
  b.model.tiles.set(2, new THREE.Mesh());
  a.model.query = async () => chunks(2);
  b.model.query = async () => chunks(2);
  first.resolve(chunks());
  await outliner.whenSettled();
  assert.equal(a.calls.length, 2);
  assert.equal(b.calls.length, 1);
  assert.equal(c.calls.length, 0);
  const candidates = outliner.getPickCandidates(["selection"]);
  assert.equal(candidates.get("a")!.has(a.model.tiles.get(2)!), true);
  assert.equal(candidates.get("b")!.has(b.model.tiles.get(2)!), true);
  assert.equal(candidates.get("c")!.has(c.model.tiles.get(1)!), true);
});

test("clean during a query discards its result and does not report its obsolete failure", async () => {
  const { outliner, models, attached } = setup();
  const a = createModel();
  models.set("a", a.model);
  await outliner.addItems({ a: new Set([1]) }, "selection");
  const pending = deferred<Chunk[]>();
  const started = deferred<void>();
  a.model.query = () => {
    started.resolve();
    return pending.promise;
  };
  a.model.tiles.set(2, new THREE.Mesh());
  await started.promise;
  outliner.clean("selection");
  pending.reject(new Error("obsolete query"));
  await outliner.whenSettled();
  assert.equal(attached.get("selection")!.size, 0);
  assert.equal(outliner.getPickCandidates(["selection"]).size, 0);
});
