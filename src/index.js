#!/usr/bin/env node
"use strict";

const { loadConfig } = require("./config");
const { createLogger } = require("./core/logger");
const { getEventBus } = require("./core/event-bus");
const { Store } = require("./store/store");
const { createQueueClient } = require("./queue/queue");
const { Scheduler } = require("./scheduler/scheduler");
const { Worker } = require("./worker/worker");
const { SessionPool } = require("./worker/session-pool");
const { WorktreeManager } = require("./worktree/worktree");
const { Monitor } = require("./monitor/monitor");
const { Pipeline } = require("./pipeline/pipeline");
const { RuntimeControl } = require("./control/runtime-control");
const { nowEast8Iso } = require("./core/time");

function hasExistingExecutionState(store) {
  return (
    store.listPrds().length > 0
    || store.listStories().length > 0
    || store.listRuns().length > 0
  );
}

function markPipelineExecutingForResume(store, config, logger) {
  const current = store.getPipeline() || {};
  if (current.status === "executing") return;

  store.setPipeline({
    ...current,
    visionFile: current.visionFile || config.visionFile || null,
    status: "executing",
    resumedAt: nowEast8Iso(),
    createdAt: current.createdAt || nowEast8Iso(),
    error: null,
  });
  logger.info("[pipeline] resume-from-state: marked pipeline as executing");
}

async function main() {
  const config = loadConfig(process.argv.slice(2));
  const logger = createLogger({ service: "aha-loop-mq" });
  const eventBus = getEventBus(logger);

  // --- 基础设施 ---
  const store = new Store(config.stateFile, eventBus, logger);
  await store.init();

  const queue = createQueueClient(config, eventBus, logger);
  await queue.connect();

  // --- 执行层 ---
  const worktreeManager = new WorktreeManager(config, store, logger);
  const sessionPool = new SessionPool(config, store, eventBus, logger);
  const worker = new Worker(config, store, sessionPool, eventBus, logger);
  const scheduler = new Scheduler(config, store, queue, worktreeManager, eventBus, logger);
  const runtimeControl = new RuntimeControl(config, store, scheduler, sessionPool, worktreeManager, logger);
  const monitor = new Monitor(config, store, eventBus, queue, sessionPool, runtimeControl, logger);

  // --- 先启动会话池与监控，确保 pipeline 阶段也可观测 ---
  sessionPool.start();
  monitor.start();

  const resumeFromState = config.resumeFromState !== false && hasExistingExecutionState(store);

  if (resumeFromState) {
    logger.info("[aha-loop] existing state detected, skip planning pipeline and resume execution", {
      prdCount: store.listPrds().length,
      storyCount: store.listStories().length,
      runCount: store.listRuns().length,
      stateFile: config.stateFile,
    });
    markPipelineExecutingForResume(store, config, logger);
  } else {
    // --- 流水线: vision → architect → roadmap → PRD → store ---
    if (config.visionFile) {
      const pipeline = new Pipeline(config, store, logger);
      await pipeline.run(config.visionFile);
    } else if (config.prdFile) {
      const { loadActivePrd } = require("./pipeline/prd-loader");
      await loadActivePrd(config.prdFile, store, logger);
    } else if (config.roadmapFile) {
      const { loadPrds } = require("./pipeline/prd-loader");
      await loadPrds(config.roadmapFile, store, logger);
    }
  }

  // --- 启动 ---
  await worker.start(queue);
  scheduler.start();

  logger.info("[aha-loop] engine started");
  logger.info("[aha-loop] dashboard ready", {
    monitor: `http://127.0.0.1:${config.monitorHttpPort}/projects.html`,
    overview: `http://127.0.0.1:${config.monitorHttpPort}/overview.html`,
  });

  // --- 优雅关闭 ---
  const shutdown = async (signal) => {
    logger.info(`[aha-loop] received ${signal}, shutting down...`);
    scheduler.stop();
    monitor.stop();
    await sessionPool.stop();
    await queue.close();
    await store.flushNow();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`[aha-loop] fatal: ${err.message}`);
  process.exit(1);
});
