"use strict";

const os = require("node:os");
const { nowEast8Iso } = require("./time");

function createLogger(baseFields = {}) {
  const host = os.hostname();
  const pid = process.pid;
  const levelOrder = { debug: 10, info: 20, warn: 30, error: 40 };
  const minLevel = String(process.env.LOG_LEVEL || "info").toLowerCase();

  function normalizeError(error) {
    if (error == null) return null;
    if (typeof error === "string") return error;
    if (error instanceof Error) {
      return {
        name: error.name || "Error",
        code: error.code || null,
        message: error.message || String(error),
        stack: error.stack || null,
      };
    }
    if (typeof error === "object") return error;
    if (typeof error?.message === "string") return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  function emit(level, message, meta = {}) {
    if ((levelOrder[level] || 0) < (levelOrder[minLevel] || levelOrder.info)) return;

    const extra = { ...meta };
    const event = extra.event || "log";
    delete extra.event;

    const explicitError = Object.prototype.hasOwnProperty.call(extra, "error")
      ? normalizeError(extra.error)
      : null;
    delete extra.error;

    const record = {
      timestamp: nowEast8Iso(),
      level,
      event,
      storyId: null,
      prdId: null,
      phase: null,
      attempt: null,
      traceId: null,
      error: explicitError,
      message,
      host,
      pid,
      ...baseFields,
    };

    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) record[key] = value;
    }

    const line = JSON.stringify(record);
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  }

  return {
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
    debug: (message, meta) => emit("debug", message, meta),
    child: (fields = {}) => createLogger({ ...baseFields, ...fields }),
  };
}

module.exports = { createLogger };
