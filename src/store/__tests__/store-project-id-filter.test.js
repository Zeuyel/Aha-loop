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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-project-id-filter-"));
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
  await runCase("list filters support projectId for prds/stories/runs/sessions/worktrees", async () => {
    await withTempStore(async (store) => {
      store.setPrd({ id: "PRD-A", projectId: "proj-a", status: "queued", stories: [] });
      store.setPrd({ id: "PRD-B", projectId: "proj-b", status: "queued", stories: [] });

      store.setStory({ id: "ST-A", prdId: "PRD-A", projectId: "proj-a", status: "pending", phase: "plan" });
      store.setStory({ id: "ST-B", prdId: "PRD-B", projectId: "proj-b", status: "pending", phase: "plan" });

      store.setRun({ id: "RUN-A", storyId: "ST-A", prdId: "PRD-A", projectId: "proj-a", status: "queued" });
      store.setRun({ id: "RUN-B", storyId: "ST-B", prdId: "PRD-B", projectId: "proj-b", status: "queued" });

      store.setSession({ id: "SES-A", storyId: "ST-A", runId: "RUN-A", projectId: "proj-a", status: "running" });
      store.setSession({ id: "SES-B", storyId: "ST-B", runId: "RUN-B", projectId: "proj-b", status: "running" });

      store.setWorktree({ id: "WT-A", storyId: "ST-A", projectId: "proj-a", status: "active" });
      store.setWorktree({ id: "WT-B", storyId: "ST-B", projectId: "proj-b", status: "active" });

      assert.deepEqual(store.listPrds({ projectId: "proj-a" }).map((item) => item.id), ["PRD-A"]);
      assert.deepEqual(store.listStories({ projectId: "proj-a" }).map((item) => item.id), ["ST-A"]);
      assert.deepEqual(store.listRuns({ projectId: "proj-a" }).map((item) => item.id), ["RUN-A"]);
      assert.deepEqual(store.listSessions({ projectId: "proj-a" }).map((item) => item.id), ["SES-A"]);
      assert.deepEqual(store.listWorktrees({ projectId: "proj-a" }).map((item) => item.id), ["WT-A"]);
    });
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
