"use strict";

const assert = require("node:assert/strict");
const { Scheduler } = require("../scheduler");

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

  listRuns() {
    return Array.from(this._runs.values()).map((item) => ({ ...item }));
  }
}

function createScheduler(store, queue, worktreeManager) {
  const config = {
    schedulerPollMs: 5000,
    maxConcurrency: 2,
    maxAttempts: 3,
    storyTimeoutMs: 0,
    storyInactivityTimeoutMs: 60_000,
    workspace: process.cwd(),
    defaultTool: "codex",
  };
  const eventBus = { fire() {} };
  const logger = { info() {}, warn() {}, error() {} };
  return new Scheduler(config, store, queue, worktreeManager, eventBus, logger);
}

(async () => {
  await runCase("dispatch propagates projectId to run and task payload", async () => {
    const store = new FakeStore();
    store.setStory({
      id: "ST-PROJ-1",
      prdId: "PRD-PROJ-1",
      projectId: "proj-123",
      status: "pending",
      phase: "plan",
      attempt: 1,
      maxAttempts: 3,
      tool: "codex",
    });

    const published = [];
    const queue = {
      async publishTask(task) {
        published.push({ ...task });
      },
    };
    const worktreeManager = {
      async ensure() {
        return { id: "wt-123", path: "/tmp/wt-123" };
      },
    };
    const scheduler = createScheduler(store, queue, worktreeManager);
    await scheduler._dispatch(store.getStory("ST-PROJ-1"));

    assert.equal(published.length, 1);
    assert.equal(published[0].projectId, "proj-123");

    const runs = store.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].projectId, "proj-123");
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
