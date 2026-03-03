"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("../worker");

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

class FakeStore {
  constructor() {
    this._stories = new Map();
    this._runs = new Map();
    this._sessions = new Map();
  }

  setStory(story) {
    this._stories.set(story.id, { ...story });
    return this.getStory(story.id);
  }

  getStory(id) {
    const item = this._stories.get(id);
    return item ? { ...item } : null;
  }

  transitionStory(id, targetStatus, patch = {}) {
    const current = this._stories.get(id);
    if (!current) throw new Error(`story not found: ${id}`);
    const next = { ...current, ...patch, status: targetStatus };
    this._stories.set(id, next);
    return { ...next };
  }

  setRun(run) {
    this._runs.set(run.id, { ...run });
    return this.getRun(run.id);
  }

  getRun(id) {
    const item = this._runs.get(id);
    return item ? { ...item } : null;
  }

  setSession(session) {
    this._sessions.set(session.id, { ...session });
    return this.getSession(session.id);
  }

  getSession(id) {
    const item = this._sessions.get(id);
    return item ? { ...item } : null;
  }

  listSessions(filter = {}) {
    return Array.from(this._sessions.values())
      .filter((item) => {
        if (filter.storyId && item.storyId !== filter.storyId) return false;
        if (filter.status && item.status !== filter.status) return false;
        return true;
      })
      .map((item) => ({ ...item }));
  }
}

function createTempWorktree(prd) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-project-cap-"));
  const ahaDir = path.join(root, ".aha-loop");
  fs.mkdirSync(ahaDir, { recursive: true });
  fs.writeFileSync(path.join(ahaDir, "prd.json"), `${JSON.stringify(prd, null, 2)}\n`, "utf8");
  return root;
}

function createWorker(store, sessionPool) {
  const config = { maxConcurrency: 4, maxConcurrencyPerProject: 1, maxAttempts: 3 };
  const eventBus = { fire() {} };
  const logger = { info() {}, warn() {}, error() {} };
  return new Worker(config, store, sessionPool, eventBus, logger);
}

(async () => {
  await runCase("handleTask blocks when project reaches per-project concurrency cap", async () => {
    const store = new FakeStore();
    store.setStory({
      id: "ST-CAP-1",
      prdId: "PRD-CAP-1",
      projectId: "proj-cap",
      status: "queued",
      phase: "implement",
      attempt: 1,
      maxAttempts: 3,
    });
    store.setRun({
      id: "run-cap-1",
      storyId: "ST-CAP-1",
      prdId: "PRD-CAP-1",
      projectId: "proj-cap",
      status: "queued",
      attempt: 1,
    });

    const worktreePath = createTempWorktree({
      prdId: "PRD-CAP-1",
      projectId: "proj-cap",
      stories: [{ id: "ST-CAP-1" }],
    });

    const sessionPool = {
      size: 0,
      isSessionActive: () => false,
      getActiveCountByProject: (projectId) => (projectId === "proj-cap" ? 1 : 0),
      async launch() {
        throw new Error("launch should not be called when project cap is reached");
      },
    };

    const worker = createWorker(store, sessionPool);
    try {
      await assert.rejects(
        worker.handleTask({
          runId: "run-cap-1",
          storyId: "ST-CAP-1",
          prdId: "PRD-CAP-1",
          projectId: "proj-cap",
          phase: "implement",
          attempt: 1,
          maxAttempts: 3,
          tool: "codex",
          worktreePath,
        }),
        (error) => error && error.code === "WORKER_BACKPRESSURE" && /project concurrency limit reached/.test(error.message),
      );
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
