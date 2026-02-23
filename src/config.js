"use strict";

const path = require("node:path");

const DEFAULTS = {
  // RabbitMQ
  rmqUrl: "amqp://127.0.0.1:5672/%2F",
  rmqHeartbeatSec: 15,
  rmqConnectionTimeoutMs: 10_000,
  rmqPrefetch: 0, // 0 = auto (follow maxConcurrency)

  // RabbitMQ Management HTTP API (metrics/peek)
  rmqManagementUrl: "http://127.0.0.1:15672",
  rmqUser: "guest",
  rmqPass: "guest",
  rmqVhost: "/",
  rmqHttpTimeoutMs: 10_000,
  rmqPollMs: 2_000,
  rmqAckMode: "manual_ack", // amqplib consume + ack/nack

  // 队列名
  workQueue: "aha_loop_jobs",
  retryQueue: "aha_loop_jobs_retry",
  deadQueue: "aha_loop_jobs_dlq",
  retryTtlMs: 10_000,
  deliverySemantics: "at-least-once",

  // 调度
  schedulerPollMs: 5_000,
  maxConcurrency: 3,
  maxAttempts: 3,
  storyTimeoutMs: 0, // <=0 means disabled (no hard runtime timeout)
  storyInactivityTimeoutMs: 600_000, // kill only when no stdout/stderr activity
  failFastOnDead: false,

  // Worker
  sessionPollMs: 3_000,

  // Monitor
  monitorReportMs: 60_000,
  monitorHttpHost: "0.0.0.0",
  monitorHttpPort: 17373,
  monitorHeartbeatGraceMs: 15_000,
  monitorHistoryRetentionMs: 60 * 60_000,
  latencyRetentionMs: 60 * 60_000,
  monitorApiDefaultLimit: 50,
  alertWebhookUrl: null,
  alertDeadDurationMs: 2 * 60_000,
  alertRetryDurationMs: 5 * 60_000,
  alertRetryRateThreshold: 0.2,
  alertStuckDurationMs: 3 * 60_000,
  alertCooldownMs: 60_000,
  deadLetterLogFile: ".aha-loop/dead-letters.jsonl",

  // 存储
  stateFile: ".aha-loop/state.json",

  // 工具
  defaultTool: "codex",
  toolDangerousBypass: false,
  toolSkipGitRepoCheck: true,

  // 流水线
  visionFile: null,
  roadmapFile: null,
  prdFile: null,             // 直接加载单个 prd.json (Time-series-infra 格式)
  architectureFile: ".aha-loop/project.architecture.md",
  roadmapOutputFile: ".aha-loop/project.roadmap.json",
  workspace: process.cwd(),
  planOnly: false,
  resumeFromState: true,
  dryRun: false,             // 不实际 spawn 子进程, 只打印命令

  // Worktree
  worktreeDir: ".worktrees",
  mergeMode: "manual_gate", // manual_gate | auto
};

