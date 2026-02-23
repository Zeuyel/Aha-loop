"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { STORY_PHASES, normalizeStoryPhase } = require("../store/schemas");
const { nowEast8Iso } = require("../core/time");

/**
 * PRD Loader — 从 roadmap.json 或 prd.json 加载 PRD 和 Story 到 Store
 */

// ═══════════════════════════════════════════
// 方式 A: 从 roadmap.json 加载 (原逻辑)
// ═══════════════════════════════════════════

async function loadPrds(roadmapFile, store, logger = console, options = {}) {
  const raw = await fsp.readFile(roadmapFile, "utf8");
  const roadmap = JSON.parse(raw);
  const resetBeforeLoad = options.resetBeforeLoad !== false;

  if (resetBeforeLoad && typeof store.resetExecutionState === "function") {
    store.resetExecutionState({ keepPipeline: true });
    logger.info("[prd-loader] cleared previous execution state before loading roadmap");
  }

  const prds = _collectRoadmapPrds(roadmap);
  if (prds.length === 0) {
    logger.warn("[prd-loader] no PRDs found in roadmap");
    return;
  }

  let storyCount = 0;
  for (let i = 0; i < prds.length; i++) {
    const prdData = prds[i];
    const prdId = prdData.id || `PRD-${String(i + 1).padStart(3, "0")}`;
    const prdDependencies = _normalizeDependencyRefs(prdData.dependsOn || prdData.dependencies)
      .filter((ref) => _isPrdRef(ref));

    const prd = {
      id: prdId,
      title: prdData.title || prdData.name || prdId,
      status: _normalizePrdStatus(prdData.status),
      stories: [],
      dependencies: prdDependencies,
      milestoneId: prdData.milestoneId || null,
      milestoneTitle: prdData.milestoneTitle || null,
      workspacePath: store.stateFile ? path.dirname(path.dirname(store.stateFile)) : process.cwd(),
      createdAt: nowEast8Iso(),
    };

    const stories = prdData.stories || prdData.userStories || [];
    for (let j = 0; j < stories.length; j++) {
      const storyData = stories[j];
      const storyId = storyData.id || `${prdId}-US-${String(j + 1).padStart(3, "0")}`;

      const phases = _normalizePhases(storyData.phases || _inferPhases(storyData));
      const { storyDependencies, prdDependencies: storyPrdDependencies } = _splitStoryDependencies(
        storyData,
        prdDependencies,
      );
      const passed = storyData.passes === true || _isCompletedStatus(storyData.status);

      const story = {
        id: storyId,
        prdId,
        title: storyData.title || storyData.name || storyId,
        phase: passed ? phases[phases.length - 1] : phases[0],
        phases,
        status: passed ? "completed" : "pending",
        attempt: 1,
        maxAttempts: storyData.maxAttempts || 3,
        dependencies: storyDependencies,
        prdDependencies: storyPrdDependencies,
        priority: storyData.priority || 99,
        worktreeId: null,
        sessionId: null,
        tool: storyData.tool || null,
        timeoutMs: storyData.timeoutMs ?? null,
        inactivityTimeoutMs: storyData.inactivityTimeoutMs ?? storyData.idleTimeoutMs ?? null,
        createdAt: nowEast8Iso(),
        startedAt: null,
        finishedAt: passed ? nowEast8Iso() : null,
        error: null,
      };

      store.setStory(story);
      prd.stories.push(storyId);
      storyCount++;
    }

    store.setPrd(prd);
  }

  const activated = _activateInitialPrds(store, logger);

  logger.info(`[prd-loader] loaded ${prds.length} PRDs, ${storyCount} stories, active PRDs=${activated.length}`);
}

// ═══════════════════════════════════════════
// 方式 B: 从 prd.json 加载 (Time-series-infra 格式)
// ═══════════════════════════════════════════

/**
 * 从 Time-series-infra 格式的 prd.json 加载活跃 PRD 及其 userStories
 *
 * prd.json 格式:
 * {
 *   "prdId": "PRD-014",
 *   "userStories": [
 *     { "id": "US-001", "passes": true, "researchCompleted": true, ... },
 *     { "id": "US-002", "passes": false, "researchCompleted": false, ... }
 *   ]
 * }
 *
 * passes === true 的 story 标记为 completed, 其余按阶段进度入队.
 */
