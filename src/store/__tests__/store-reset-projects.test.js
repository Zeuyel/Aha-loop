"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store");

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function withTempStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-reset-projects-"));
  const stateFile = path.join(root, ".aha-loop", "state.json");
  const store = new Store(
    stateFile,
    { fire() {} },
    { info() {}, warn() {}, error() {} },
  );
  await store.init();
  try {
    await fn(store);
  } finally {
    await store.flushNow().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  await runCase("resetExecutionState keeps projects by default", async () => {
    await withTempStore(async (store) => {
      store.setProject({
        id: "proj-1",
        name: "Persisted Project",
        stage: "backlog",
        createdAt: "2026-02-20T00:00:00.000+08:00",
      });
      store.setStory({
        id: "ST-1",
        prdId: "PRD-1",
        status: "pending",
        phase: "plan",
      });

      store.resetExecutionState({ keepPipeline: true });

      assert.equal(store.listStories().length, 0);
      assert.equal(store.listProjects().length, 1);
      assert.equal(store.getProject("proj-1")?.name, "Persisted Project");
    });
  });

  await runCase("resetExecutionState clears projects when keepProjects is false", async () => {
    await withTempStore(async (store) => {
      store.setProject({
        id: "proj-2",
        name: "Temporary Project",
        stage: "backlog",
        createdAt: "2026-02-20T00:00:00.000+08:00",
      });

      store.resetExecutionState({ keepPipeline: true, keepProjects: false });
      assert.equal(store.listProjects().length, 0);
      assert.equal(store.getProject("proj-2"), null);
    });
  });

  await runCase("setStory enforces optional expectedRevision (CAS)", async () => {
    await withTempStore(async (store) => {
      const first = store.setStory({
        id: "ST-CAS-1",
        prdId: "PRD-CAS",
        status: "pending",
        phase: "plan",
      });
      const second = store.setStory({
        ...first,
        status: "queued",
      }, { expectedRevision: first.revision });

      assert.equal(second.status, "queued");
      assert.ok(second.revision > first.revision);

      assert.throws(
        () => store.setStory({
          ...second,
          status: "running",
        }, { expectedRevision: first.revision }),
        (error) => error && error.code === "STORE_REVISION_CONFLICT",
      );
    });
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