function loadConfig(argv = []) {
  const config = { ...DEFAULTS };

  // 环境变量覆盖
  if (process.env.RMQ_URL) config.rmqUrl = process.env.RMQ_URL;
  if (process.env.RMQ_HEARTBEAT_SEC) config.rmqHeartbeatSec = parseInt(process.env.RMQ_HEARTBEAT_SEC, 10);
  if (process.env.RMQ_CONNECTION_TIMEOUT_MS) config.rmqConnectionTimeoutMs = parseInt(process.env.RMQ_CONNECTION_TIMEOUT_MS, 10);
  if (process.env.RMQ_PREFETCH) config.rmqPrefetch = parseInt(process.env.RMQ_PREFETCH, 10);
  if (process.env.RMQ_MANAGEMENT_URL) config.rmqManagementUrl = process.env.RMQ_MANAGEMENT_URL;
  if (process.env.RMQ_USER) config.rmqUser = process.env.RMQ_USER;
  if (process.env.RMQ_PASS) config.rmqPass = process.env.RMQ_PASS;
  if (process.env.RMQ_VHOST) config.rmqVhost = process.env.RMQ_VHOST;
  if (process.env.RMQ_HTTP_TIMEOUT_MS) config.rmqHttpTimeoutMs = parseInt(process.env.RMQ_HTTP_TIMEOUT_MS, 10);
  if (process.env.RMQ_POLL_MS) config.rmqPollMs = parseInt(process.env.RMQ_POLL_MS, 10);
  if (process.env.RMQ_ACK_MODE) config.rmqAckMode = process.env.RMQ_ACK_MODE;
  if (process.env.MAX_CONCURRENCY) config.maxConcurrency = parseInt(process.env.MAX_CONCURRENCY, 10);
  if (process.env.MAX_ATTEMPTS) config.maxAttempts = parseInt(process.env.MAX_ATTEMPTS, 10);
  if (process.env.STORY_TIMEOUT_MS) config.storyTimeoutMs = parseInt(process.env.STORY_TIMEOUT_MS, 10);
  if (process.env.STORY_INACTIVITY_TIMEOUT_MS) {
    config.storyInactivityTimeoutMs = parseInt(process.env.STORY_INACTIVITY_TIMEOUT_MS, 10);
  }
  if (process.env.FAIL_FAST_ON_DEAD) config.failFastOnDead = process.env.FAIL_FAST_ON_DEAD === "true";
  if (process.env.DEFAULT_TOOL) config.defaultTool = process.env.DEFAULT_TOOL;
  if (process.env.TOOL_DANGEROUS_BYPASS) config.toolDangerousBypass = process.env.TOOL_DANGEROUS_BYPASS === "true";
  if (process.env.TOOL_SKIP_GIT_REPO_CHECK) config.toolSkipGitRepoCheck = process.env.TOOL_SKIP_GIT_REPO_CHECK !== "false";
  if (process.env.SCHEDULER_POLL_MS) config.schedulerPollMs = parseInt(process.env.SCHEDULER_POLL_MS, 10);
  if (process.env.RETRY_TTL_MS) config.retryTtlMs = parseInt(process.env.RETRY_TTL_MS, 10);
  if (process.env.MONITOR_REPORT_MS) config.monitorReportMs = parseInt(process.env.MONITOR_REPORT_MS, 10);
  if (process.env.MONITOR_HTTP_HOST) config.monitorHttpHost = process.env.MONITOR_HTTP_HOST;
  if (process.env.MONITOR_HTTP_PORT) config.monitorHttpPort = parseInt(process.env.MONITOR_HTTP_PORT, 10);
  if (process.env.MONITOR_HEARTBEAT_GRACE_MS) config.monitorHeartbeatGraceMs = parseInt(process.env.MONITOR_HEARTBEAT_GRACE_MS, 10);
  if (process.env.MONITOR_HISTORY_RETENTION_MS) config.monitorHistoryRetentionMs = parseInt(process.env.MONITOR_HISTORY_RETENTION_MS, 10);
  if (process.env.LATENCY_RETENTION_MS) config.latencyRetentionMs = parseInt(process.env.LATENCY_RETENTION_MS, 10);
  if (process.env.MONITOR_API_DEFAULT_LIMIT) config.monitorApiDefaultLimit = parseInt(process.env.MONITOR_API_DEFAULT_LIMIT, 10);
  if (process.env.ALERT_WEBHOOK_URL) config.alertWebhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (process.env.ALERT_DEAD_DURATION_MS) config.alertDeadDurationMs = parseInt(process.env.ALERT_DEAD_DURATION_MS, 10);
  if (process.env.ALERT_RETRY_DURATION_MS) config.alertRetryDurationMs = parseInt(process.env.ALERT_RETRY_DURATION_MS, 10);
  if (process.env.ALERT_RETRY_RATE_THRESHOLD) config.alertRetryRateThreshold = parseFloat(process.env.ALERT_RETRY_RATE_THRESHOLD);
  if (process.env.ALERT_STUCK_DURATION_MS) config.alertStuckDurationMs = parseInt(process.env.ALERT_STUCK_DURATION_MS, 10);
  if (process.env.ALERT_COOLDOWN_MS) config.alertCooldownMs = parseInt(process.env.ALERT_COOLDOWN_MS, 10);
  if (process.env.DEAD_LETTER_LOG_FILE) config.deadLetterLogFile = process.env.DEAD_LETTER_LOG_FILE;
  if (process.env.DELIVERY_SEMANTICS) config.deliverySemantics = process.env.DELIVERY_SEMANTICS;
  if (process.env.ARCHITECTURE_FILE) config.architectureFile = process.env.ARCHITECTURE_FILE;
  if (process.env.ROADMAP_OUTPUT_FILE) config.roadmapOutputFile = process.env.ROADMAP_OUTPUT_FILE;
  if (process.env.RESUME_FROM_STATE) config.resumeFromState = process.env.RESUME_FROM_STATE !== "false";
  if (process.env.MERGE_MODE) config.mergeMode = process.env.MERGE_MODE;

  // CLI 参数解析
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--vision":
        config.visionFile = argv[++i];
        break;
      case "--roadmap":
        config.roadmapFile = argv[++i];
        break;
      case "--prd":
        config.prdFile = argv[++i];
        break;
      case "--workspace":
        config.workspace = argv[++i];
        break;
      case "--tool":
        config.defaultTool = argv[++i];
        break;
      case "--tool-dangerous-bypass":
        config.toolDangerousBypass = true;
        break;
      case "--no-tool-dangerous-bypass":
        config.toolDangerousBypass = false;
        break;
      case "--no-skip-git-repo-check":
        config.toolSkipGitRepoCheck = false;
        break;
      case "--max-concurrency":
        config.maxConcurrency = parseInt(argv[++i], 10);
        break;
      case "--monitor-port":
        config.monitorHttpPort = parseInt(argv[++i], 10);
        break;
      case "--architecture-output":
        config.architectureFile = argv[++i];
        break;
      case "--roadmap-output":
        config.roadmapOutputFile = argv[++i];
        break;
      case "--plan-only":
        config.planOnly = true;
        break;
      case "--resume-from-state":
        config.resumeFromState = true;
        break;
      case "--no-resume-from-state":
        config.resumeFromState = false;
        break;
      case "--dry-run":
        config.dryRun = true;
        break;
      case "--merge-mode":
        config.mergeMode = String(argv[++i] || "");
        break;
    }
  }

  // 解析绝对路径
  config.workspace = path.resolve(config.workspace);
  config.stateFile = path.resolve(config.workspace, config.stateFile);
  config.worktreeDir = path.resolve(config.workspace, config.worktreeDir);
  config.deadLetterLogFile = path.resolve(config.workspace, config.deadLetterLogFile);
  config.architectureFile = path.isAbsolute(config.architectureFile)
    ? config.architectureFile
    : path.resolve(config.workspace, config.architectureFile);
  config.roadmapOutputFile = path.isAbsolute(config.roadmapOutputFile)
    ? config.roadmapOutputFile
    : path.resolve(config.workspace, config.roadmapOutputFile);
  if (config.prdFile) config.prdFile = path.resolve(config.prdFile);

  const mergeMode = String(config.mergeMode || "manual_gate").trim().toLowerCase();
  config.mergeMode = mergeMode === "auto" ? "auto" : "manual_gate";

  return config;
}

module.exports = { loadConfig, DEFAULTS };
