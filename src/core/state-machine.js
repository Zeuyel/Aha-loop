"use strict";

const { nowEast8Iso } = require("./time");

/**
 * 通用有限状态机引擎
 * 不含业务逻辑，只做状态转换验证和执行
 */
class StateMachine {
  /**
   * @param {string} name - 状态机名称 (用于错误信息)
   * @param {Object} definition
   * @param {string[]} definition.states - 所有合法状态
   * @param {Array<{from: string, to: string, action: string}>} definition.transitions
   * @param {string} definition.initial - 初始状态
   */
  constructor(name, { states, transitions, initial }) {
    this.name = name;
    this.states = new Set(states);
    this.initial = initial;

    // 构建转换查找表: Map<"from→to", action>
    this._transitions = new Map();
    // 构建出口表: Map<from, [{to, action}]>
    this._exits = new Map();

    for (const t of transitions) {
      const key = `${t.from}→${t.to}`;
      this._transitions.set(key, t.action);

      if (!this._exits.has(t.from)) {
        this._exits.set(t.from, []);
      }
      this._exits.get(t.from).push({ to: t.to, action: t.action });
    }
  }

  /** 检查转换是否合法 */
  canTransition(currentState, targetState) {
    return this._transitions.has(`${currentState}→${targetState}`);
  }

  /**
   * 执行状态转换
   * @param {Object} entity - 包含 status 字段的实体
   * @param {string} targetState - 目标状态
   * @param {Object} [patch] - 额外要合并的字段
   * @returns {Object} 更新后的实体
   * @throws {Error} 如果转换不合法
   */
  transition(entity, targetState, patch = {}) {
    const current = entity.status;
    if (!this.canTransition(current, targetState)) {
      const valid = this.validTransitions(current);
      throw new Error(
        `[${this.name}] illegal transition: ${current} → ${targetState}. ` +
        `Valid: ${valid.map((v) => v.to).join(", ") || "none (terminal state)"}`
      );
    }
    return {
      ...entity,
      ...patch,
      status: targetState,
      _lastTransition: {
        from: current,
        to: targetState,
        action: this._transitions.get(`${current}→${targetState}`),
        at: nowEast8Iso(),
      },
    };
  }

  /** 获取某状态的所有合法出口 */
  validTransitions(currentState) {
    return this._exits.get(currentState) || [];
  }

  /** 检查是否为终态 (无出口) */
  isTerminal(state) {
    return this.validTransitions(state).length === 0;
  }
}

module.exports = { StateMachine };
