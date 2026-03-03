"use strict";

const assert = require("node:assert/strict");
const { Scheduler } = require("../scheduler");

class FakeStore {
  constructor() {
    this._stories = new Map();
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
}

function createScheduler(store, overrides = {}) {
  const config = {
    schedulerPollMs: 5000,
    maxConcurrency: 3,
    maxAttempts: 4,
    failFastOnDead: false,
    mergeMode: "manual_gate",
    ...overrides.config,
  };
  const queue = {};
  const worktreeManager = {
    async merge() { return { ok: true }; },
    async cleanup() {},
    ...(overrides.worktreeManager || {}),
  };
  const eventBus = { fire() {} };
  const logger = { info() {}, warn() {}, error() {} };
  return new Scheduler(config, store, queue, worktreeManager, eventBus, logger);
}

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  await runCase("manual gate keeps story in merging/pending_approval", async () => {
    const store = new FakeStore();
    store.setStory({
      id: "PRD-020-S01",
      prdId: "PRD-020",
      status: "phase_done",
      phase: "review",
      worktreeId: "wt-001",
    });

    const scheduler = createScheduler(store, { config: { mergeMode: "manual_gate" } });
    await scheduler._startMerge(store.getStory("PRD-020-S01"));
    const story = store.getStory("PRD-020-S01");

    assert.equal(story.status, "merging");
    assert.equal(story.mergeState, "pending_approval");
  });

  await runCase("auto mode merges and completes story", async () => {
    const store = new FakeStore();
    store.setStory({
      id: "PRD-020-S02",
      prdId: "PRD-020",
      status: "phase_done",
      phase: "review",
      worktreeId: "wt-002",
    });
    let merged = 0;
    let cleaned = 0;
    const scheduler = createScheduler(store, {
      config: { mergeMode: "auto" },
      worktreeManager: {
        async merge() {
          merged += 1;
          return { ok: true };
        },
        async cleanup() {
          cleaned += 1;
        },
      },
    });
    await scheduler._startMerge(store.getStory("PRD-020-S02"));
    const story = store.getStory("PRD-020-S02");

    assert.equal(merged, 1);
    assert.equal(cleaned, 1);
    assert.equal(story.status, "completed");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
