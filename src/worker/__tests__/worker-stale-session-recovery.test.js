"use strict";

const assert = require("node:assert/strict");
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
    const next = {
      ...current,
      ...patch,
      status: targetStatus,
    };
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

function createWorker(store) {
  const config = { maxConcurrency: 2, maxAttempts: 4 };
  const sessionPool = {
    size: 0,
    isSessionActive: () => false,
  };
  const eventBus = { fire() {} };
  const logger = { info() {}, warn() {}, error() {} };
  return new Worker(config, store, sessionPool, eventBus, logger);
}

(async () => {
  await runCase("handleTask recovers stale session and moves story out of running", async () => {
    const store = new FakeStore();
    store.setStory({
      id: "PRD-016-S01",
      prdId: "PRD-016",
      status: "running",
      phase: "review",
      attempt: 4,
      traceId: "trace-1",
      currentRunId: "run-old",
      sessionId: "ses-old",
    });
    store.setRun({
      id: "run-old",
      storyId: "PRD-016-S01",
      prdId: "PRD-016",
      phase: "review",
      status: "running",
      attempt: 4,
      sessionId: "ses-old",
    });
    store.setRun({
      id: "run-new",
      storyId: "PRD-016-S01",
      prdId: "PRD-016",
      phase: "review",
      status: "queued",
      attempt: 4,
      sessionId: null,
    });
    store.setSession({
      id: "ses-old",
      runId: "run-old",
      storyId: "PRD-016-S01",
      prdId: "PRD-016",
      status: "running",
    });

    const worker = createWorker(store);
    await worker.handleTask({
      storyId: "PRD-016-S01",
      runId: "run-new",
      prdId: "PRD-016",
      phase: "review",
      attempt: 4,
      traceId: "trace-1",
    });

    const staleSession = store.getSession("ses-old");
    const staleRun = store.getRun("run-old");
    const story = store.getStory("PRD-016-S01");
    const queuedRun = store.getRun("run-new");

    assert.equal(staleSession.status, "failed");
    assert.equal(staleSession.error.code, "STALE_SESSION_RECOVERED");
    assert.equal(staleRun.status, "fail");
    assert.equal(staleRun.errorCode, "STALE_SESSION_RECOVERED");
    assert.equal(story.status, "failed");
    assert.ok(["RUNNING_WITHOUT_SESSION", "STALE_SESSION_RECOVERED"].includes(story.errorCode));
    assert.equal(story.sessionId, null);
    assert.equal(queuedRun.status, "queued");
  });
})().catch((error) => {
  process.exitCode = 1;
  throw error;
});
