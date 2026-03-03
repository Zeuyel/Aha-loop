"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../../store/store");
const { loadPrds, loadActivePrd } = require("../prd-loader");

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prd-loader-project-id-"));
  const stateFile = path.join(root, ".aha-loop", "state.json");
  const store = new Store(
    stateFile,
    { fire() {} },
    { info() {}, warn() {}, error() {} },
  );
  await store.init();
  try {
    await fn({ root, store });
  } finally {
    await store.flushNow().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

(async () => {
  await runCase("loadPrds writes projectId for prd/story", async () => {
    await withTempStore(async ({ root, store }) => {
      const roadmapFile = path.join(root, "roadmap.json");
      writeJson(roadmapFile, {
        projectId: "proj-alpha",
        prds: [
          {
            id: "PRD-100",
            title: "alpha",
            stories: [{ id: "ST-100", title: "s1" }],
          },
        ],
      });

      await loadPrds(roadmapFile, store, { info() {}, warn() {}, error() {} });

      assert.equal(store.getPrd("PRD-100")?.projectId, "proj-alpha");
      assert.equal(store.getStory("ST-100")?.projectId, "proj-alpha");
    });
  });

  await runCase("loadPrds throws clear error for same PRD id with different projectId", async () => {
    await withTempStore(async ({ root, store }) => {
      store.setPrd({ id: "PRD-200", projectId: "proj-old", status: "queued", stories: [] });
      const roadmapFile = path.join(root, "roadmap-conflict.json");
      writeJson(roadmapFile, {
        projectId: "proj-new",
        prds: [{ id: "PRD-200", stories: [] }],
      });

      await assert.rejects(
        () => loadPrds(roadmapFile, store, { info() {}, warn() {}, error() {} }, { resetBeforeLoad: false }),
        (error) => error
          && error.code === "PRD_LOADER_PROJECT_ID_CONFLICT"
          && /PRD PRD-200/.test(error.message)
          && /projectId/.test(error.message),
      );
    });
  });

  await runCase("loadActivePrd throws clear error for same Story id with different projectId", async () => {
    await withTempStore(async ({ root, store }) => {
      store.setStory({ id: "US-201", prdId: "PRD-201", projectId: "proj-old", status: "pending", phase: "plan" });
      const prdFile = path.join(root, "prd.json");
      writeJson(prdFile, {
        prdId: "PRD-999",
        projectId: "proj-new",
        userStories: [{ id: "US-201", title: "conflict" }],
      });

      await assert.rejects(
        () => loadActivePrd(prdFile, store, { info() {}, warn() {}, error() {} }, { resetBeforeLoad: false }),
        (error) => error
          && error.code === "PRD_LOADER_PROJECT_ID_CONFLICT"
          && /Story US-201/.test(error.message)
          && /projectId/.test(error.message),
      );
    });
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
