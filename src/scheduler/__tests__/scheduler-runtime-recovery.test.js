"use strict";

const assert = require("node:assert/strict");
const { Scheduler } = require("../scheduler");

function runCase(name, fn) {
  try {
    fn();
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
    this._prds = new Map();
  }

  listStories() {
    return Array.from(this._stories.values()).map((item) => ({ ...item }));
  }

  getStory(id) {
    const item = this._stories.get(id);
    return item ? { ...item } : null;
  }

  setStory(story) {
    this._stories.set(story.id, { ...story });
    return this.getStory(story.id);
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

  listRuns() {
    return Array.from(this._runs.values()).map((item) => ({ ...item }));
  }

  getRun(id) {
    const item = this._runs.get(id);
    return item ? { ...item } : null;
  }

  setRun(run) {
    this._runs.set(run.id, { ...run });
    return this.getRun(run.id);
  }

  listSessions(filter = {}) {
    const items = Array.from(this._sessions.values());
    return items
      .filter((item) => {
        if (filter.status && item.status !== filter.status) return false;
        if (filter.storyId && item.storyId !== filter.storyId) return false;
        return true;
      })
      .map((item) => ({ ...item }));
  }

  setSession(session) {
    this._sessions.set(session.id, { ...session });
  }

  listPrds() {
    return Array.from(this._prds.values()).map((item) => ({ ...item }));
  }

  listPrdsByStatus(status) {
    return this.listPrds().filter((item) => item.status === status);
  }
}

function createScheduler(store) {
  const config = {
    schedulerPollMs: 5000,
    maxConcurrency: 3,
    maxAttempts: 4,
    failFastOnDead: false,
  };
  const queue = {};
  const worktreeManager = {};
  const eventBus = { fire() {} };
  const logger = { info() {}, warn() {}, error() {} };
  return new Scheduler(config, store, queue, worktreeManager, eventBus, logger);
}

runCase("audit recovers running story to phase_done when run already succeeded", () => {
  const store = new FakeStore();
  store.setStory({
    id: "PRD-016-S01",
    prdId: "PRD-016",
    status: "running",
    phase: "review",
    attempt: 4,
    currentRunId: "run-1",
    sessionId: "ses-1",
  });
  store.setRun({
    id: "run-1",
    storyId: "PRD-016-S01",
    status: "success",
    finishAt: "2026-02-20T13:57:09.736+08:00",
  });

  const scheduler = createScheduler(store);
  scheduler._auditRuntimeConsistency();

  const story = store.getStory("PRD-016-S01");
  assert.equal(story.status, "phase_done");
  assert.equal(story.sessionId, null);
  assert.equal(story.currentRunId, "run-1");
});

runCase("audit recovers running story to failed when no active session and run is stale", () => {
  const store = new FakeStore();
  store.setStory({
    id: "PRD-016-S03",
    prdId: "PRD-016",
    status: "running",
    phase: "implement",
    attempt: 3,
    currentRunId: "run-2",
    sessionId: "ses-2",
  });
  store.setRun({
    id: "run-2",
    storyId: "PRD-016-S03",
    status: "running",
    error: null,
    errorCode: null,
    errorSource: null,
  });

  const scheduler = createScheduler(store);
  scheduler._auditRuntimeConsistency();

  const story = store.getStory("PRD-016-S03");
  const run = store.getRun("run-2");

  assert.equal(run.status, "fail");
  assert.equal(run.errorCode, "RUNNING_WITHOUT_SESSION");
  assert.equal(story.status, "failed");
  assert.equal(story.errorCode, "RUNNING_WITHOUT_SESSION");
  assert.equal(story.errorSource, "scheduler_audit");
});
