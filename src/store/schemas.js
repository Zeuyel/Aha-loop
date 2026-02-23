"use strict";

const { StateMachine } = require("../core/state-machine");

// ═══════════════════════════════════════════
// Pipeline 状态机 (vision → architect → roadmap → prd → execute)
// ═══════════════════════════════════════════
const pipelineMachine = new StateMachine("pipeline", {
  states: [
    "loaded",
    "architecting",
    "planning_roadmap",
    "generating_prds",
    "executing",
    "completed",
    "failed",
  ],
  transitions: [
    { from: "loaded",            to: "architecting",      action: "start_architect" },
    { from: "architecting",      to: "planning_roadmap",  action: "architect_done" },
    { from: "architecting",      to: "failed",            action: "architect_fail" },
    { from: "planning_roadmap",  to: "generating_prds",   action: "roadmap_done" },
    { from: "planning_roadmap",  to: "failed",            action: "roadmap_fail" },
    { from: "generating_prds",   to: "executing",         action: "prds_loaded" },
    { from: "generating_prds",   to: "failed",            action: "prd_fail" },
    { from: "executing",         to: "completed",         action: "all_done" },
    { from: "executing",         to: "failed",            action: "execute_fail" },
  ],
  initial: "loaded",
});

// ═══════════════════════════════════════════
// PRD 状态机
// ═══════════════════════════════════════════
const prdMachine = new StateMachine("prd", {
  states: ["queued", "active", "completed", "completed_with_errors"],
  transitions: [
    { from: "queued",  to: "active",                action: "activate" },
    { from: "active",  to: "completed",             action: "all_stories_done" },
    { from: "active",  to: "completed_with_errors", action: "has_dead_stories" },
  ],
  initial: "queued",
});

// ═══════════════════════════════════════════
// Story 状态机
// ═══════════════════════════════════════════
const storyMachine = new StateMachine("story", {
  states: [
    "pending",
    "queued",
    "running",
    "phase_done",
    "merging",
    "completed",
    "failed",
    "dead",
  ],
  transitions: [
    { from: "pending",    to: "queued",     action: "dispatch" },
    { from: "pending",    to: "failed",     action: "dispatch_fail" },
    { from: "pending",    to: "running",    action: "recover_running_from_pending" },
    { from: "queued",     to: "pending",    action: "recover_queued" },
    { from: "queued",     to: "failed",     action: "publish_fail" },
    { from: "queued",     to: "running",    action: "consume" },
    { from: "running",    to: "pending",    action: "recover_running" },
    { from: "running",    to: "phase_done", action: "succeed" },
    { from: "running",    to: "failed",     action: "fail" },
    { from: "phase_done", to: "pending",    action: "advance_phase" },
    { from: "phase_done", to: "merging",    action: "start_merge" },
    { from: "merging",    to: "completed",  action: "merge_ok" },
    { from: "merging",    to: "failed",     action: "merge_conflict" },
    { from: "failed",     to: "pending",    action: "retry" },
    { from: "failed",     to: "dead",       action: "give_up" },
  ],
  initial: "pending",
});

// ═══════════════════════════════════════════
// Story 阶段定义 (可按 story 配置裁剪)
// 统一规范: research → explore → plan → implement → review
// ═══════════════════════════════════════════
const STORY_PHASES = ["research", "explore", "plan", "implement", "review"];

/** 归一化 story phase 名称 */
function normalizeStoryPhase(phase) {
  if (!phase) return null;
  const key = String(phase).trim().toLowerCase();
  const alias = {
    exploration: "explore",
    planreview: "plan",
    "plan-review": "plan",
    plan_review: "plan",
    qualityreview: "review",
    quality_review: "review",
    "quality-review": "review",
    quality: "review",
    qa: "review",
  };
  return alias[key] || key;
}

/** 获取下一个阶段 (如果是最后一个阶段返回 null) */
function nextPhase(currentPhase, enabledPhases = STORY_PHASES) {
  const normalizedCurrent = normalizeStoryPhase(currentPhase);
  const normalizedEnabled = (enabledPhases || STORY_PHASES)
    .map((p) => normalizeStoryPhase(p))
    .filter(Boolean);

  const idx = normalizedEnabled.indexOf(normalizedCurrent);
  if (idx < 0 || idx >= normalizedEnabled.length - 1) return null;
  return normalizedEnabled[idx + 1];
}

module.exports = {
  pipelineMachine,
  prdMachine,
  storyMachine,
  STORY_PHASES,
  normalizeStoryPhase,
  nextPhase,
};