async function loadActivePrd(prdFile, store, logger = console, options = {}) {
  const raw = await fsp.readFile(prdFile, "utf8");
  const prdData = JSON.parse(raw);
  const resetBeforeLoad = options.resetBeforeLoad !== false;

  if (resetBeforeLoad && typeof store.resetExecutionState === "function") {
    store.resetExecutionState({ keepPipeline: true });
    logger.info("[prd-loader] cleared previous execution state before loading active prd");
  }

  const prdId = prdData.prdId || prdData.id || "PRD-UNKNOWN";
  const stories = prdData.userStories || [];

  if (stories.length === 0) {
    logger.warn(`[prd-loader] prd ${prdId}: no userStories found`);
    return;
  }

  const prd = {
    id: prdId,
    title: prdData.project || prdData.title || prdId,
    status: "queued",
    stories: [],
    dependencies: _normalizeDependencyRefs(prdData.dependsOn || prdData.dependencies).filter((ref) => _isPrdRef(ref)),
    workspacePath: store.stateFile ? path.dirname(path.dirname(store.stateFile)) : process.cwd(),
    createdAt: nowEast8Iso(),
  };

  let pendingCount = 0;
  for (const us of stories) {
    const storyId = us.id || `US-${String(stories.indexOf(us) + 1).padStart(3, "0")}`;
    const phases = _normalizePhases(_inferPhasesFromPrd(us));
    const { storyDependencies, prdDependencies } = _splitStoryDependencies(us, prd.dependencies);
    const passed = us.passes === true || _isCompletedStatus(us.status);

    const story = {
      id: storyId,
      prdId,
      title: us.title || storyId,
      phase: passed ? phases[phases.length - 1] : phases[0],
      phases,
      status: passed ? "completed" : "pending",
      attempt: 1,
      maxAttempts: us.maxAttempts || 3,
      dependencies: storyDependencies,
      prdDependencies,
      priority: us.priority || 99,
      worktreeId: null,
      sessionId: null,
      tool: us.tool || null,
      timeoutMs: us.timeoutMs ?? null,
      inactivityTimeoutMs: us.inactivityTimeoutMs ?? us.idleTimeoutMs ?? null,
      createdAt: nowEast8Iso(),
      startedAt: null,
      finishedAt: passed ? nowEast8Iso() : null,
      error: null,
    };

    store.setStory(story);
    prd.stories.push(storyId);
    if (!passed) pendingCount++;
  }

  store.setPrd(prd);
  store.transitionPrd(prdId, "active");

  logger.info(
    `[prd-loader] loaded PRD ${prdId}: ${stories.length} stories (${pendingCount} pending, ${stories.length - pendingCount} completed)`,
  );
}

// ═══════════════════════════════════════════
// Phase 推断
// ═══════════════════════════════════════════

/** 从 roadmap story 数据推断 phases (原逻辑) */
function _inferPhases(storyData) {
  if (storyData.passes === true || _isCompletedStatus(storyData.status)) {
    return ["implement"];
  }

  const phases = [...STORY_PHASES];
  if (storyData.skipResearch === true || storyData.researchRequired === false || storyData.researchCompleted === true) {
    _removePhase(phases, "research");
  }
  if (
    storyData.skipExplore === true
    || storyData.explorationNeeded === false
    || storyData.explorationCompleted === true
  ) {
    _removePhase(phases, "explore");
  }
  if (storyData.skipPlan === true || storyData.planCompleted === true || storyData.planReviewCompletedAt) {
    _removePhase(phases, "plan");
  }
  if (
    storyData.skipReview === true
    || storyData.reviewCompleted === true
    || storyData.qualityReviewCompleted === true
    || storyData.qualityReviewCompletedAt
  ) {
    _removePhase(phases, "review");
  }

  return phases.length > 0 ? phases : ["implement"];
}

/**
 * 从 Time-series-infra prd.json 的 userStory 推断剩余 phases
 * 已完成的阶段不再列入
 */
function _inferPhasesFromPrd(us) {
  if (us.passes === true) return ["implement"];

  const phases = [...STORY_PHASES];
  if (us.researchCompleted === true) _removePhase(phases, "research");
  if (us.explorationCompleted === true) _removePhase(phases, "explore");
  if (us.planCompleted === true || us.planReviewCompletedAt) _removePhase(phases, "plan");
  if (us.reviewCompleted === true || us.qualityReviewCompleted === true || us.qualityReviewCompletedAt) {
    _removePhase(phases, "review");
  }
  return phases.length > 0 ? phases : ["implement"];
}

