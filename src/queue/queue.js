"use strict";

const amqp = require("amqplib");
const { once } = require("node:events");
const { withRetry, isTransientError } = require("../core/retry");
const { nowEast8Iso } = require("../core/time");

/**
 * RabbitMQ 客户端 — amqplib consumer + Management API metrics
 *
 * 三队列拓扑 (work / retry / dead):
 *   work  — 主任务队列
 *   retry — TTL 延迟重试 (到期后 DLX 回到 work)
 *   dead  — 终态死信
 *
 * 默认语义: at-least-once (manual ack).
 */
function createQueueClient(config, eventBus, logger = console) {
  let _connection = null;
  let _publishChannel = null;
  let _workChannel = null;
  let _deadChannel = null;
  let _workerHeartbeatTimer = null;
  let _closed = false;

  const _consumerTags = {
    work: null,
    dead: null,
  };

  function _authHeader() {
    const pair = `${config.rmqUser}:${config.rmqPass}`;
    return `Basic ${Buffer.from(pair).toString("base64")}`;
  }

  async function _request(method, path, body) {
    const url = `${config.rmqManagementUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.rmqHttpTimeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          Authorization: _authHeader(),
          "Content-Type": "application/json",
        },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text();
        const err = new Error(`RabbitMQ API ${method} ${path} → ${resp.status}: ${text}`);
        err.statusCode = resp.status;
        throw err;
      }
      if (resp.status === 204) return null;
      const text = await resp.text();
      return text && text.trim() ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  function _vhost() {
    return encodeURIComponent(config.rmqVhost);
  }

  function _q(name) {
    return encodeURIComponent(name);
  }

  async function _ensureQueue(name, args = {}) {
    const channel = await _connection.createChannel();
    try {
      await channel.assertQueue(name, {
        durable: true,
        autoDelete: false,
        arguments: args,
      });
      return channel;
    } catch (err) {
      try { await channel.close(); } catch {}

      const message = String(err?.message || "");
      const isTopologyMismatch = message.includes("PRECONDITION_FAILED") || message.includes("inequivalent arg");
      if (!isTopologyMismatch) {
        throw err;
      }

      // Queue exists but arguments differ from expected; reuse the existing queue.
      const fallback = await _connection.createChannel();
      await fallback.checkQueue(name);
      logger.warn("[queue] queue args mismatch detected, reusing existing queue", {
        event: "queue_topology_mismatch_reuse",
        queue: name,
        error: message,
      });
      return fallback;
    }
  }

  async function _setupTopology() {
    const setupChannels = [];
    try {
      setupChannels.push(await _ensureQueue(config.workQueue, {
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": config.deadQueue,
      }));
      setupChannels.push(await _ensureQueue(config.retryQueue, {
        "x-message-ttl": config.retryTtlMs,
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": config.workQueue,
      }));
      setupChannels.push(await _ensureQueue(config.deadQueue));
    } finally {
      for (const channel of setupChannels) {
        try { await channel.close(); } catch {}
      }
    }
  }

  async function _validateTopology() {
    const expected = [
      {
        queue: config.workQueue,
        args: {
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": config.deadQueue,
        },
      },
      {
        queue: config.retryQueue,
        args: {
          "x-message-ttl": config.retryTtlMs,
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": config.workQueue,
        },
      },
      {
        queue: config.deadQueue,
        args: {},
      },
    ];

    for (const item of expected) {
      try {
        const info = await _request("GET", `/api/queues/${_vhost()}/${_q(item.queue)}`);
        const actual = info?.arguments || {};
        for (const [key, value] of Object.entries(item.args)) {
          if (actual[key] !== value) {
            logger.warn("[queue] topology arg mismatch, existing queue args will be reused", {
              event: "queue_topology_mismatch",
              queue: item.queue,
              argument: key,
              expected: value,
              actual: actual[key] ?? null,
            });
          }
        }
      } catch (err) {
        logger.warn("[queue] topology validation skipped for queue", {
          event: "queue_topology_validation_skipped",
          queue: item.queue,
          error: err.message,
        });
      }
    }
  }

  function _enforceDeliverySemantics() {
    if (config.deliverySemantics === "at-least-once" && config.rmqAckMode !== "manual_ack") {
      logger.warn("[queue] forcing ack mode to manual_ack for at-least-once semantics", {
        event: "delivery_semantics",
        semantics: config.deliverySemantics,
        ackMode: config.rmqAckMode,
      });
      config.rmqAckMode = "manual_ack";
    }
    if (config.deliverySemantics === "at-most-once" && config.rmqAckMode !== "no_ack") {
      logger.warn("[queue] forcing ack mode to no_ack for at-most-once semantics", {
        event: "delivery_semantics",
        semantics: config.deliverySemantics,
        ackMode: config.rmqAckMode,
      });
      config.rmqAckMode = "no_ack";
    }
  }

  async function _connectAmqp() {
    _connection = await amqp.connect(config.rmqUrl, {
      heartbeat: config.rmqHeartbeatSec,
      timeout: config.rmqConnectionTimeoutMs,
    });

    _connection.on("error", (err) => {
      if (_closed) return;
      logger.error("[queue] amqp connection error", {
        event: "queue_connection_error",
        error: err,
      });
    });

    _connection.on("close", () => {
      if (_closed) return;
      logger.error("[queue] amqp connection closed unexpectedly", {
        event: "queue_connection_closed",
      });
      eventBus.fire("queue:disconnected", { at: nowEast8Iso() });
    });

    await _setupTopology();
    await _validateTopology();
    _publishChannel = await _connection.createChannel();
    _workChannel = await _connection.createChannel();
    _deadChannel = await _connection.createChannel();
    const effectivePrefetch = Math.max(1, Number(config.rmqPrefetch) || Number(config.maxConcurrency) || 1);
    await _workChannel.prefetch(effectivePrefetch);
    logger.info("[queue] prefetch configured", {
      event: "queue_prefetch_configured",
      prefetch: effectivePrefetch,
      maxConcurrency: config.maxConcurrency,
    });
  }

  function _startWorkerHeartbeat() {
    if (_workerHeartbeatTimer) return;
    const interval = Math.max(1_000, config.rmqPollMs || 2_000);
    _workerHeartbeatTimer = setInterval(() => {
      eventBus.fire("worker:heartbeat", { at: nowEast8Iso() });
    }, interval);
  }

  function _stopWorkerHeartbeat() {
    if (!_workerHeartbeatTimer) return;
    clearInterval(_workerHeartbeatTimer);
    _workerHeartbeatTimer = null;
  }

  async function connect() {
    _enforceDeliverySemantics();
    await withRetry(
      async () => {
        await _connectAmqp();
        logger.info("[queue] connected via AMQP", {
          event: "queue_connected",
          semantics: config.deliverySemantics,
          ackMode: config.rmqAckMode,
          rmqUrl: config.rmqUrl,
        });
        eventBus.fire("queue:connected", {
          at: nowEast8Iso(),
          semantics: config.deliverySemantics,
          ackMode: config.rmqAckMode,
          transport: "amqplib",
        });
      },
      {
        maxAttempts: 10,
        shouldRetry: isTransientError,
        onRetry: (err, attempt, delay) => {
          logger.warn(`[queue] connect retry ${attempt}: ${err.message} (wait ${delay}ms)`);
        },
      },
    );
  }

  async function _publishToQueue(queueName, payload) {
    if (!_publishChannel) throw new Error("publish channel not ready");

    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const ok = _publishChannel.sendToQueue(queueName, body, {
      persistent: true,
      contentType: "application/json",
      messageId: payload.storyId || payload.id || undefined,
      timestamp: Date.now(),
      type: "aha-loop-task",
    });

    if (!ok) {
      await once(_publishChannel, "drain");
    }
  }

  async function publishTask(taskMessage) {
    const message = {
      ...taskMessage,
      dispatchAt: taskMessage.dispatchAt || nowEast8Iso(),
    };
    await _publishToQueue(config.workQueue, message);
    eventBus.fire("task:dispatched", message);
  }

  function _decodeMessage(msg) {
    const raw = msg?.content?.toString("utf8") || "";
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function _errorMessage(err) {
    if (err == null) return "unknown error";
    if (typeof err === "string") return err;
    if (typeof err?.message === "string" && err.message.trim()) return err.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  function _errorMeta(err, defaults = {}) {
    const message = _errorMessage(err);
    if (err instanceof Error) {
      return {
        code: err.code || defaults.code || "UNHANDLED_EXCEPTION",
        source: defaults.source || "queue_handler",
        message,
        stack: err.stack || null,
      };
    }
    if (typeof err === "object" && err) {
      return {
        code: err.code || defaults.code || "HANDLER_ERROR",
        source: err.source || defaults.source || "queue_handler",
        message,
        ...err,
      };
    }
    return {
      code: defaults.code || "HANDLER_ERROR",
      source: defaults.source || "queue_handler",
      message,
    };
  }

  async function _routeFailure(task, err) {
    const attempt = Number(task.attempt || 1);
    const maxAttempts = Number(task.maxAttempts || config.maxAttempts);
    const failure = _errorMeta(err, { source: "queue_route_failure" });

    if (attempt < maxAttempts) {
      const retried = {
        ...task,
        attempt: attempt + 1,
        lastError: failure.message,
        error: failure,
      };
      await _publishToQueue(config.retryQueue, retried);
      logger.warn("[queue] task routed to retry queue", {
        event: "retry",
        runId: retried.runId || null,
        storyId: retried.storyId || null,
        prdId: retried.prdId || null,
        phase: retried.phase || null,
        attempt: retried.attempt,
        traceId: retried.traceId || null,
        error: failure,
        queue: config.retryQueue,
        maxAttempts,
      });
      eventBus.fire("task:retry", retried);
      return;
    }

    const dead = {
      ...task,
      attempt,
      maxAttempts,
      lastError: failure.message,
      error: failure,
      deadAt: nowEast8Iso(),
    };
    await _publishToQueue(config.deadQueue, dead);
    logger.error("[queue] task routed to dead queue", {
      event: "dead",
      runId: dead.runId || null,
      storyId: dead.storyId || null,
      prdId: dead.prdId || null,
      phase: dead.phase || null,
      attempt: dead.attempt,
      traceId: dead.traceId || null,
      error: failure,
      queue: config.deadQueue,
      maxAttempts,
    });
    eventBus.fire("task:dead", dead);
  }

  async function consumeTasks(handler) {
    if (!_workChannel) throw new Error("work channel not ready");
    _startWorkerHeartbeat();

    const noAck = config.rmqAckMode === "no_ack";
    const result = await _workChannel.consume(
      config.workQueue,
      (msg) => {
        if (!msg) return;
        eventBus.fire("worker:heartbeat", { at: nowEast8Iso() });

        Promise.resolve()
          .then(async () => {
            const task = _decodeMessage(msg);
            if (!task) {
              const decodeErr = new Error("invalid message payload (JSON parse failed)");
              if (!noAck) {
                await _routeFailure({ maxAttempts: 1, attempt: 1 }, decodeErr).catch(() => {});
                _workChannel.ack(msg);
              }
              logger.error("[queue] invalid message payload", {
                event: "fail",
                error: decodeErr.message,
                queue: config.workQueue,
              });
              return;
            }

            try {
              await handler(task);
              if (!noAck) _workChannel.ack(msg);
            } catch (err) {
              if (err?.requeue === true) {
                logger.warn("[queue] task requeued due to transient backpressure", {
                  event: "retry",
                  retryReason: "backpressure_requeue",
                  runId: task.runId || null,
                  storyId: task.storyId || null,
                  prdId: task.prdId || null,
                  phase: task.phase || null,
                  attempt: task.attempt || null,
                  traceId: task.traceId || null,
                  error: err,
                });
                if (!noAck) {
                  _workChannel.nack(msg, false, true);
                } else {
                  logger.warn("[queue] no_ack mode cannot requeue backpressure task", {
                    event: "fail",
                    failureType: "backpressure_drop_no_ack",
                    runId: task.runId || null,
                    storyId: task.storyId || null,
                    prdId: task.prdId || null,
                    phase: task.phase || null,
                    attempt: task.attempt || null,
                    traceId: task.traceId || null,
                  });
                }
                return;
              }

              logger.error("[queue] task handler failed", {
                event: "fail",
                failureType: "task_handler_error",
                runId: task.runId || null,
                storyId: task.storyId || null,
                prdId: task.prdId || null,
                phase: task.phase || null,
                attempt: task.attempt || null,
                traceId: task.traceId || null,
                error: _errorMeta(err, { source: "queue_consumer" }),
              });

              try {
                await _routeFailure(task, err);
                if (!noAck) _workChannel.ack(msg);
              } catch (publishErr) {
                logger.error("[queue] failed to route retry/dead", {
                  event: "queue_route_failure",
                  runId: task.runId || null,
                  storyId: task.storyId || null,
                  traceId: task.traceId || null,
                  error: publishErr,
                });
                if (!noAck) _workChannel.nack(msg, false, true);
              }
            }
          })
          .catch((err) => {
            logger.error("[queue] consume callback fatal", {
              event: "queue_consume_fatal",
              error: err,
            });
            if (!noAck) {
              try { _workChannel.nack(msg, false, true); } catch {}
            }
          });
      },
      { noAck },
    );

    _consumerTags.work = result.consumerTag;
    logger.info("[queue] work consumer started", {
      event: "queue_consumer_started",
      queue: config.workQueue,
      consumerTag: result.consumerTag,
      ackMode: config.rmqAckMode,
      semantics: config.deliverySemantics,
    });
  }

  async function consumeDeadLetters(handler) {
    if (!_deadChannel) throw new Error("dead channel not ready");
    const result = await _deadChannel.consume(
      config.deadQueue,
      (msg) => {
        if (!msg) return;
        Promise.resolve()
          .then(async () => {
            const task = _decodeMessage(msg);
            if (!task) {
              _deadChannel.ack(msg);
              return;
            }
            await handler(task);
            _deadChannel.ack(msg);
          })
          .catch((err) => {
            logger.error("[queue] dead-letter handler failed", {
              event: "queue_dead_handler_failed",
              error: err,
            });
            try { _deadChannel.nack(msg, false, true); } catch {}
          });
      },
      { noAck: false },
    );

    _consumerTags.dead = result.consumerTag;
    logger.info("[queue] dead-letter consumer started", {
      event: "queue_dead_consumer_started",
      queue: config.deadQueue,
      consumerTag: result.consumerTag,
    });
  }

  async function _getQueueInfo(queueName) {
    const info = await _request("GET", `/api/queues/${_vhost()}/${_q(queueName)}`);
    return {
      messageCount: info?.messages ?? 0,
      consumerCount: info?.consumers ?? 0,
    };
  }

  async function getQueueMetrics() {
    const [work, retry, dead] = await Promise.all([
      _getQueueInfo(config.workQueue),
      _getQueueInfo(config.retryQueue),
      _getQueueInfo(config.deadQueue),
    ]);
    return { work, retry, dead };
  }

  async function healthCheck() {
    try {
      const queues = await getQueueMetrics();
      return {
        ok: true,
        semantics: config.deliverySemantics,
        ackMode: config.rmqAckMode,
        transport: "amqplib",
        connected: Boolean(_connection),
        runtimeConsumers: {
          work: _consumerTags.work ? 1 : 0,
          dead: _consumerTags.dead ? 1 : 0,
        },
        queues,
        messageCount: queues.work.messageCount,
        consumerCount: queues.work.consumerCount,
      };
    } catch (err) {
      return {
        ok: false,
        semantics: config.deliverySemantics,
        ackMode: config.rmqAckMode,
        transport: "amqplib",
        connected: Boolean(_connection),
        runtimeConsumers: {
          work: _consumerTags.work ? 1 : 0,
          dead: _consumerTags.dead ? 1 : 0,
        },
        queues: {
          work: { messageCount: -1, consumerCount: -1 },
          retry: { messageCount: -1, consumerCount: -1 },
          dead: { messageCount: -1, consumerCount: -1 },
        },
        messageCount: -1,
        consumerCount: -1,
        error: err.message,
      };
    }
  }

  async function peekMessages(queueName, count = 10) {
    const result = await _request(
      "POST",
      `/api/queues/${_vhost()}/${_q(queueName)}/get`,
      { count, ackmode: "ack_requeue_true", encoding: "auto", truncate: 50000 },
    );
    if (!Array.isArray(result)) return [];
    return result.map((m) => {
      try { return JSON.parse(m.payload); } catch { return m.payload; }
    });
  }

  async function close() {
    _closed = true;
    _stopWorkerHeartbeat();

    try {
      if (_workChannel && _consumerTags.work) {
        await _workChannel.cancel(_consumerTags.work).catch(() => {});
      }
      if (_deadChannel && _consumerTags.dead) {
        await _deadChannel.cancel(_consumerTags.dead).catch(() => {});
      }
    } catch {}

    _consumerTags.work = null;
    _consumerTags.dead = null;

    try { if (_workChannel) await _workChannel.close(); } catch {}
    try { if (_deadChannel) await _deadChannel.close(); } catch {}
    try { if (_publishChannel) await _publishChannel.close(); } catch {}
    try { if (_connection) await _connection.close(); } catch {}

    _workChannel = null;
    _deadChannel = null;
    _publishChannel = null;
    _connection = null;

    logger.info("[queue] closed", {
      event: "queue_closed",
    });
  }

  return {
    connect,
    publishTask,
    consumeTasks,
    consumeDeadLetters,
    healthCheck,
    getQueueMetrics,
    peekMessages,
    close,
  };
}

module.exports = { createQueueClient };
