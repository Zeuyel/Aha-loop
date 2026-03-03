"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { URL } = require("node:url");
const fsp = require("node:fs/promises");
const { nowEast8Iso, toEast8Iso } = require("../core/time");

/**
 * Monitor — 事件驱动健康监控 + 告警
 * 1) 聚合队列/执行层健康
 * 2) 输出结构化健康日志
 * 3) 触发最小可用告警规则
 * 4) 提供前端监控 API
 */
class Monitor {
  constructor(config, store, eventBus, queue, sessionPool, control = null, logger = console) {
    this.config = config;
    this.store = store;
    this.eventBus = eventBus;
    this.queue = queue;
    this.sessionPool = sessionPool;
    this.control = control;
    this.logger = logger;

    this._timer = null;
    this._httpServer = null;
    this._reportRunning = false;

    this.stats = {
      tasksDispatched: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      retryEvents: 0,
      deadEvents: 0,
      startedAt: null,
    };

    this.heartbeats = {
      schedulerAt: null,
      workerAt: null,
    };

    this._history = [];
    this._alertState = new Map();
    this._alertEvents = [];
    this._latencySamples = [];
    this._deadLetterWrite = Promise.resolve();
  }

  start() {
    this.stats.startedAt = nowEast8Iso();

    // 事件计数
    this.eventBus.on("task:dispatched", () => this.stats.tasksDispatched++);
    this.eventBus.on("task:retry", () => this.stats.retryEvents++);
    this.eventBus.on("task:dead", (payload) => {
      this.stats.deadEvents++;
      this._persistDeadLetter(payload).catch((err) => {
        this.logger.error("[monitor] dead-letter persistence failed", {
          event: "dead_letter_persist_failed",
          error: err,
          storyId: payload?.storyId || null,
          prdId: payload?.prdId || null,
          phase: payload?.phase || null,
          attempt: payload?.attempt || null,
          traceId: payload?.traceId || null,
        });
      });
    });
    this.eventBus.on("session:completed", (payload) => {
      this.stats.tasksCompleted++;
      this._recordLatencySample(payload, "success");
    });
    this.eventBus.on("session:failed", (payload) => {
      this.stats.tasksFailed++;
      this._recordLatencySample(payload, "fail");
    });

    // 心跳
    this.eventBus.on("scheduler:heartbeat", (payload) => {
      this.heartbeats.schedulerAt = payload?.at || nowEast8Iso();
    });
    this.eventBus.on("worker:heartbeat", (payload) => {
      this.heartbeats.workerAt = payload?.at || nowEast8Iso();
    });

    // 定期健康报告
    this._timer = setInterval(() => {
      this._report().catch((err) => {
        this.logger.error("[monitor] report error", { event: "monitor_error", error: err });
      });
    }, this.config.monitorReportMs || 60_000);

    this._report().catch((err) => {
      this.logger.error("[monitor] initial report error", { event: "monitor_error", error: err });
    });

    this._startHttpServer();
    this.logger.info("[monitor] started", { event: "monitor_started" });
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._httpServer) {
      this._httpServer.close();
      this._httpServer = null;
    }
  }

  async _report() {
    if (this._reportRunning) return;
    this._reportRunning = true;

    try {
      const health = await this.getHealthSnapshot();
      this._recordSnapshot(health);
      await this._evaluateAlerts(health);

      this.logger.info("[monitor] health snapshot", {
        event: "health_report",
        queue: health.queue,
        service: health.service,
        scheduler: health.scheduler,
        worker: health.worker,
        sessionPool: health.sessionPool,
        storyStatus: health.storyStatus,
        prdStatus: health.prdStatus,
        runStatus: health.runStatus,
        counters: health.counters,
        latency: health.latency,
      });
    } finally {
      this._reportRunning = false;
    }
  }

  _normalizeProjectId(value) {
    const raw = String(value || "").trim();
    return raw ? raw.slice(0, 256) : null;
  }

  _collectProjectRefs(entity) {
    if (!entity || typeof entity !== "object") return [];

    const refs = [];
    const push = (value) => {
      const normalized = this._normalizeProjectId(value);
      if (!normalized) return;
      refs.push(normalized);
    };

    push(entity.projectId);
    if (Array.isArray(entity.projectIds)) {
      for (const id of entity.projectIds) push(id);
    }
    if (entity.project && typeof entity.project === "object") {
      push(entity.project.id);
    }
    return refs;
  }

  _entityMatchesProject(entity, projectId) {
    if (!projectId) return true;
    if (!entity || typeof entity !== "object") return false;

    const refs = this._collectProjectRefs(entity);
    if (refs.includes(projectId)) return true;

    const normalizedId = this._normalizeProjectId(entity.id);
    return Boolean(normalizedId && Array.isArray(entity.stories) && normalizedId === projectId);
  }

  _buildProjectScope(projectId) {
    const normalizedProjectId = this._normalizeProjectId(projectId);
    const prds = this.store.listPrds();
    const stories = this.store.listStories();
    const runs = this.store.listRuns();

    if (!normalizedProjectId) {
      return { projectId: null, prds, stories, runs };
    }

    const prdIds = new Set();
    const storyIds = new Set();
    const runIds = new Set();

    for (const prd of prds) {
      if (this._entityMatchesProject(prd, normalizedProjectId)) {
        prdIds.add(prd.id);
      }
    }
    for (const story of stories) {
      if (this._entityMatchesProject(story, normalizedProjectId)) {
        storyIds.add(story.id);
        if (story.prdId) prdIds.add(story.prdId);
      }
    }
    for (const run of runs) {
      if (this._entityMatchesProject(run, normalizedProjectId)) {
        runIds.add(run.id);
        if (run.storyId) storyIds.add(run.storyId);
        if (run.prdId) prdIds.add(run.prdId);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;

      for (const story of stories) {
        if (storyIds.has(story.id)) continue;
        if (!story.prdId || !prdIds.has(story.prdId)) continue;
        storyIds.add(story.id);
        changed = true;
      }

      for (const run of runs) {
        if (runIds.has(run.id)) continue;
        const linkedStory = run.storyId && storyIds.has(run.storyId);
        const linkedPrd = run.prdId && prdIds.has(run.prdId);
        if (!linkedStory && !linkedPrd) continue;
        runIds.add(run.id);
        if (run.storyId && !storyIds.has(run.storyId)) {
          storyIds.add(run.storyId);
        }
        if (run.prdId && !prdIds.has(run.prdId)) {
          prdIds.add(run.prdId);
        }
        changed = true;
      }

      for (const story of stories) {
        if (!storyIds.has(story.id)) continue;
        if (!story.prdId || prdIds.has(story.prdId)) continue;
        prdIds.add(story.prdId);
        changed = true;
      }
    }

    return {
      projectId: normalizedProjectId,
      prds: prds.filter((prd) => prdIds.has(prd.id)),
      stories: stories.filter((story) => storyIds.has(story.id)),
      runs: runs.filter((run) => runIds.has(run.id)),
    };
  }

  async getHealthSnapshot(options = {}) {
    const projectId = this._normalizeProjectId(options?.projectId);
    const { stories, prds, runs } = this._buildProjectScope(projectId);
    const storyStatus = {};
    for (const s of stories) storyStatus[s.status] = (storyStatus[s.status] || 0) + 1;

    const prdStatus = {};
    for (const p of prds) prdStatus[p.status] = (prdStatus[p.status] || 0) + 1;
    const runStatus = {};
    for (const r of runs) runStatus[r.status || "unknown"] = (runStatus[r.status || "unknown"] || 0) + 1;

    const queue = this.queue?.healthCheck
      ? await this.queue.healthCheck()
      : {
          ok: false,
          queues: {
            work: { messageCount: -1, consumerCount: -1 },
            retry: { messageCount: -1, consumerCount: -1 },
            dead: { messageCount: -1, consumerCount: -1 },
          },
        };

    const schedulerAlive = this._isAlive(this.heartbeats.schedulerAt);
    const workerAlive = this._isAlive(this.heartbeats.workerAt);
    const executionMode = this._buildExecutionMode();

    return {
      timestamp: nowEast8Iso(),
      queue,
      mode: executionMode.label,
      simulated: executionMode.simulated,
      executionMode,
      service: {
        alive: true,
        available: Boolean(queue.ok && schedulerAlive && workerAlive),
      },
      control: this.control?.getState ? this.control.getState() : { paused: false, pauseReason: null, pauseSource: null },
      scheduler: {
        alive: schedulerAlive,
        lastHeartbeatAt: this.heartbeats.schedulerAt,
      },
      worker: {
        alive: workerAlive,
        lastHeartbeatAt: this.heartbeats.workerAt,
      },
      sessionPool: {
        active: this.sessionPool?.size || 0,
      },
      storyStatus,
      prdStatus,
      runStatus,
      counters: {
        dispatched: this.stats.tasksDispatched,
        completed: this.stats.tasksCompleted,
        failed: this.stats.tasksFailed,
        retryEvents: this.stats.retryEvents,
        deadEvents: this.stats.deadEvents,
      },
      latency: {
        last5m: this._windowLatency(5 * 60_000),
        last15m: this._windowLatency(15 * 60_000),
      },
      uptimeMs: this.stats.startedAt ? Date.now() - Date.parse(this.stats.startedAt) : 0,
    };
  }

  _buildExecutionMode() {
    const dryRun = Boolean(this.config?.dryRun);
    const planOnly = Boolean(this.config?.planOnly);
    const simulated = dryRun || planOnly;

    let label = "live";
    if (dryRun) label = "dry-run";
    else if (planOnly) label = "plan-only";

    return {
      dryRun,
      planOnly,
      simulated,
      label,
    };
  }

  _isAlive(lastHeartbeatAt) {
    if (!lastHeartbeatAt) return false;
    const grace = this.config.monitorHeartbeatGraceMs || 15_000;
    return Date.now() - Date.parse(lastHeartbeatAt) <= grace;
  }

  _recordSnapshot(health) {
    const snapshot = {
      ts: Date.now(),
      dispatched: health.counters.dispatched,
      completed: health.counters.completed,
      failed: health.counters.failed,
      retryEvents: health.counters.retryEvents,
      deadEvents: health.counters.deadEvents,
      queues: {
        work: health.queue?.queues?.work?.messageCount ?? -1,
        retry: health.queue?.queues?.retry?.messageCount ?? -1,
        dead: health.queue?.queues?.dead?.messageCount ?? -1,
      },
      latency5m: health.latency?.last5m || this._windowLatency(5 * 60_000),
      latency15m: health.latency?.last15m || this._windowLatency(15 * 60_000),
    };
    this._history.push(snapshot);

    const historyRetentionMs = this.config.monitorHistoryRetentionMs || 60 * 60_000;
    const cutoff = Date.now() - historyRetentionMs;
    this._history = this._history.filter((h) => h.ts >= cutoff);
  }

  _recordLatencySample(payload, outcome) {
    try {
      if (!payload?.sessionId) return;
      const session = this.store.getSession(payload.sessionId);
      if (!session) return;

      const story = session.storyId ? this.store.getStory(session.storyId) : null;
      const dispatchAt = session.dispatchAt || story?.dispatchAt || null;
      const startAt = session.startedAt || session.startAt || null;
      const finishAt = session.finishedAt || session.finishAt || null;

      const dispatchMs = dispatchAt ? Date.parse(dispatchAt) : NaN;
      const startMs = startAt ? Date.parse(startAt) : NaN;
      const finishMs = finishAt ? Date.parse(finishAt) : Date.now();
      if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) return;

      const processingMs = finishMs - startMs;
      const queueToStartMs = Number.isFinite(dispatchMs) && startMs >= dispatchMs ? startMs - dispatchMs : null;
      const totalMs = Number.isFinite(dispatchMs) && finishMs >= dispatchMs ? finishMs - dispatchMs : processingMs;

      this._latencySamples.push({
        ts: finishMs,
        runId: session.runId || null,
        storyId: session.storyId || null,
        prdId: session.prdId || null,
        phase: session.phase || null,
        attempt: session.attempt || null,
        traceId: session.traceId || null,
        outcome,
        queueToStartMs,
        processingMs,
        totalMs,
      });

      this._pruneLatencySamples();
    } catch (err) {
      this.logger.warn("[monitor] failed to record latency sample", {
        event: "latency_sample_error",
        error: err,
      });
    }
  }

  _pruneLatencySamples() {
    const retentionMs = this.config.latencyRetentionMs || 60 * 60_000;
    const cutoff = Date.now() - retentionMs;
    this._latencySamples = this._latencySamples.filter((s) => s.ts >= cutoff);
  }

  _windowLatency(windowMs) {
    this._pruneLatencySamples();
    const cutoff = Date.now() - windowMs;
    const windowSamples = this._latencySamples.filter((s) => s.ts >= cutoff);

    const totals = windowSamples.map((s) => s.totalMs).filter(Number.isFinite);
    const queueToStart = windowSamples.map((s) => s.queueToStartMs).filter(Number.isFinite);
    const processing = windowSamples.map((s) => s.processingMs).filter(Number.isFinite);
    const successCount = windowSamples.filter((s) => s.outcome === "success").length;
    const failCount = windowSamples.filter((s) => s.outcome === "fail").length;

    const avg = (arr) => (arr.length ? arr.reduce((sum, n) => sum + n, 0) / arr.length : 0);
    return {
      windowMs,
      count: totals.length,
      successCount,
      failCount,
      avgMs: Math.round(avg(totals)),
      p95Ms: Math.round(this._percentile(totals, 95)),
      queueToStartAvgMs: Math.round(avg(queueToStart)),
      processingAvgMs: Math.round(avg(processing)),
    };
  }

  _percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }

  _latencySeries(metricKey, windowMs) {
    const cutoff = Date.now() - windowMs;
    return this._history
      .filter((h) => h.ts >= cutoff)
      .map((h) => ({
        timestamp: toEast8Iso(h.ts),
        count: h[metricKey]?.count || 0,
        avgMs: h[metricKey]?.avgMs || 0,
        p95Ms: h[metricKey]?.p95Ms || 0,
      }));
  }

  _historySeries(windowMs) {
    const cutoff = Date.now() - windowMs;
    return this._history
      .filter((h) => h.ts >= cutoff)
      .map((h) => ({
        ts: h.ts,
        timestamp: toEast8Iso(h.ts),
        queues: {
          work: h.queues?.work ?? -1,
          retry: h.queues?.retry ?? -1,
          dead: h.queues?.dead ?? -1,
        },
        counters: {
          dispatched: h.dispatched ?? 0,
          completed: h.completed ?? 0,
          failed: h.failed ?? 0,
          retryEvents: h.retryEvents ?? 0,
          deadEvents: h.deadEvents ?? 0,
        },
        latency5m: h.latency5m || { avgMs: 0, p95Ms: 0, count: 0 },
        latency15m: h.latency15m || { avgMs: 0, p95Ms: 0, count: 0 },
      }));
  }

  _buildOverviewMetrics(windowMs = 15 * 60_000) {
    const retentionMs = this.config.monitorHistoryRetentionMs || 60 * 60_000;
    const safeWindowMs = Math.max(60_000, Math.min(windowMs, retentionMs));
    const series = this._historySeries(safeWindowMs);
    const latest = series.length ? series[series.length - 1] : null;
    const base = series.length ? series[0] : null;
    const elapsedMs = latest && base ? Math.max(0, latest.ts - base.ts) : 0;

    const delta = {
      dispatched: elapsedMs > 0 ? Math.max(0, latest.counters.dispatched - base.counters.dispatched) : 0,
      completed: elapsedMs > 0 ? Math.max(0, latest.counters.completed - base.counters.completed) : 0,
      failed: elapsedMs > 0 ? Math.max(0, latest.counters.failed - base.counters.failed) : 0,
      retryEvents: elapsedMs > 0 ? Math.max(0, latest.counters.retryEvents - base.counters.retryEvents) : 0,
      deadEvents: elapsedMs > 0 ? Math.max(0, latest.counters.deadEvents - base.counters.deadEvents) : 0,
      queueWork: elapsedMs > 0 ? (latest.queues.work - base.queues.work) : 0,
      queueRetry: elapsedMs > 0 ? (latest.queues.retry - base.queues.retry) : 0,
      queueDead: elapsedMs > 0 ? (latest.queues.dead - base.queues.dead) : 0,
    };

    const safeDispatch = Math.max(1, delta.dispatched);
    const safeTerminal = Math.max(1, delta.completed + delta.failed);
    const perMin = (value) => {
      if (elapsedMs <= 0) return 0;
      return Math.round((value / (elapsedMs / 60_000)) * 100) / 100;
    };

    return {
      timestamp: nowEast8Iso(),
      windowMs: safeWindowMs,
      reportEveryMs: this.config.monitorReportMs || 60_000,
      sampleCount: series.length,
      latest: latest
        ? {
            timestamp: latest.timestamp,
            queues: latest.queues,
            counters: latest.counters,
            latency5m: latest.latency5m,
            latency15m: latest.latency15m,
          }
        : null,
      delta,
      rates: {
        successRate: Math.round((delta.completed / safeTerminal) * 10_000) / 100,
        failRate: Math.round((delta.failed / safeTerminal) * 10_000) / 100,
        retryRatePerDispatch: Math.round((delta.retryEvents / safeDispatch) * 10_000) / 100,
        deadRatePerDispatch: Math.round((delta.deadEvents / safeDispatch) * 10_000) / 100,
        dispatchedPerMin: perMin(delta.dispatched),
        completedPerMin: perMin(delta.completed),
        failedPerMin: perMin(delta.failed),
      },
      series,
    };
  }

  async _evaluateAlerts(health) {
    const now = Date.now();
    const deadCount = health.queue?.queues?.dead?.messageCount ?? 0;
    await this._checkSustainedRule({
      ruleId: "dead_queue_nonzero",
      condition: deadCount > 0,
      durationMs: this.config.alertDeadDurationMs || 2 * 60_000,
      now,
      message: "dead queue has messages for sustained period",
      details: { deadCount },
    });

    const retryWindowMs = this.config.alertRetryDurationMs || 5 * 60_000;
    const retryWindow = this._windowRate(retryWindowMs, "retryEvents", "dispatched");
    await this._checkWindowRule({
      ruleId: "high_retry_rate",
      ready: retryWindow.ready,
      condition: retryWindow.rate > (this.config.alertRetryRateThreshold || 0.2),
      now,
      message: "retry rate exceeded threshold in configured window",
      details: { ...retryWindow, windowMs: retryWindowMs },
    });

    const stuckWindowMs = this.config.alertStuckDurationMs || 3 * 60_000;
    const stuckWindow = this._windowDelta(stuckWindowMs);
    await this._checkWindowRule({
      ruleId: "work_queue_stuck_growth",
      ready: stuckWindow.ready,
      condition: stuckWindow.workDelta > 0 && stuckWindow.completedDelta <= 0,
      now,
      message: "work queue rising while completed count not increasing",
      details: { ...stuckWindow, windowMs: stuckWindowMs },
    });
  }

  _windowRate(windowMs, numeratorKey, denominatorKey) {
    if (this._history.length < 2) return { ready: false, rate: 0 };
    const latest = this._history[this._history.length - 1];
    const base = this._findBaseSnapshot(windowMs);
    if (!base) return { ready: false, rate: 0 };

    const elapsedMs = latest.ts - base.ts;
    const numerator = latest[numeratorKey] - base[numeratorKey];
    const denominator = latest[denominatorKey] - base[denominatorKey];
    const rate = denominator > 0 ? numerator / denominator : 0;

    return {
      ready: elapsedMs >= windowMs,
      elapsedMs,
      numerator,
      denominator,
      rate,
    };
  }

  _windowDelta(windowMs) {
    if (this._history.length < 2) return { ready: false };
    const latest = this._history[this._history.length - 1];
    const base = this._findBaseSnapshot(windowMs);
    if (!base) return { ready: false };

    const elapsedMs = latest.ts - base.ts;
    return {
      ready: elapsedMs >= windowMs,
      elapsedMs,
      workDelta: latest.queues.work - base.queues.work,
      completedDelta: latest.completed - base.completed,
      deadDelta: latest.queues.dead - base.queues.dead,
    };
  }

  _findBaseSnapshot(windowMs) {
    const target = Date.now() - windowMs;
    let candidate = null;
    for (const snap of this._history) {
      if (snap.ts <= target) candidate = snap;
    }
    return candidate;
  }

  async _checkSustainedRule({ ruleId, condition, durationMs, now, message, details }) {
    const state = this._alertState.get(ruleId) || { activeSince: null, lastSentAt: 0 };

    if (!condition) {
      state.activeSince = null;
      this._alertState.set(ruleId, state);
      return;
    }

    if (!state.activeSince) state.activeSince = now;
    const sustainedMs = now - state.activeSince;
    if (sustainedMs < durationMs) {
      this._alertState.set(ruleId, state);
      return;
    }

    if (now - state.lastSentAt < (this.config.alertCooldownMs || 60_000)) {
      this._alertState.set(ruleId, state);
      return;
    }

    state.lastSentAt = now;
    this._alertState.set(ruleId, state);
    await this._emitAlert({
      ruleId,
      message,
      details: { ...details, sustainedMs, thresholdMs: durationMs },
    });
  }

  async _checkWindowRule({ ruleId, ready, condition, now, message, details }) {
    if (!ready || !condition) return;
    const state = this._alertState.get(ruleId) || { activeSince: null, lastSentAt: 0 };
    if (now - state.lastSentAt < (this.config.alertCooldownMs || 60_000)) return;

    state.lastSentAt = now;
    this._alertState.set(ruleId, state);
    await this._emitAlert({ ruleId, message, details });
  }

  async _emitAlert({ ruleId, message, details }) {
    const alert = {
      timestamp: nowEast8Iso(),
      ruleId,
      message,
      details,
    };

    this._alertEvents.push(alert);
    if (this._alertEvents.length > 1_000) {
      this._alertEvents = this._alertEvents.slice(this._alertEvents.length - 1_000);
    }

    this.logger.warn("[monitor] alert triggered", {
      event: "alert",
      alertRule: ruleId,
      alert,
    });

    if (!this.config.alertWebhookUrl) return;
    try {
      await fetch(this.config.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alert),
      });
    } catch (err) {
      this.logger.error("[monitor] alert webhook delivery failed", {
        event: "alert_webhook_failed",
        error: err,
        alertRule: ruleId,
      });
    }
  }

  async _persistDeadLetter(payload) {
    if (!payload || !this.config.deadLetterLogFile) return;

    const line = `${JSON.stringify({
      timestamp: nowEast8Iso(),
      level: "error",
      event: "dead_letter",
      runId: payload.runId || null,
      storyId: payload.storyId || null,
      prdId: payload.prdId || null,
      phase: payload.phase || null,
      attempt: payload.attempt || null,
      traceId: payload.traceId || null,
      worktreeId: payload.worktreeId || null,
      worktreePath: payload.worktreePath || null,
      error: payload.lastError || payload.error || null,
      lastError: payload.lastError || payload.error || null,
      payload,
    })}\n`;

    const file = this.config.deadLetterLogFile;
    await fsp.mkdir(path.dirname(file), { recursive: true });

    this._deadLetterWrite = this._deadLetterWrite.then(() => fsp.appendFile(file, line, "utf8"));
    await this._deadLetterWrite;
  }

  _buildStoriesSnapshot(limit = 50, projectId = null) {
    const allStories = this._buildProjectScope(projectId).stories;
    const byStatus = {};
    const byPhase = {};

    for (const story of allStories) {
      const statusKey = story.status || "unknown";
      const phaseKey = story.phase || "unknown";
      byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;
      byPhase[phaseKey] = (byPhase[phaseKey] || 0) + 1;
    }

    const items = [...allStories]
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
      .slice(0, limit)
      .map((story) => {
        const currentRun = story.currentRunId ? this.store.getRun(story.currentRunId) : null;
        const storyDependencyCount = Array.isArray(story.dependencies) ? story.dependencies.length : 0;
        const prdDependencyCount = Array.isArray(story.prdDependencies) ? story.prdDependencies.length : 0;
        return {
          storyId: story.id,
          prdId: story.prdId || null,
          status: story.status || null,
          phase: story.phase || null,
          attempt: story.attempt || null,
          traceId: story.traceId || null,
          currentRunId: story.currentRunId || null,
          currentRunStatus: currentRun?.status || null,
          dependencyCount: storyDependencyCount + prdDependencyCount,
          storyDependencyCount,
          prdDependencyCount,
          updatedAt: story.updatedAt || null,
        };
      });

    return {
      timestamp: nowEast8Iso(),
      totals: {
        all: allStories.length,
        byStatus,
        byPhase,
      },
      items,
    };
  }

  _buildStoryDetail(storyId, runLimit = 20) {
    const story = this.store.getStory(storyId);
    if (!story) return null;

    const prd = story.prdId ? this.store.getPrd(story.prdId) : null;
    const currentRun = story.currentRunId ? this.store.getRun(story.currentRunId) : null;
    const cappedLimit = Math.max(1, Math.min(200, runLimit));

    const recentRuns = this.store
      .listRuns({ storyId: story.id })
      .sort((a, b) => Date.parse(b.updatedAt || b.dispatchAt || 0) - Date.parse(a.updatedAt || a.dispatchAt || 0))
      .slice(0, cappedLimit)
      .map((run) => ({
        runId: run.id,
        phase: run.phase || null,
        status: run.status || null,
        attempt: run.attempt || null,
        traceId: run.traceId || null,
        dispatchAt: run.dispatchAt || null,
        startAt: run.startAt || null,
        finishAt: run.finishAt || null,
        updatedAt: run.updatedAt || null,
        exitCode: run.exitCode ?? null,
        error: run.error || null,
        errorCode: run.errorCode || null,
        errorSource: run.errorSource || null,
        sessionId: run.sessionId || null,
      }));

    const recentSessions = this.store
      .listSessions({ storyId: story.id })
      .sort((a, b) => Date.parse(b.updatedAt || b.finishedAt || b.startedAt || 0) - Date.parse(a.updatedAt || a.finishedAt || a.startedAt || 0))
      .slice(0, Math.min(cappedLimit, 50))
      .map((session) => ({
        sessionId: session.id,
        runId: session.runId || null,
        status: session.status || null,
        phase: session.phase || null,
        attempt: session.attempt || null,
        traceId: session.traceId || null,
        tool: session.tool || null,
        pid: session.pid ?? null,
        timeoutMs: session.timeoutMs ?? null,
        inactivityTimeoutMs: session.inactivityTimeoutMs ?? null,
        createdAt: session.createdAt || null,
        startedAt: session.startedAt || null,
        finishedAt: session.finishedAt || null,
        updatedAt: session.updatedAt || null,
        error: typeof session.error === "string" ? session.error : session.error?.message || null,
        execution: session.execution || null,
      }));

    return {
      timestamp: nowEast8Iso(),
      story: {
        ...story,
        storyId: story.id,
      },
      prd: prd
        ? {
            id: prd.id,
            status: prd.status || null,
            title: prd.title || null,
            order: prd.order || null,
            dependencyPrds: prd.dependencyPrds || [],
            updatedAt: prd.updatedAt || null,
          }
        : null,
      currentRun: currentRun
        ? {
            runId: currentRun.id,
            status: currentRun.status || null,
            phase: currentRun.phase || null,
            attempt: currentRun.attempt || null,
            traceId: currentRun.traceId || null,
            dispatchAt: currentRun.dispatchAt || null,
            startAt: currentRun.startAt || null,
            finishAt: currentRun.finishAt || null,
            exitCode: currentRun.exitCode ?? null,
            error: currentRun.error || null,
            errorCode: currentRun.errorCode || null,
            errorSource: currentRun.errorSource || null,
            updatedAt: currentRun.updatedAt || null,
          }
        : null,
      currentRunDetail: currentRun ? this._buildRunDetail(currentRun.id, 8_000) : null,
      recentRuns,
      recentSessions,
    };
  }

  _buildRunsSnapshot(limit = 100, storyId = null, projectId = null) {
    let allRuns = this._buildProjectScope(projectId).runs;
    if (storyId) {
      allRuns = allRuns.filter((run) => run.storyId === storyId);
    }
    const byStatus = {};
    for (const run of allRuns) {
      const key = run.status || "unknown";
      byStatus[key] = (byStatus[key] || 0) + 1;
    }

    const items = [...allRuns]
      .sort((a, b) => Date.parse(b.updatedAt || b.dispatchAt || 0) - Date.parse(a.updatedAt || a.dispatchAt || 0))
      .slice(0, limit)
      .map((run) => ({
        runId: run.id,
        storyId: run.storyId || null,
        prdId: run.prdId || null,
        phase: run.phase || null,
        status: run.status || null,
        attempt: run.attempt || null,
        traceId: run.traceId || null,
        sessionId: run.sessionId || null,
        dispatchAt: run.dispatchAt || null,
        startAt: run.startAt || null,
        finishAt: run.finishAt || null,
        exitCode: run.exitCode ?? null,
        error: run.error || null,
        errorCode: run.errorCode || null,
        errorSource: run.errorSource || null,
        updatedAt: run.updatedAt || null,
      }));

    return {
      timestamp: nowEast8Iso(),
      totals: {
        all: allRuns.length,
        byStatus,
      },
      items,
    };
  }

  _projectStages() {
    return ["backlog", "in_progress", "review", "done"];
  }

  _normalizeProjectStage(stage) {
    const raw = String(stage || "").trim().toLowerCase();
    const alias = {
      backlog: "backlog",
      todo: "backlog",
      queued: "backlog",
      in_progress: "in_progress",
      "in-progress": "in_progress",
      inprogress: "in_progress",
      active: "in_progress",
      review: "review",
      qa: "review",
      done: "done",
      completed: "done",
      complete: "done",
    };
    return alias[raw] || null;
  }

  _sanitizeProjectInput(body = {}, { partial = false } = {}) {
    const out = {};
    const normalizeOptionalPath = (value) => {
      const raw = String(value || "").trim();
      return raw ? raw.slice(0, 512) : null;
    };

    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      const name = String(body.name || "").trim();
      if (!name && !partial) {
        const err = new Error("invalid_project_name");
        err.statusCode = 400;
        throw err;
      }
      if (name) out.name = name.slice(0, 120);
    } else if (!partial) {
      const err = new Error("missing_project_name");
      err.statusCode = 400;
      throw err;
    }

    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      out.description = String(body.description || "").trim().slice(0, 500);
    } else if (!partial) {
      out.description = "";
    }

    if (Object.prototype.hasOwnProperty.call(body, "stage")) {
      const stage = this._normalizeProjectStage(body.stage);
      if (!stage) {
        const err = new Error("invalid_project_stage");
        err.statusCode = 400;
        throw err;
      }
      out.stage = stage;
    } else if (!partial) {
      out.stage = "backlog";
    }

    if (Object.prototype.hasOwnProperty.call(body, "tags")) {
      const tags = Array.isArray(body.tags)
        ? body.tags
        : String(body.tags || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
      out.tags = tags.slice(0, 8).map((x) => String(x).slice(0, 24));
    } else if (!partial) {
      out.tags = [];
    }

    if (Object.prototype.hasOwnProperty.call(body, "storyCount")) {
      const n = Number.parseInt(body.storyCount, 10);
      out.storyCount = Number.isFinite(n) && n >= 0 ? n : 0;
    } else if (!partial) {
      out.storyCount = 0;
    }

    if (Object.prototype.hasOwnProperty.call(body, "progressPct")) {
      const n = Number.parseInt(body.progressPct, 10);
      out.progressPct = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    } else if (!partial) {
      out.progressPct = 0;
    }

    if (Object.prototype.hasOwnProperty.call(body, "targetDate")) {
      const raw = String(body.targetDate || "").trim();
      out.targetDate = raw ? raw.slice(0, 32) : null;
    } else if (!partial) {
      out.targetDate = null;
    }

    if (Object.prototype.hasOwnProperty.call(body, "bootMode")) {
      const mode = String(body.bootMode || "").trim().toLowerCase();
      const allow = new Set(["resume_existing", "reload_from_prd", "reload_from_roadmap"]);
      if (mode && !allow.has(mode)) {
        const err = new Error("invalid_project_boot_mode");
        err.statusCode = 400;
        throw err;
      }
      out.bootMode = mode || "resume_existing";
    } else if (!partial) {
      out.bootMode = "resume_existing";
    }

    if (Object.prototype.hasOwnProperty.call(body, "workspacePath")) {
      out.workspacePath = normalizeOptionalPath(body.workspacePath);
    } else if (!partial) {
      out.workspacePath = null;
    }

    if (Object.prototype.hasOwnProperty.call(body, "prdFile")) {
      out.prdFile = normalizeOptionalPath(body.prdFile);
    } else if (!partial) {
      out.prdFile = null;
    }

    if (Object.prototype.hasOwnProperty.call(body, "roadmapFile")) {
      out.roadmapFile = normalizeOptionalPath(body.roadmapFile);
    } else if (!partial) {
      out.roadmapFile = null;
    }

    return out;
  }

  _buildProjectsSnapshot(limit = 200) {
    let stored = this.store.listProjects();
    if (stored.length === 0) {
      const seed = this._buildWorkspaceDefaultProject();
      if (seed) {
        this.store.setProject({
          ...seed,
          source: "store",
        });
        stored = this.store.listProjects();
      }
    }

    const source = "store";
    const items = stored
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        name: item.name || "Untitled",
        description: item.description || "",
        stage: this._normalizeProjectStage(item.stage) || "backlog",
        tags: Array.isArray(item.tags) ? item.tags : [],
        storyCount: Number.isFinite(item.storyCount) ? item.storyCount : 0,
        progressPct: Number.isFinite(item.progressPct) ? item.progressPct : 0,
        targetDate: item.targetDate || null,
        bootMode: item.bootMode || "resume_existing",
        workspacePath: item.workspacePath || null,
        prdFile: item.prdFile || null,
        roadmapFile: item.roadmapFile || null,
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null,
        source: item.source || source,
      }));

    const byStage = {
      backlog: 0,
      in_progress: 0,
      review: 0,
      done: 0,
    };
    for (const item of items) byStage[item.stage] = (byStage[item.stage] || 0) + 1;

    return {
      timestamp: nowEast8Iso(),
      source,
      totals: {
        all: items.length,
        byStage,
      },
      items,
    };
  }

  _buildWorkspaceDefaultProject() {
    const workspacePath = path.resolve(this.config.workspace || process.cwd());
    const baseName = path.basename(workspacePath) || "project";
    const slug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
    const now = nowEast8Iso();
    const prdFile = this.config.prdFile
      ? path.resolve(this.config.prdFile)
      : path.resolve(workspacePath, ".aha-loop", "prd.json");
    const roadmapFile = this.config.roadmapFile
      ? path.resolve(this.config.roadmapFile)
      : path.resolve(workspacePath, ".aha-loop", "project.roadmap.json");

    return {
      id: `proj-${slug}`,
      name: baseName,
      description: `workspace project (${workspacePath})`,
      stage: "backlog",
      tags: ["workspace"],
      storyCount: this.store.listStories().length,
      progressPct: 0,
      targetDate: null,
      bootMode: "resume_existing",
      workspacePath,
      prdFile,
      roadmapFile,
      createdAt: now,
      updatedAt: now,
      source: "workspace_default",
    };
  }

  _parseTailChars(raw, fallback = 12_000) {
    const parsed = raw ? Number.parseInt(raw, 10) : fallback;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(512, Math.min(200_000, parsed));
  }

  _tailText(value, maxChars = 12_000) {
    const text = typeof value === "string" ? value : (value == null ? "" : String(value));
    if (!text) return "";
    if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
    return text.slice(-maxChars);
  }

  _buildRunDetail(runId, tailChars = 12_000) {
    const run = this.store.getRun(runId);
    if (!run) return null;

    let session = run.sessionId ? this.store.getSession(run.sessionId) : null;
    if (!session && run.storyId) {
      const candidates = this.store
        .listSessions({ storyId: run.storyId })
        .filter((item) => item.runId === run.id)
        .sort((a, b) => Date.parse(b.updatedAt || b.finishedAt || 0) - Date.parse(a.updatedAt || a.finishedAt || 0));
      session = candidates[0] || null;
    }
    const story = run.storyId ? this.store.getStory(run.storyId) : null;

    const startMs = run.startAt ? Date.parse(run.startAt) : NaN;
    const dispatchMs = run.dispatchAt ? Date.parse(run.dispatchAt) : NaN;
    const finishMs = run.finishAt ? Date.parse(run.finishAt) : NaN;
    const updatedMs = run.updatedAt ? Date.parse(run.updatedAt) : NaN;
    const beginMs = Number.isFinite(startMs) ? startMs : dispatchMs;
    const endMs = Number.isFinite(finishMs) ? finishMs : updatedMs;
    const durationMs = Number.isFinite(beginMs) && Number.isFinite(endMs) && endMs >= beginMs ? endMs - beginMs : null;

    const stdout = session?.output?.stdout || "";
    const stderr = session?.output?.stderr || "";
    const normalizedSessionError = typeof session?.error === "object" ? session.error : null;
    const normalizedError =
      run.error
      || story?.lastError
      || (typeof session?.error === "string" ? session.error : null)
      || normalizedSessionError?.message
      || null;
    const normalizedErrorCode = run.errorCode || story?.errorCode || normalizedSessionError?.code || null;
    const normalizedErrorSource = run.errorSource || story?.errorSource || normalizedSessionError?.source || null;
    const strictStatus = run.status === "success" && (normalizedErrorCode || normalizedError)
      ? "fail"
      : run.status;

    return {
      timestamp: nowEast8Iso(),
      runId: run.id,
      storyId: run.storyId || null,
      prdId: run.prdId || null,
      phase: run.phase || null,
      status: strictStatus || null,
      attempt: run.attempt || null,
      traceId: run.traceId || null,
      sessionId: run.sessionId || session?.id || null,
      dispatchAt: run.dispatchAt || null,
      startAt: run.startAt || null,
      finishAt: run.finishAt || null,
      updatedAt: run.updatedAt || null,
      durationMs,
      exitCode: run.exitCode ?? (session?.exitCode ?? null),
      error: normalizedError,
      errorCode: normalizedErrorCode,
      errorSource: normalizedErrorSource,
      retryable: story?.retryable ?? (session?.retryable ?? null),
      errorDetail: story?.errorDetail || normalizedSessionError || null,
      session: session
        ? {
            id: session.id,
            status: session.status || null,
            tool: session.tool || null,
            pid: session.pid ?? null,
            worktreePath: session.worktreePath || null,
            timeoutMs: session.timeoutMs ?? null,
            inactivityTimeoutMs: session.inactivityTimeoutMs ?? null,
            createdAt: session.createdAt || null,
            startedAt: session.startedAt || null,
            finishedAt: session.finishedAt || null,
            updatedAt: session.updatedAt || null,
            execution: session.execution || null,
          }
        : null,
      story: story
        ? {
            id: story.id,
            status: story.status || null,
            phase: story.phase || null,
            attempt: story.attempt || null,
            maxAttempts: story.maxAttempts || null,
            lastError: story.lastError || null,
            updatedAt: story.updatedAt || null,
          }
        : null,
      output: {
        tailChars,
        stdout: this._tailText(stdout, tailChars),
        stderr: this._tailText(stderr, tailChars),
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        stdoutTruncated: stdout.length > tailChars,
        stderrTruncated: stderr.length > tailChars,
      },
    };
  }

  _buildAlertsSnapshot(limit = 50) {
    const retryWindowMs = this.config.alertRetryDurationMs || 5 * 60_000;
    const retryWindow = this._windowRate(retryWindowMs, "retryEvents", "dispatched");

    return {
      timestamp: nowEast8Iso(),
      rules: {
        deadQueueNonzero: {
          threshold: "dead > 0",
          durationMs: this.config.alertDeadDurationMs || 2 * 60_000,
        },
        highRetryRate: {
          threshold: this.config.alertRetryRateThreshold || 0.2,
          durationMs: this.config.alertRetryDurationMs || 5 * 60_000,
        },
        workQueueStuckGrowth: {
          threshold: "workDelta > 0 && completedDelta <= 0",
          durationMs: this.config.alertStuckDurationMs || 3 * 60_000,
        },
        cooldownMs: this.config.alertCooldownMs || 60_000,
      },
      runtime: {
        retryWindow,
        alertState: Object.fromEntries(this._alertState.entries()),
      },
      recent: [...this._alertEvents].slice(-limit).reverse(),
    };
  }

  async _readDeadLetters(limit = 50) {
    const file = this.config.deadLetterLogFile;
    try {
      const content = await fsp.readFile(file, "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      const parsed = [];
      for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i--) {
        try {
          parsed.push(JSON.parse(lines[i]));
        } catch {
          // skip malformed line
        }
      }
      return parsed;
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }

  async _buildBootVision() {
    const pipeline = this.store.getPipeline();
    const candidates = [];
    if (pipeline?.visionFile) candidates.push(pipeline.visionFile);
    if (this.config.visionFile) candidates.push(path.resolve(this.config.visionFile));
    candidates.push(path.resolve(this.config.workspace, "project.vision.md"));

    let selected = null;
    let content = null;
    for (const file of candidates) {
      try {
        content = await fsp.readFile(file, "utf8");
        selected = file;
        break;
      } catch {
        // continue
      }
    }

    return {
      timestamp: nowEast8Iso(),
      path: selected,
      exists: Boolean(selected),
      content,
      pipeline: pipeline || null,
    };
  }

  _buildBootWorkspace() {
    const bootInputs = this._bootInputFiles();
    return {
      timestamp: nowEast8Iso(),
      workspaceRoot: this.config.workspace,
      globalHome: this.config.globalHome || null,
      stateFile: this.config.stateFile,
      worktreeDir: this.config.worktreeDir,
      defaultTool: this.config.defaultTool,
      mergeMode: this.config.mergeMode,
      maxConcurrency: this.config.maxConcurrency,
      storyTimeoutMs: this.config.storyTimeoutMs,
      storyInactivityTimeoutMs: this.config.storyInactivityTimeoutMs,
      deliverySemantics: this.config.deliverySemantics,
      ackMode: this.config.rmqAckMode,
      toolPermissions: {
        dangerousBypass: this.config.toolDangerousBypass === true,
        skipGitRepoCheck: this.config.toolSkipGitRepoCheck !== false,
      },
      rmq: {
        url: this.config.rmqUrl,
        managementUrl: this.config.rmqManagementUrl,
        prefetch: this.config.rmqPrefetch || this.config.maxConcurrency || 1,
        workQueue: this.config.workQueue,
        retryQueue: this.config.retryQueue,
        deadQueue: this.config.deadQueue,
      },
      boot: {
        defaultMode: "resume_existing",
        supportedModes: [
          "resume_existing",
          "reload_from_roadmap",
          "reload_from_prd",
        ],
        inputs: bootInputs,
      },
    };
  }

  _bootInputFiles() {
    const ahaLoopRoot = path.resolve(this.config.workspace, ".aha-loop");
    const visionFile = this.config.visionFile ? path.resolve(this.config.visionFile) : path.resolve(ahaLoopRoot, "project.vision.md");
    const roadmapFile = this.config.roadmapFile ? path.resolve(this.config.roadmapFile) : path.resolve(ahaLoopRoot, "project.roadmap.json");
    const prdFile = this.config.prdFile ? path.resolve(this.config.prdFile) : path.resolve(ahaLoopRoot, "prd.json");
    return {
      visionFile,
      roadmapFile,
      prdFile,
    };
  }

  async _pathExists(filePath) {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async _buildBootPreflight() {
    const files = this._bootInputFiles();
    const [health, visionExists, roadmapExists, prdExists] = await Promise.all([
      this.getHealthSnapshot(),
      this._pathExists(files.visionFile),
      this._pathExists(files.roadmapFile),
      this._pathExists(files.prdFile),
    ]);

    return {
      timestamp: nowEast8Iso(),
      defaultMode: "resume_existing",
      supportedModes: [
        "resume_existing",
        "reload_from_roadmap",
        "reload_from_prd",
      ],
      files: {
        vision: { path: files.visionFile, exists: visionExists },
        roadmap: { path: files.roadmapFile, exists: roadmapExists },
        prd: { path: files.prdFile, exists: prdExists },
      },
      runtime: {
        paused: Boolean(health?.control?.paused),
        activeSessions: this.sessionPool?.size || 0,
        queueConnected: Boolean(health?.queue?.ok),
        schedulerAlive: Boolean(health?.scheduler?.alive),
        workerAlive: Boolean(health?.worker?.alive),
      },
    };
  }

  async _handleBootStart(body = {}) {
    const mode = String(body.mode || "resume_existing").toLowerCase();
    const reason = body.reason || "boot_start_requested";
    const autoResume = body.autoResume !== false;
    const resetBeforeLoad = body.resetBeforeLoad !== false;
    const projectId = this._normalizeProjectId(body.projectId);
    const projectWorkspacePath = projectId ? this.store.getProject(projectId)?.workspacePath : null;
    const workspacePath = path.resolve(
      body.workspacePath
      || projectWorkspacePath
      || this.config.workspace
      || process.cwd(),
    );
    const force = body.force === true;
    const files = this._bootInputFiles();

    const activeSessions = this.sessionPool?.size || 0;
    if (!force && activeSessions > 0 && mode !== "resume_existing") {
      const err = new Error("active_sessions_running");
      err.statusCode = 409;
      throw err;
    }

    if (mode === "resume_existing") {
      const payload = this.control?.resume
        ? this.control.resume({ reason })
        : { paused: false, pauseReason: null, pauseSource: null };
      return {
        ok: true,
        mode,
        action: "resume",
        payload,
        runtime: {
          activeSessions: this.sessionPool?.size || 0,
        },
      };
    }

    const wasPaused = Boolean(this.control?.getState?.().paused);
    if (this.control?.pause) {
      this.control.pause(`boot_start_${mode}`, "boot_api");
    }

    try {
      if (mode === "reload_from_roadmap") {
        const roadmapFile = path.resolve(body.roadmapFile || files.roadmapFile);
        if (!(await this._pathExists(roadmapFile))) {
          const err = new Error(`roadmap_file_not_found: ${roadmapFile}`);
          err.statusCode = 400;
          throw err;
        }
        const { loadPrds } = require("../pipeline/prd-loader");
        const options = projectId
          ? { resetBeforeLoad, projectId, workspacePath }
          : { resetBeforeLoad, workspacePath };
        await loadPrds(roadmapFile, this.store, this.logger, options);
        if (autoResume && this.control?.resume) {
          this.control.resume(`boot_start_${mode}`, "boot_api");
        }
        if (!autoResume && wasPaused && this.control?.pause) {
          this.control.pause("restore_previous_pause_state", "boot_api");
        }
        return {
          ok: true,
          mode,
          action: "reload",
          roadmapFile,
          workspacePath,
          resetBeforeLoad,
          autoResume,
        };
      }

      if (mode === "reload_from_prd") {
        const prdFile = path.resolve(body.prdFile || files.prdFile);
        if (!(await this._pathExists(prdFile))) {
          const err = new Error(`prd_file_not_found: ${prdFile}`);
          err.statusCode = 400;
          throw err;
        }
        const { loadActivePrd } = require("../pipeline/prd-loader");
        const options = projectId
          ? { resetBeforeLoad, projectId, workspacePath }
          : { resetBeforeLoad, workspacePath };
        await loadActivePrd(prdFile, this.store, this.logger, options);
        if (autoResume && this.control?.resume) {
          this.control.resume(`boot_start_${mode}`, "boot_api");
        }
        if (!autoResume && wasPaused && this.control?.pause) {
          this.control.pause("restore_previous_pause_state", "boot_api");
        }
        return {
          ok: true,
          mode,
          action: "reload",
          prdFile,
          workspacePath,
          resetBeforeLoad,
          autoResume,
        };
      }

      const invalid = new Error(`unsupported_boot_mode: ${mode}`);
      invalid.statusCode = 400;
      throw invalid;
    } catch (err) {
      if (wasPaused && this.control?.pause) {
        this.control.pause("restore_previous_pause_state", "boot_api");
      }
      throw err;
    }
  }

  async _handleProjectControl(projectId, body = {}) {
    if (!projectId) {
      const err = new Error("project_not_found");
      err.statusCode = 404;
      throw err;
    }
    if (!this.control) {
      const err = new Error("control_not_enabled");
      err.statusCode = 501;
      throw err;
    }

    const project = this.store.getProject(projectId);
    if (!project) {
      const err = new Error("project_not_found");
      err.statusCode = 404;
      throw err;
    }

    const action = String(body.action || "").trim().toLowerCase();
    const now = nowEast8Iso();
    const reason = body.reason || `project_${action || "control"}_requested`;

    if (action === "start") {
      const mode = String(body.mode || project.bootMode || "resume_existing").toLowerCase();
      const resetBeforeLoad = Object.prototype.hasOwnProperty.call(body, "resetBeforeLoad")
        ? body.resetBeforeLoad === true
        : false;
      const payload = await this._handleBootStart({
        mode,
        reason,
        autoResume: body.autoResume !== false,
        resetBeforeLoad,
        force: body.force === true,
        projectId,
        prdFile: body.prdFile || project.prdFile || undefined,
        roadmapFile: body.roadmapFile || project.roadmapFile || undefined,
      });
      this.store.setProject({
        ...project,
        stage: "in_progress",
        bootMode: mode,
        prdFile: body.prdFile || project.prdFile || null,
        roadmapFile: body.roadmapFile || project.roadmapFile || null,
        source: "store",
        lastControlAction: "start",
        lastControlAt: now,
      });
      return { ok: true, action, mode, payload, projectId };
    }

    if (action === "pause") {
      const payload = this.control.pause({ reason });
      this.store.setProject({
        ...project,
        source: "store",
        lastControlAction: "pause",
        lastControlAt: now,
      });
      return { ok: true, action, payload, projectId };
    }

    if (action === "resume") {
      const payload = this.control.resume({ reason });
      this.store.setProject({
        ...project,
        stage: project.stage === "backlog" ? "in_progress" : project.stage,
        source: "store",
        lastControlAction: "resume",
        lastControlAt: now,
      });
      return { ok: true, action, payload, projectId };
    }

    if (action === "restart") {
      const payload = this.control.restart({
        runId: body.runId || null,
        storyId: body.storyId || null,
        reason,
        resetAttempts: body.resetAttempts === true,
      });
      return { ok: true, action, payload, projectId };
    }

    if (action === "approve_merge") {
      const payload = await this.control.approveMerge({
        runId: body.runId || null,
        storyId: body.storyId || null,
        reason,
      });
      return { ok: true, action, payload, projectId };
    }

    if (action === "cancel") {
      const payload = this.control.cancel({
        runId: body.runId || null,
        storyId: body.storyId || null,
        reason,
      });
      return { ok: true, action, payload, projectId };
    }

    const err = new Error("invalid_project_control_action");
    err.statusCode = 400;
    throw err;
  }

  _parseLimit(searchParams) {
    const fallback = this.config.monitorApiDefaultLimit || 50;
    const raw = searchParams.get("limit");
    const parsed = raw ? Number.parseInt(raw, 10) : fallback;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(1_000, parsed));
  }

  _parseWindowMs(raw, fallbackMs) {
    if (!raw) return fallbackMs;
    if (/^\d+$/.test(raw)) return Math.max(1_000, Number.parseInt(raw, 10));
    const m = String(raw).trim().toLowerCase().match(/^(\d+)(ms|s|m|h)$/);
    if (!m) return fallbackMs;
    const value = Number.parseInt(m[1], 10);
    const unit = m[2];
    if (!Number.isFinite(value)) return fallbackMs;
    if (unit === "ms") return value;
    if (unit === "s") return value * 1_000;
    if (unit === "m") return value * 60_000;
    if (unit === "h") return value * 60 * 60_000;
    return fallbackMs;
  }

  _buildPrometheusMetrics(health) {
    const lines = [];
    const gauge = (name, value, labels = null) => {
      const numeric = Number.isFinite(value) ? value : 0;
      if (!labels || Object.keys(labels).length === 0) {
        lines.push(`${name} ${numeric}`);
        return;
      }
      const labelText = Object.entries(labels)
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
        .join(",");
      lines.push(`${name}{${labelText}} ${numeric}`);
    };

    gauge("aha_loop_service_alive", health.service?.alive ? 1 : 0);
    gauge("aha_loop_service_available", health.service?.available ? 1 : 0);
    gauge("aha_loop_scheduler_alive", health.scheduler?.alive ? 1 : 0);
    gauge("aha_loop_worker_alive", health.worker?.alive ? 1 : 0);
    gauge("aha_loop_session_pool_active", health.sessionPool?.active || 0);

    for (const [queueName, metrics] of Object.entries(health.queue?.queues || {})) {
      gauge("aha_loop_queue_messages", metrics.messageCount, { queue: queueName });
      gauge("aha_loop_queue_consumers", metrics.consumerCount, { queue: queueName });
    }

    for (const [queueName, count] of Object.entries(health.queue?.runtimeConsumers || {})) {
      gauge("aha_loop_runtime_consumers", count, { queue: queueName });
    }

    gauge("aha_loop_tasks_dispatched_total", health.counters?.dispatched || 0);
    gauge("aha_loop_tasks_completed_total", health.counters?.completed || 0);
    gauge("aha_loop_tasks_failed_total", health.counters?.failed || 0);
    gauge("aha_loop_tasks_retry_events_total", health.counters?.retryEvents || 0);
    gauge("aha_loop_tasks_dead_events_total", health.counters?.deadEvents || 0);

    gauge("aha_loop_latency_avg_ms", health.latency?.last5m?.avgMs || 0, { window: "5m" });
    gauge("aha_loop_latency_p95_ms", health.latency?.last5m?.p95Ms || 0, { window: "5m" });
    gauge("aha_loop_latency_avg_ms", health.latency?.last15m?.avgMs || 0, { window: "15m" });
    gauge("aha_loop_latency_p95_ms", health.latency?.last15m?.p95Ms || 0, { window: "15m" });

    for (const [status, count] of Object.entries(health.storyStatus || {})) {
      gauge("aha_loop_story_status_count", count, { status });
    }
    for (const [status, count] of Object.entries(health.runStatus || {})) {
      gauge("aha_loop_run_status_count", count, { status });
    }

    return `${lines.join("\n")}\n`;
  }

  _staticRoot() {
    return path.resolve(__dirname, "..", "public");
  }

  _contentTypeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".html") return "text/html; charset=utf-8";
    if (ext === ".css") return "text/css; charset=utf-8";
    if (ext === ".js") return "application/javascript; charset=utf-8";
    if (ext === ".json") return "application/json; charset=utf-8";
    if (ext === ".svg") return "image/svg+xml";
    if (ext === ".png") return "image/png";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    return "application/octet-stream";
  }

  _resolveStaticPath(pathname) {
    const decoded = decodeURIComponent(pathname || "/");
    const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const normalized = path.normalize(relative);
    if (normalized.startsWith("..")) return null;
    return path.resolve(this._staticRoot(), normalized);
  }

  async _serveStatic(pathname, res) {
    const filePath = this._resolveStaticPath(pathname);
    if (!filePath) return false;
    if (!filePath.startsWith(this._staticRoot())) return false;

    try {
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) return false;
      const body = await fsp.readFile(filePath);
      this._writeText(res, 200, body, this._contentTypeFor(filePath));
      return true;
    } catch (err) {
      if (err?.code === "ENOENT") return false;
      throw err;
    }
  }

  async _readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      const err = new Error("invalid_json_body");
      err.statusCode = 400;
      throw err;
    }
  }

  _startHttpServer() {
    if (!this.config.monitorHttpPort || this.config.monitorHttpPort <= 0) return;

    this._httpServer = http.createServer(async (req, res) => {
      try {
        const method = String(req.method || "GET").toUpperCase();
        const requestUrl = new URL(req.url || "/", `http://${this.config.monitorHttpHost}:${this.config.monitorHttpPort}`);
        const pathname = requestUrl.pathname;

        if (method === "POST" && pathname === "/boot/start") {
          const body = await this._readJsonBody(req);
          const payload = await this._handleBootStart(body);
          this._writeJson(res, 200, {
            ok: true,
            action: "boot_start",
            payload,
            timestamp: nowEast8Iso(),
          });
          return;
        }

        if (method === "POST" && pathname === "/control") {
          if (!this.control) {
            this._writeJson(res, 501, { error: "control_not_enabled" });
            return;
          }
          const body = await this._readJsonBody(req);
          const action = String(body.action || "").toLowerCase();

          if (action === "pause") {
            const payload = this.control.pause({ reason: body.reason || "manual pause" });
            this._writeJson(res, 200, { ok: true, action, payload, timestamp: nowEast8Iso() });
            return;
          }
          if (action === "resume") {
            const payload = this.control.resume({ reason: body.reason || "manual resume" });
            this._writeJson(res, 200, { ok: true, action, payload, timestamp: nowEast8Iso() });
            return;
          }
          if (action === "cancel") {
            const payload = this.control.cancel({
              runId: body.runId || null,
              storyId: body.storyId || null,
              reason: body.reason || "cancelled_by_operator",
            });
            this._writeJson(res, 200, { ok: true, action, payload, timestamp: nowEast8Iso() });
            return;
          }
          if (action === "restart") {
            const payload = this.control.restart({
              runId: body.runId || null,
              storyId: body.storyId || null,
              reason: body.reason || "restarted_by_operator",
              resetAttempts: body.resetAttempts === true,
            });
            this._writeJson(res, 200, { ok: true, action, payload, timestamp: nowEast8Iso() });
            return;
          }
          if (action === "approve_merge") {
            const payload = await this.control.approveMerge({
              runId: body.runId || null,
              storyId: body.storyId || null,
              reason: body.reason || "merge_approved_by_operator",
            });
            this._writeJson(res, 200, { ok: true, action, payload, timestamp: nowEast8Iso() });
            return;
          }
          if (action === "revive_dead" || action === "revive_dead_all") {
            const payload = this.control.reviveDeadStories({
              prdId: body.prdId || null,
              reason: body.reason || "revived_dead_by_operator",
              resetAttempts: body.resetAttempts !== false,
            });
            this._writeJson(res, 200, { ok: true, action: "revive_dead", payload, timestamp: nowEast8Iso() });
            return;
          }

          this._writeJson(res, 400, { error: "invalid_control_action", action });
          return;
        }

        if (pathname === "/projects") {
          if (method === "GET") {
            const limit = this._parseLimit(requestUrl.searchParams);
            this._writeJson(res, 200, this._buildProjectsSnapshot(limit));
            return;
          }

          if (method === "POST") {
            const body = await this._readJsonBody(req);
            const patch = this._sanitizeProjectInput(body, { partial: false });
            const now = nowEast8Iso();
            const requestedId = String(body.id || "").trim();
            const id = requestedId || `proj-${randomUUID().slice(0, 8)}`;
            if (this.store.getProject(id)) {
              const err = new Error("project_id_conflict");
              err.statusCode = 409;
              throw err;
            }

            const project = {
              id,
              ...patch,
              source: "store",
              createdAt: now,
              updatedAt: now,
            };
            this.store.setProject(project);
            this._writeJson(res, 201, { ok: true, project, timestamp: nowEast8Iso() });
            return;
          }

          this._writeJson(res, 405, { error: "method_not_allowed" });
          return;
        }

        if (pathname.startsWith("/projects/")) {
          const suffix = pathname.slice("/projects/".length);
          const isProjectControl = suffix.endsWith("/control");
          const projectId = decodeURIComponent(
            isProjectControl ? suffix.slice(0, -"/control".length) : suffix,
          );
          if (!projectId) {
            this._writeJson(res, 404, { error: "project_not_found" });
            return;
          }

          if (isProjectControl) {
            if (method !== "POST") {
              this._writeJson(res, 405, { error: "method_not_allowed" });
              return;
            }
            const body = await this._readJsonBody(req);
            const payload = await this._handleProjectControl(projectId, body);
            this._writeJson(res, 200, { ok: true, action: "project_control", payload, timestamp: nowEast8Iso() });
            return;
          }

          if (method === "GET") {
            const snapshot = this._buildProjectsSnapshot(1_000);
            const item = snapshot.items.find((x) => x.id === projectId);
            if (!item) {
              this._writeJson(res, 404, { error: "project_not_found", projectId });
              return;
            }
            this._writeJson(res, 200, { timestamp: nowEast8Iso(), project: item });
            return;
          }

          if (method === "PATCH") {
            const existing = this.store.getProject(projectId);
            if (!existing) {
              this._writeJson(res, 404, { error: "project_not_found", projectId });
              return;
            }
            const body = await this._readJsonBody(req);
            const patch = this._sanitizeProjectInput(body, { partial: true });
            if (!Object.keys(patch).length) {
              this._writeJson(res, 400, { error: "empty_project_patch" });
              return;
            }
            const updated = this.store.setProject({
              ...existing,
              ...patch,
              source: "store",
            });
            this._writeJson(res, 200, { ok: true, project: updated, timestamp: nowEast8Iso() });
            return;
          }

          if (method === "DELETE") {
            const ok = this.store.deleteProject(projectId);
            if (!ok) {
              this._writeJson(res, 404, { error: "project_not_found", projectId });
              return;
            }
            this._writeJson(res, 200, { ok: true, projectId, timestamp: nowEast8Iso() });
            return;
          }

          this._writeJson(res, 405, { error: "method_not_allowed" });
          return;
        }

        if (method !== "GET") {
          this._writeJson(res, 405, { error: "method_not_allowed" });
          return;
        }

        if (pathname === "/health") {
          const projectId = this._normalizeProjectId(requestUrl.searchParams.get("projectId"));
          const payload = await this.getHealthSnapshot({ projectId });
          this._writeJson(res, 200, payload);
          return;
        }

        if (pathname === "/metrics/queues") {
          const queue = await this.queue.healthCheck();
          this._writeJson(res, 200, {
            timestamp: nowEast8Iso(),
            queue,
          });
          return;
        }

        if (pathname === "/metrics/latency") {
          const windowMs = this._parseWindowMs(requestUrl.searchParams.get("window"), 15 * 60_000);
          this._writeJson(res, 200, {
            timestamp: nowEast8Iso(),
            latest: {
              last5m: this._windowLatency(5 * 60_000),
              last15m: this._windowLatency(15 * 60_000),
              window: this._windowLatency(windowMs),
            },
            series: {
              last5m: this._latencySeries("latency5m", 5 * 60_000),
              last15m: this._latencySeries("latency15m", 15 * 60_000),
            },
          });
          return;
        }

        if (pathname === "/metrics/overview") {
          const windowMs = this._parseWindowMs(requestUrl.searchParams.get("window"), 15 * 60_000);
          this._writeJson(res, 200, this._buildOverviewMetrics(windowMs));
          return;
        }

        if (pathname === "/metrics/prometheus") {
          const health = await this.getHealthSnapshot();
          this._writeText(res, 200, this._buildPrometheusMetrics(health), "text/plain; version=0.0.4; charset=utf-8");
          return;
        }

        if (pathname === "/stories") {
          const limit = this._parseLimit(requestUrl.searchParams);
          const projectId = this._normalizeProjectId(requestUrl.searchParams.get("projectId"));
          this._writeJson(res, 200, this._buildStoriesSnapshot(limit, projectId));
          return;
        }

        if (pathname.startsWith("/stories/")) {
          const storyId = decodeURIComponent(pathname.slice("/stories/".length));
          if (!storyId) {
            this._writeJson(res, 404, { error: "story_not_found" });
            return;
          }
          const limit = Math.max(1, Math.min(200, this._parseLimit(requestUrl.searchParams)));
          const detail = this._buildStoryDetail(storyId, limit);
          if (!detail) {
            this._writeJson(res, 404, { error: "story_not_found", storyId });
            return;
          }
          this._writeJson(res, 200, detail);
          return;
        }

        if (pathname === "/runs") {
          const limit = this._parseLimit(requestUrl.searchParams);
          const storyId = requestUrl.searchParams.get("storyId");
          const projectId = this._normalizeProjectId(requestUrl.searchParams.get("projectId"));
          this._writeJson(res, 200, this._buildRunsSnapshot(limit, storyId, projectId));
          return;
        }

        if (pathname.startsWith("/runs/")) {
          const runId = decodeURIComponent(pathname.slice("/runs/".length));
          if (!runId) {
            this._writeJson(res, 404, { error: "run_not_found" });
            return;
          }
          const tailChars = this._parseTailChars(requestUrl.searchParams.get("tail"));
          const detail = this._buildRunDetail(runId, tailChars);
          if (!detail) {
            this._writeJson(res, 404, { error: "run_not_found", runId });
            return;
          }
          this._writeJson(res, 200, detail);
          return;
        }

        if (pathname === "/alerts") {
          const limit = this._parseLimit(requestUrl.searchParams);
          this._writeJson(res, 200, this._buildAlertsSnapshot(limit));
          return;
        }

        if (pathname === "/dead-letters") {
          const limit = this._parseLimit(requestUrl.searchParams);
          const items = await this._readDeadLetters(limit);
          this._writeJson(res, 200, {
            timestamp: nowEast8Iso(),
            count: items.length,
            items,
          });
          return;
        }

        if (pathname === "/boot/workspace") {
          this._writeJson(res, 200, this._buildBootWorkspace());
          return;
        }

        if (pathname === "/boot/preflight") {
          const payload = await this._buildBootPreflight();
          this._writeJson(res, 200, payload);
          return;
        }

        if (pathname === "/boot/vision") {
          const payload = await this._buildBootVision();
          this._writeJson(res, 200, payload);
          return;
        }

        if (await this._serveStatic(pathname, res)) {
          return;
        }

        this._writeJson(res, 404, { error: "not_found" });
      } catch (err) {
        const code = Number(err?.statusCode) || 500;
        this._writeJson(res, code, { error: err.message || "internal_error" });
      }
    });

    this._httpServer.listen(this.config.monitorHttpPort, this.config.monitorHttpHost, () => {
      this.logger.info("[monitor] HTTP health endpoint started", {
        event: "monitor_http_started",
        bindHost: this.config.monitorHttpHost,
        port: this.config.monitorHttpPort,
      });
    });
  }

  _writeJson(res, code, payload) {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(`${JSON.stringify(payload)}\n`);
  }

  _writeText(res, code, payload, contentType = "text/plain; charset=utf-8") {
    res.statusCode = code;
    res.setHeader("Content-Type", contentType);
    res.end(payload);
  }
}

module.exports = { Monitor };