/** 统一归一化 phases，剔除非法值并去重 */
function _normalizePhases(phases) {
  const normalized = (phases || [])
    .map((p) => normalizeStoryPhase(p))
    .filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : [...STORY_PHASES];
}

function _collectRoadmapPrds(roadmap) {
  const collected = [];

  if (Array.isArray(roadmap?.prds)) {
    for (const prd of roadmap.prds) {
      collected.push({ ...prd });
    }
  }

  if (Array.isArray(roadmap?.milestones)) {
    for (let i = 0; i < roadmap.milestones.length; i++) {
      const milestone = roadmap.milestones[i] || {};
      const milestonePrds = milestone.prds || [];
      for (const prd of milestonePrds) {
        collected.push({
          ...prd,
          milestoneId: milestone.id || `M${i + 1}`,
          milestoneTitle: milestone.title || null,
        });
      }
    }
  }

  const byId = new Map();
  const withoutId = [];
  for (const prd of collected) {
    if (!prd?.id) {
      withoutId.push(prd);
      continue;
    }
    if (!byId.has(prd.id)) byId.set(prd.id, prd);
  }

  const deduped = Array.from(byId.values());
  deduped.push(...withoutId);
  return deduped;
}

function _activateInitialPrds(store, logger = console) {
  const allPrds = store.listPrds();
  const prdMap = new Map(allPrds.map((prd) => [prd.id, prd]));
  const activated = [];

  for (const prd of allPrds) {
    if (prd.status !== "queued") continue;
    if (!_prdDependenciesCompleted(prd, prdMap)) continue;
    store.transitionPrd(prd.id, "active");
    activated.push(prd.id);
  }

  if (activated.length === 0) {
    const fallback = allPrds.find((prd) => prd.status === "queued");
    if (fallback) {
      store.transitionPrd(fallback.id, "active");
      activated.push(fallback.id);
      logger.warn(`[prd-loader] no dependency-free PRD found, activated fallback PRD ${fallback.id}`);
    }
  }

  return activated;
}

function _prdDependenciesCompleted(prd, prdMap) {
  const dependencies = _normalizeDependencyRefs(prd?.dependencies || prd?.dependsOn)
    .filter((ref) => _isPrdRef(ref));
  if (dependencies.length === 0) return true;

  return dependencies.every((depId) => {
    const depPrd = prdMap.get(depId);
    return depPrd && (depPrd.status === "completed" || depPrd.status === "completed_with_errors");
  });
}

function _splitStoryDependencies(storyData, inheritedPrdDependencies = []) {
  const refs = _normalizeDependencyRefs([
    ...(Array.isArray(storyData?.dependencies) ? storyData.dependencies : storyData?.dependencies ? [storyData.dependencies] : []),
    ...(Array.isArray(storyData?.dependsOn) ? storyData.dependsOn : storyData?.dependsOn ? [storyData.dependsOn] : []),
  ]);

  const storyDependencies = [];
  const prdDependencies = [..._normalizeDependencyRefs(inheritedPrdDependencies).filter((ref) => _isPrdRef(ref))];

  for (const ref of refs) {
    if (_isPrdRef(ref)) prdDependencies.push(ref);
    else storyDependencies.push(ref);
  }

  return {
    storyDependencies: [...new Set(storyDependencies)],
    prdDependencies: [...new Set(prdDependencies)],
  };
}

function _normalizeDependencyRefs(input) {
  const arr = Array.isArray(input) ? input : input == null ? [] : [input];
  return arr
    .map((ref) => {
      if (typeof ref === "string") return ref.trim();
      if (typeof ref === "number") return String(ref);
      if (typeof ref === "object" && ref) {
        const candidate = ref.storyId || ref.prdId || ref.id || null;
        return typeof candidate === "string" ? candidate.trim() : null;
      }
      return null;
    })
    .filter((ref) => Boolean(ref));
}

function _isPrdRef(ref) {
  return /^PRD[-_]/i.test(String(ref || "").trim());
}

function _isCompletedStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "completed" || normalized === "done" || normalized === "passed";
}

function _normalizePrdStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "active" || normalized === "in_progress" || normalized === "in-progress") return "active";
  if (normalized === "completed_with_errors" || normalized === "completed-with-errors") return "completed_with_errors";
  if (normalized === "completed" || normalized === "done") return "completed";
  return "queued";
}

function _removePhase(phases, phase) {
  const idx = phases.indexOf(phase);
  if (idx >= 0) phases.splice(idx, 1);
}

module.exports = { loadPrds, loadActivePrd };
