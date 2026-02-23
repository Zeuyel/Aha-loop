"use strict";

const { EventEmitter } = require("node:events");

let _instance = null;

/**
 * 进程内事件总线 (单例)
 * 用于模块间解耦通信: session → scheduler, monitor 等
 */
class EventBus extends EventEmitter {
  constructor(logger = console) {
    super();
    this.logger = logger;
    this.setMaxListeners(50);
  }

  /**
   * 发布事件
   * @param {string} event - 事件名
   * @param {*} data - 事件数据
   */
  fire(event, data) {
    this.logger.debug?.(`[event-bus] ${event}`);
    this.emit(event, data);
  }

  /**
   * 等待某个事件 (一次性)
   * @param {string} event
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<*>}
   */
  waitFor(event, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener(event, handler);
        reject(new Error(`[event-bus] timeout waiting for ${event}`));
      }, timeoutMs);

      const handler = (data) => {
        clearTimeout(timer);
        resolve(data);
      };

      this.once(event, handler);
    });
  }
}

/** 获取全局单例 */
function getEventBus(logger) {
  if (!_instance) {
    _instance = new EventBus(logger);
  }
  return _instance;
}

module.exports = { EventBus, getEventBus };

