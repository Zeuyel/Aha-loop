"use strict";

/**
 * 指数退避 + 抖动重试策略
 */

/** 判断是否为瞬时 HTTP/网络错误 (值得重试) */
function isTransientError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  // HTTP 5xx
  if (err.statusCode && err.statusCode >= 500) return true;
  // 网络错误
  return /econnreset|econnrefused|etimedout|abort|epipe|fetch failed/i.test(msg);
}

/** @deprecated alias — 向后兼容旧名称 */
const isTransientAmqpError = isTransientError;

/**
 * 计算退避延迟 (指数 + 抖动)
 * @param {number} attempt - 当前重试次数 (从 1 开始)
 * @param {number} baseMs - 基础延迟 (默认 1000ms)
 * @param {number} maxMs - 最大延迟 (默认 30000ms)
 * @returns {number} 延迟毫秒数
 */
function backoffDelay(attempt, baseMs = 1000, maxMs = 30_000) {
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxMs);
  const jitter = capped * (0.5 + Math.random() * 0.5); // 50%-100% 的随机抖动
  return Math.round(jitter);
}

/**
 * 带重试的异步函数包装器
 * @param {Function} fn - 要重试的异步函数
 * @param {Object} opts
 * @param {number} opts.maxAttempts - 最大尝试次数
 * @param {Function} [opts.shouldRetry] - 判断是否应该重试
 * @param {Function} [opts.onRetry] - 重试前的回调
 * @param {number} [opts.baseMs] - 基础延迟
 * @param {number} [opts.maxMs] - 最大延迟
 * @returns {Promise<*>}
 */
async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    shouldRetry = () => true,
    onRetry = () => {},
    baseMs = 1000,
    maxMs = 30_000,
  } = opts;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        throw err;
      }
      const delay = backoffDelay(attempt, baseMs, maxMs);
      onRetry(err, attempt, delay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

module.exports = { isTransientError, isTransientAmqpError, backoffDelay, withRetry };

