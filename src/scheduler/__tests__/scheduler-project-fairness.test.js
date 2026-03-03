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

function createScheduler(overrides = {}) {
  const config = {
    schedulerPollMs: 5000,
    maxConcurrency: 4,
    maxConcurrencyPerProject: 0,
    maxAttempts: 3,
    storyTimeoutMs: 0,
    storyInactivityTimeoutMs: 60_000,
    workspace: process.cwd(),
    defaultTool: "codex",
    ...overrides,
  };
  const store = {
    listStories: () => [],
    listPrds: () => [],
  };
  const queue = { async publishTask() {} };
  const worktreeManager = { async ensure() { return { id: "wt-1", path: "/tmp/wt-1" }; } };
  const eventBus = { fire() {} };
  const logger = { info() {}, warn() {}, error() {} };
  return new Scheduler(config, store, queue, worktreeManager, eventBus, logger);
}

runCase("_buildDispatchPlan rotates projects in round-robin order", () => {
  const scheduler = createScheduler({ maxConcurrencyPerProject: 0 });
  const pending = [
    { id: "A-1", projectId: "proj-a" },
    { id: "A-2", projectId: "proj-a" },
    { id: "B-1", projectId: "proj-b" },
    { id: "B-2", projectId: "proj-b" },
    { id: "C-1", projectId: "proj-c" },
  ];

  const plan = scheduler._buildDispatchPlan(pending, 4, new Map());
  assert.deepEqual(plan.map((story) => story.id), ["A-1", "B-1", "C-1", "A-2"]);
});

runCase("_buildDispatchPlan prioritizes projects with fewer in-flight stories", () => {
  const scheduler = createScheduler({ maxConcurrencyPerProject: 0 });
  const pending = [
    { id: "A-1", projectId: "proj-a" },
    { id: "B-1", projectId: "proj-b" },
  ];
  const inFlight = new Map([
    ["proj-a", 2],
    ["proj-b", 0],
  ]);

  const plan = scheduler._buildDispatchPlan(pending, 2, inFlight);
  assert.deepEqual(plan.map((story) => story.id), ["B-1", "A-1"]);
});

runCase("_buildDispatchPlan enforces per-project dispatch cap", () => {
  const scheduler = createScheduler({ maxConcurrencyPerProject: 1 });
  const pending = [
    { id: "A-1", projectId: "proj-a" },
    { id: "B-1", projectId: "proj-b" },
    { id: "B-2", projectId: "proj-b" },
  ];
  const inFlight = new Map([
    ["proj-a", 1],
    ["proj-b", 0],
  ]);

  const plan = scheduler._buildDispatchPlan(pending, 3, inFlight);
  assert.deepEqual(plan.map((story) => story.id), ["B-1"]);
});
