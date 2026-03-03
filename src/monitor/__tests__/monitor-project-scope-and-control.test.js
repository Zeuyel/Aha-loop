"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Monitor } = require("../monitor");

const CASES = [];
function runCase(name, fn) {
  CASES.push({ name, fn });
}

class FakeStore {
  constructor() {
    this.prds = [];
    this.stories = [];
    this.runs = [];
    this.projects = new Map();
  }

  listPrds(filter) {
    let items = this.prds;
    if (filter?.status) items = items.filter((prd) => prd.status === filter.status);
    return items.map((item) => ({ ...item }));
  }

  listStories(filter) {
    let items = this.stories;
    if (filter?.status) items = items.filter((story) => story.status === filter.status);
    if (filter?.prdId) items = items.filter((story) => story.prdId === filter.prdId);
    return items.map((item) => ({ ...item }));
  }

  listRuns(filter) {
    let items = this.runs;
    if (filter?.status) items = items.filter((run) => run.status === filter.status);
    if (filter?.storyId) items = items.filter((run) => run.storyId === filter.storyId);
    if (filter?.prdId) items = items.filter((run) => run.prdId === filter.prdId);
    if (filter?.phase) items = items.filter((run) => run.phase === filter.phase);
    return items.map((item) => ({ ...item }));
  }

  listSessions() {
    return [];
  }

  getSession() {
    return null;
  }

  getRun(id) {
    const run = this.runs.find((item) => item.id === id);
    return run ? { ...run } : null;
  }

  getStory(id) {
    const story = this.stories.find((item) => item.id === id);
    return story ? { ...story } : null;
  }

  getProject(id) {
    const project = this.projects.get(id);
    return project ? { ...project } : null;
  }

  setProject(project) {
    const next = { ...project };
    this.projects.set(next.id, next);
    return { ...next };
  }

  listProjects() {
    return Array.from(this.projects.values()).map((item) => ({ ...item }));
  }

  getPipeline() {
    return null;
  }
}

function createMonitor(store, overrides = {}) {
  const queue = {
    async healthCheck() {
      return {
        ok: true,
        queues: {
          work: { messageCount: 0, consumerCount: 1 },
          retry: { messageCount: 0, consumerCount: 0 },
          dead: { messageCount: 0, consumerCount: 0 },
        },
        runtimeConsumers: { work: 1, retry: 0, dead: 0 },
      };
    },
  };
  const config = {
    workspace: process.cwd(),
    monitorHttpHost: "127.0.0.1",
    monitorHttpPort: 0,
    monitorReportMs: 60_000,
    ...overrides.config,
  };
  const eventBus = { on() {} };
  const sessionPool = { size: 0 };
  const control = overrides.control || null;
  const logger = { info() {}, warn() {}, error() {} };
  return new Monitor(config, store, eventBus, queue, sessionPool, control, logger);
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  return JSON.parse(text);
}

runCase("HTTP /health,/stories,/runs support projectId filter", async () => {
  const store = new FakeStore();
  store.prds = [
    { id: "PRD-A", status: "active", projectId: "proj-a", stories: ["S-A"] },
    { id: "PRD-B", status: "queued", projectId: "proj-b", stories: ["S-B"] },
  ];
  store.stories = [
    { id: "S-A", prdId: "PRD-A", status: "pending", phase: "plan", updatedAt: "2026-02-01T00:00:00.000+08:00" },
    { id: "S-B", prdId: "PRD-B", status: "completed", phase: "implement", updatedAt: "2026-02-01T00:00:01.000+08:00" },
  ];
  store.runs = [
    { id: "R-A", storyId: "S-A", prdId: "PRD-A", status: "running", updatedAt: "2026-02-01T00:00:00.000+08:00" },
    { id: "R-B", storyId: "S-B", prdId: "PRD-B", status: "success", updatedAt: "2026-02-01T00:00:01.000+08:00" },
  ];

  const port = await findFreePort();
  const monitor = createMonitor(store, {
    config: { monitorHttpPort: port },
  });
  monitor._startHttpServer();
  await new Promise((resolve) => monitor._httpServer.once("listening", resolve));

  try {
    const base = `http://127.0.0.1:${port}`;
    const allStories = await fetchJson(`${base}/stories?limit=10`);
    const allRuns = await fetchJson(`${base}/runs?limit=10`);
    const scopedStories = await fetchJson(`${base}/stories?limit=10&projectId=proj-a`);
    const scopedRuns = await fetchJson(`${base}/runs?limit=10&projectId=proj-a`);
    const scopedHealth = await fetchJson(`${base}/health?projectId=proj-a`);

    assert.equal(allStories.totals.all, 2);
    assert.equal(allRuns.totals.all, 2);

    assert.equal(scopedStories.totals.all, 1);
    assert.equal(scopedStories.items[0].storyId, "S-A");

    assert.equal(scopedRuns.totals.all, 1);
    assert.equal(scopedRuns.items[0].runId, "R-A");

    assert.equal(scopedHealth.storyStatus.pending, 1);
    assert.equal(scopedHealth.prdStatus.active, 1);
    assert.equal(scopedHealth.runStatus.running, 1);
    assert.equal(scopedHealth.storyStatus.completed, undefined);
    assert.equal(scopedHealth.mode, "live");
    assert.equal(scopedHealth.simulated, false);
    assert.equal(scopedHealth.executionMode?.label, "live");
  } finally {
    await new Promise((resolve) => monitor._httpServer.close(resolve));
  }
});

