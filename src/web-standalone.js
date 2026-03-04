#!/usr/bin/env node
"use strict";

const { loadConfig } = require("./config");
const { createLogger } = require("./core/logger");
const { getEventBus } = require("./core/event-bus");
const { Store } = require("./store/store");
const { Monitor } = require("./monitor/monitor");
const { migrateLegacyWorkspaceStateIfNeeded } = require("./core/state-bootstrap");

function createStandaloneQueue(config) {
  const emptyQueue = (name) => ({
    name,
    messageCount: 0,
    consumerCount: 0,
  });

  return {
    async healthCheck() {
      return {
        ok: true,
        url: config.rmqUrl,
        queues: {
          work: emptyQueue(config.workQueue),
          retry: emptyQueue(config.retryQueue),
          dead: emptyQueue(config.deadQueue),
        },
        runtimeConsumers: {
          work: 0,
          retry: 0,
          dead: 0,
        },
      };
    },
    async close() {},
  };
}

function createStandaloneSessionPool() {
  return {
    size: 0,
    async stop() {},
  };
}

function createStandaloneControl() {
  const state = {
    paused: false,
    pauseReason: null,
    pauseSource: "standalone_web",
    updatedAt: null,
  };

  const getState = () => ({ ...state });
  const touch = (patch = {}) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    return getState();
  };

  return {
    getState,
    pause({ reason = "manual_pause", source = "standalone_web" } = {}) {
      return touch({ paused: true, pauseReason: reason, pauseSource: source });
    },
    resume({ reason = "manual_resume", source = "standalone_web" } = {}) {
      return touch({ paused: false, pauseReason: reason, pauseSource: source });
    },
    restart({ runId = null, storyId = null, reason = "restart_requested", resetAttempts = false } = {}) {
      return {
        ok: true,
        simulated: true,
        action: "restart",
        runId,
        storyId,
        reason,
        resetAttempts,
        control: getState(),
      };
    },
    approveMerge({ runId = null, storyId = null, reason = "merge_approved" } = {}) {
      return Promise.resolve({
        ok: true,
        simulated: true,
        action: "approve_merge",
        runId,
        storyId,
        reason,
        control: getState(),
      });
    },
    cancel({ runId = null, storyId = null, reason = "cancel_requested" } = {}) {
      return {
        ok: true,
        simulated: true,
        action: "cancel",
        runId,
        storyId,
        reason,
        control: getState(),
      };
    },
    reviveDeadStories({ prdId = null, reason = "revive_dead_requested", resetAttempts = true } = {}) {
      return {
        ok: true,
        simulated: true,
        action: "revive_dead",
        prdId,
        reason,
        resetAttempts,
        revivedCount: 0,
        control: getState(),
      };
    },
  };
}

async function main() {
  const config = loadConfig(process.argv.slice(2));
  const logger = createLogger({ service: "aha-loop-web" });
  const eventBus = getEventBus(logger);

  await migrateLegacyWorkspaceStateIfNeeded(config, logger);
  const store = new Store(config.stateFile, eventBus, logger);
  await store.init();

  const queue = createStandaloneQueue(config);
  const sessionPool = createStandaloneSessionPool();
  const control = createStandaloneControl();
  const monitor = new Monitor(config, store, eventBus, queue, sessionPool, control, logger);
  monitor.start();

  logger.info("[aha-loop-web] standalone web monitor started", {
    event: "web_started",
    bindHost: config.monitorHttpHost,
    port: config.monitorHttpPort,
    projects: `http://127.0.0.1:${config.monitorHttpPort}/projects.html`,
    overview: `http://127.0.0.1:${config.monitorHttpPort}/overview.html`,
  });

  const shutdown = async (signal) => {
    logger.info(`[aha-loop-web] received ${signal}, shutting down...`);
    monitor.stop();
    await store.flushNow();
    await queue.close();
    await sessionPool.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`[aha-loop-web] fatal: ${err.message}`);
  process.exit(1);
});