runCase("health snapshot exposes mode + simulated across live/dry-run/plan-only", async () => {
  const scenarios = [
    { dryRun: false, planOnly: false, mode: "live", simulated: false },
    { dryRun: true, planOnly: false, mode: "dry-run", simulated: true },
    { dryRun: false, planOnly: true, mode: "plan-only", simulated: true },
    { dryRun: true, planOnly: true, mode: "dry-run", simulated: true },
  ];

  for (const scenario of scenarios) {
    const store = new FakeStore();
    const monitor = createMonitor(store, {
      config: {
        dryRun: scenario.dryRun,
        planOnly: scenario.planOnly,
      },
    });

    const health = await monitor.getHealthSnapshot();
    assert.equal(health.mode, scenario.mode);
    assert.equal(health.simulated, scenario.simulated);
    assert.equal(health.executionMode?.label, scenario.mode);
    assert.equal(health.executionMode?.dryRun, scenario.dryRun);
    assert.equal(health.executionMode?.planOnly, scenario.planOnly);
    assert.equal(health.executionMode?.simulated, scenario.simulated);
  }
});

runCase("_handleProjectControl start defaults resetBeforeLoad=false and passes projectId", async () => {
  const store = new FakeStore();
  store.setProject({
    id: "proj-a",
    name: "Project A",
    stage: "backlog",
    bootMode: "reload_from_prd",
    prdFile: "/tmp/project-a-prd.json",
  });

  const control = {
    pause() {},
    resume() {},
    restart() {},
    cancel() {},
    async approveMerge() { return { ok: true }; },
  };
  const monitor = createMonitor(store, { control });

  let captured = null;
  monitor._handleBootStart = async (payload) => {
    captured = payload;
    return { ok: true };
  };

  await monitor._handleProjectControl("proj-a", { action: "start" });

  assert.ok(captured);
  assert.equal(captured.projectId, "proj-a");
  assert.equal(captured.mode, "reload_from_prd");
  assert.equal(captured.resetBeforeLoad, false);
});

runCase("_handleBootStart forwards projectId to loader and keeps old behavior when absent", async () => {
  const store = new FakeStore();
  const monitor = createMonitor(store, {
    control: {
      getState() { return { paused: false }; },
      pause() {},
      resume() {},
    },
  });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-boot-start-"));
  const prdFile = path.join(tmpRoot, "prd.json");
  fs.writeFileSync(prdFile, JSON.stringify({ prdId: "PRD-A", userStories: [{ id: "US-1" }] }), "utf8");

  const prdLoader = require("../../pipeline/prd-loader");
  const originalLoadActivePrd = prdLoader.loadActivePrd;
  let capturedOptions = null;

  try {
    prdLoader.loadActivePrd = async (_file, _store, _logger, options) => {
      capturedOptions = options;
    };

    await monitor._handleBootStart({
      mode: "reload_from_prd",
      prdFile,
      projectId: "proj-a",
      autoResume: false,
      resetBeforeLoad: false,
    });
    assert.deepEqual(capturedOptions, {
      resetBeforeLoad: false,
      projectId: "proj-a",
      workspacePath: process.cwd(),
    });

    await monitor._handleBootStart({
      mode: "reload_from_prd",
      prdFile,
      autoResume: false,
    });
    assert.deepEqual(capturedOptions, {
      resetBeforeLoad: true,
      workspacePath: process.cwd(),
    });
  } finally {
    prdLoader.loadActivePrd = originalLoadActivePrd;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

async function main() {
  for (const testCase of CASES) {
    try {
      await testCase.fn();
      console.log(`PASS ${testCase.name}`);
    } catch (error) {
      console.error(`FAIL ${testCase.name}`);
      throw error;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
