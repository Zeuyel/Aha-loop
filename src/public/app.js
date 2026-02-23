
(() => {
  const POLL_MS = 5000;
  const REQUEST_TIMEOUT_MS = 2500;
  const EAST8_TIMEZONE = "Asia/Shanghai";
  const HISTORY_POINTS = 48;
  const NOTIFY_PREF_KEY = "aha_loop_notify_v1";
  const PROJECT_STAGE_ORDER = ["backlog", "in_progress", "review", "done"];
  const PROJECT_STAGE_LABELS = {
    backlog: "Backlog",
    in_progress: "In Progress",
    review: "Review",
    done: "Done",
  };

  const pages = {
    projects: {
      title: "PROJECTS",
      subtitle: "single-project control plane · lifecycle and runtime control",
    },
    boot: {
      title: "PROJECTS",
      subtitle: "single-project control plane · lifecycle and runtime control",
    },
    overview: {
      title: "MQ COMMAND CENTER",
      subtitle: "real-time queue telemetry · scheduler control · run intelligence",
    },
    stories: {
      title: "STORIES DASHBOARD",
      subtitle: "status distribution · phase progress · dependency bottlenecks",
    },
    story: {
      title: "STORY DETAIL",
      subtitle: "phase cards · readable stdout/stderr · execution timeline",
    },
    incidents: {
      title: "INCIDENTS DASHBOARD",
      subtitle: "alerts + dead letters · triage · recovery actions",
    },
  };

  const PAGE_ROUTES = {
    projects: "/projects.html",
    boot: "/projects.html",
    overview: "/overview.html",
    stories: "/stories.html",
    story: "/story.html",
    incidents: "/incidents.html",
  };

  const initialPage = (() => {
    const raw = document.body?.dataset?.page || "boot";
    const normalized = raw === "boot" ? "projects" : raw;
    return Object.prototype.hasOwnProperty.call(pages, normalized) ? normalized : "projects";
  })();

  const state = {
    page: initialPage,
    projectModalOpen: false,
    bootStep: 1,
    deadItems: [],
    deadSelected: null,
    selectedStoryId: null,
    selectedRunId: null,
    storiesSort: {
      key: "storyId",
      direction: "asc",
    },
    notifications: {
      supported: typeof window !== "undefined" && "Notification" in window,
      enabled: false,
      permission: typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported",
      notifiedRunIds: new Set(),
      primed: false,
    },
    selectedProjectId: null,
    overviewRange: "5m",
    cache: Object.create(null),
    refreshInFlight: false,
    overviewMetricsUnsupported: false,
    lastControl: null,
    history: {
      work: [],
      retry: [],
      dead: [],
      p95: [],
    },
  };

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setText(target, value) {
    const el = typeof target === "string" ? $(target) : target;
    if (!el) return;
    const next = String(value ?? "");
    if (el.textContent !== next) el.textContent = next;
  }

  function setHtml(target, html) {
    const el = typeof target === "string" ? $(target) : target;
    if (!el) return;
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function formatEast8(value, includeDate = true) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const options = includeDate
      ? {
          timeZone: EAST8_TIMEZONE,
          hour12: false,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }
      : {
          timeZone: EAST8_TIMEZONE,
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        };
    return new Intl.DateTimeFormat("zh-CN", options).format(date);
  }

  function looksLikeIso(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value);
  }

  function formatError(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "object") {
      if (typeof value.code === "string" && typeof value.message === "string") return `${value.code}: ${value.message}`;
      if (typeof value.message === "string") return value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  function toMs(value) {
    if (!Number.isFinite(value)) return "--";
    if (value < 1000) return `${Math.round(value)}ms`;
    return `${(value / 1000).toFixed(2)}s`;
  }

  function calcDurationMs(run) {
    const start = run?.startAt ? Date.parse(run.startAt) : NaN;
    const dispatch = run?.dispatchAt ? Date.parse(run.dispatchAt) : NaN;
    const finish = run?.finishAt ? Date.parse(run.finishAt) : NaN;
    const updated = run?.updatedAt ? Date.parse(run.updatedAt) : NaN;
    const begin = Number.isFinite(start) ? start : dispatch;
    const end = Number.isFinite(finish) ? finish : (Number.isFinite(updated) ? updated : Date.now());
    if (!Number.isFinite(begin) || !Number.isFinite(end) || end < begin) return null;
    return end - begin;
  }

  function statusClass(status) {
    const s = String(status || "").toLowerCase();
    if (["completed", "success", "succeeded", "merged", "merge"].includes(s)) return "status-ok";
    if (["dead", "failed", "fail", "error", "cancelled"].includes(s)) return "status-bad";
    if (["retry", "warning", "warn"].includes(s)) return "status-warn";
    if (["running", "start", "started", "dispatch", "queued", "in_progress", "pending"].includes(s)) return "status-info";
    return "status-neutral";
  }

  function statusPill(status) {
    return `<span class="status-pill ${statusClass(status)}">${esc(status || "--")}</span>`;
  }

  function isFailureStatus(status) {
    const s = String(status || "").toLowerCase();
    return ["dead", "failed", "fail", "error", "cancelled"].includes(s);
  }

  function loadNotificationPrefs() {
    try {
      const raw = localStorage.getItem(NOTIFY_PREF_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      state.notifications.enabled = Boolean(parsed?.enabled);
    } catch {
      // ignore local storage errors
    }
  }

  function saveNotificationPrefs() {
    try {
      localStorage.setItem(
        NOTIFY_PREF_KEY,
        JSON.stringify({
          enabled: Boolean(state.notifications.enabled),
        }),
      );
    } catch {
      // ignore local storage errors
    }
  }

  function updateNotificationUi() {
    state.notifications.permission = state.notifications.supported ? Notification.permission : "unsupported";

    const statusLines = [];
    if (!state.notifications.supported) {
      statusLines.push("status: unsupported");
      statusLines.push("browser does not support Notification API");
    } else {
      statusLines.push(`status: ${state.notifications.enabled ? "enabled" : "muted"}`);
      statusLines.push(`permission: ${state.notifications.permission}`);
    }
    setText("notify-status", statusLines.join("\n"));

    const enableBtn = $("notify-enable");
    const disableBtn = $("notify-disable");
    const testBtn = $("notify-test");
    if (enableBtn) {
      enableBtn.disabled = !state.notifications.supported;
    }
    if (disableBtn) {
      disableBtn.disabled = !state.notifications.supported || !state.notifications.enabled;
    }
    if (testBtn) {
      testBtn.disabled = !state.notifications.supported || state.notifications.permission !== "granted";
    }
  }

  async function requestNotificationPermission() {
    if (!state.notifications.supported) return "unsupported";
    if (Notification.permission === "granted") return "granted";
    if (Notification.permission === "denied") return "denied";
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }

  function sendSystemNotification(title, body, tag = "aha-loop-mq") {
    if (!state.notifications.supported) return false;
    if (Notification.permission !== "granted") return false;
    try {
      const n = new Notification(title, {
        body: String(body || ""),
        tag,
      });
      setTimeout(() => n.close(), 12_000);
      return true;
    } catch {
      return false;
    }
  }

  function rememberFailureRuns(runs) {
    for (const run of runs || []) {
      if (!run?.runId) continue;
      if (!isFailureStatus(run.status)) continue;
      state.notifications.notifiedRunIds.add(run.runId);
    }
    if (state.notifications.notifiedRunIds.size > 600) {
      let extra = state.notifications.notifiedRunIds.size - 600;
      for (const runId of state.notifications.notifiedRunIds) {
        state.notifications.notifiedRunIds.delete(runId);
        extra -= 1;
        if (extra <= 0) break;
      }
    }
  }

  function notifyFailureRuns(runs) {
    if (!state.notifications.enabled) return;
    if (!state.notifications.supported || Notification.permission !== "granted") return;

    for (const run of runs || []) {
      if (!run?.runId) continue;
      if (!isFailureStatus(run.status)) continue;
      if (state.notifications.notifiedRunIds.has(run.runId)) continue;

      const when = formatEast8(run.updatedAt || run.finishAt || run.startAt || run.dispatchAt, true);
      const reason = formatError(run.error || run.errorCode || run.status || "failed");
      sendSystemNotification(
        `Run failed: ${run.runId}`,
        `${run.storyId || "--"} · ${run.phase || "--"}\n${reason}\n${when}`,
        `run-fail-${run.runId}`,
      );
      state.notifications.notifiedRunIds.add(run.runId);
    }
  }

  function renderMetricBoxes(items) {
    return items
      .map(
        (item) => `
      <div class="metric-box">
        <span>${esc(item.label)}</span>
        <b>${esc(item.value)}</b>
      </div>
    `,
      )
      .join("");
  }

  function renderListItems(items) {
    if (!items.length) return "<li class='list-item'>no data</li>";
    return items
      .map(
        (item) => `
      <li class="list-item">
        <div class="title">${item.title}</div>
        <div class="meta">${item.meta}</div>
      </li>
    `,
      )
      .join("");
  }

  function pushHistory(key, value) {
    const arr = state.history[key];
    if (!arr) return;
    arr.push({ t: Date.now(), v: Number(value) || 0 });
    if (arr.length > HISTORY_POINTS) arr.shift();
  }

  function tinySpark(points) {
    if (!points.length) return "_";
    const chars = "▁▂▃▄▅▆▇";
    const values = points.map((pt) => Number(pt.v) || 0);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max === min) max = min + 1;
    return values
      .slice(-7)
      .map((v) => {
        const idx = Math.max(0, Math.min(chars.length - 1, Math.floor(((v - min) / (max - min)) * (chars.length - 1))));
        return chars[idx];
      })
      .join("");
  }

  function sparklineSvg(points, color) {
    const w = 220;
    const h = 42;
    const p = 3;
    if (!points.length) return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
    const values = points.map((pt) => Number(pt.v) || 0);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max === min) max = min + 1;
    const step = points.length <= 1 ? 0 : (w - p * 2) / (points.length - 1);
    const poly = points
      .map((pt, idx) => {
        const x = p + idx * step;
        const norm = (pt.v - min) / (max - min);
        const y = h - p - norm * (h - p * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return `
      <svg class="sparkline" viewBox="0 0 ${w} ${h}" aria-hidden="true">
        <polyline points="${poly}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>
      </svg>
    `;
  }

  function renderJsonPrimitive(value) {
    if (value === null) return '<span class="json-value null">null</span>';
    if (typeof value === "string") {
      if (looksLikeIso(value)) {
        return `<span class="json-value string">${esc(formatEast8(value, true))}</span> <span class="json-type">(UTC+8)</span>`;
      }
      return `<span class="json-value string">"${esc(value)}"</span>`;
    }
    if (typeof value === "number") return `<span class="json-value number">${value}</span>`;
    if (typeof value === "boolean") return `<span class="json-value boolean">${value}</span>`;
    return `<span class="json-value">${esc(String(value))}</span>`;
  }

  function renderJsonNode(key, value, depth = 0) {
    const keyHtml = key == null ? "" : `<span class="json-key">${esc(key)}</span>: `;
    if (value == null || typeof value !== "object") {
      return `<div class="json-node">${keyHtml}${renderJsonPrimitive(value)}</div>`;
    }

    if (Array.isArray(value)) {
      const summary = `${keyHtml}<span class="json-type">Array(${value.length})</span>`;
      const children = value.map((item, index) => renderJsonNode(index, item, depth + 1)).join("");
      return `
        <details class="json-node" ${depth < 2 ? "open" : ""}>
          <summary>${summary}</summary>
          <div class="json-children">${children || '<div class="json-node"><span class="json-type">empty</span></div>'}</div>
        </details>
      `;
    }

    const keys = Object.keys(value);
    const summary = `${keyHtml}<span class="json-type">Object(${keys.length})</span>`;
    const children = keys.map((childKey) => renderJsonNode(childKey, value[childKey], depth + 1)).join("");
    return `
      <details class="json-node" ${depth < 2 ? "open" : ""}>
        <summary>${summary}</summary>
        <div class="json-children">${children || '<div class="json-node"><span class="json-type">empty</span></div>'}</div>
      </details>
    `;
  }

  function setJsonView(id, data) {
    setHtml(id, renderJsonNode(null, data, 0));
  }

  function markdownToHtml(markdown) {
    const src = String(markdown || "").replace(/\r\n/g, "\n");
    if (!src.trim()) return "<p>(empty)</p>";

    const codeBlocks = [];
    let text = src.replace(/```([\s\S]*?)```/g, (_, body) => {
      const token = `@@CODE_${codeBlocks.length}@@`;
      codeBlocks.push(`<pre><code>${esc(body.trimEnd())}</code></pre>`);
      return token;
    });

    text = esc(text)
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

    const lines = text.split("\n");
    const out = [];
    let inUl = false;
    let inOl = false;
    for (const line of lines) {
      const ordered = line.match(/^(\d+)\.\s+(.+)$/);
      if (/^-\s+/.test(line)) {
        if (!inUl) {
          if (inOl) {
            out.push("</ol>");
            inOl = false;
          }
          out.push("<ul>");
          inUl = true;
        }
        out.push(`<li>${line.replace(/^-+\s+/, "")}</li>`);
        continue;
      }
      if (ordered) {
        if (!inOl) {
          if (inUl) {
            out.push("</ul>");
            inUl = false;
          }
          out.push("<ol>");
          inOl = true;
        }
        out.push(`<li>${ordered[2]}</li>`);
        continue;
      }
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!line.trim()) {
        out.push("");
        continue;
      }
      if (/^<h[1-3]>/.test(line) || /^@@CODE_\d+@@$/.test(line)) out.push(line);
      else out.push(`<p>${line}</p>`);
    }
    if (inUl) out.push("</ul>");
    if (inOl) out.push("</ol>");

    let html = out.join("\n");
    codeBlocks.forEach((block, index) => {
      html = html.replace(`@@CODE_${index}@@`, block);
    });
    return html;
  }

  async function fetchJson(url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`${url}: ${resp.status}`);
      return resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendJson(url, method, payload, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: payload == null ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await resp.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      if (!resp.ok) {
        const err = new Error(body?.error || `${url}: ${resp.status}`);
        err.payload = body;
        throw err;
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async function postJson(url, payload, options = {}) {
    return sendJson(url, "POST", payload, options);
  }

  async function patchJson(url, payload, options = {}) {
    return sendJson(url, "PATCH", payload, options);
  }

  async function deleteJson(url, options = {}) {
    return sendJson(url, "DELETE", null, options);
  }

  async function fetchWithCache(key, url) {
    try {
      const payload = await fetchJson(url);
      state.cache[key] = payload;
      return payload;
    } catch (err) {
      if (state.cache[key]) return state.cache[key];
      throw err;
    }
  }

  async function fetchOverviewMetrics(range) {
    if (state.overviewMetricsUnsupported) return null;
    try {
      return await fetchWithCache("overviewMetrics", `/metrics/overview?window=${range}`);
    } catch {
      state.overviewMetricsUnsupported = true;
      return null;
    }
  }

  function clearCache(keys) {
    for (const key of keys) delete state.cache[key];
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  }

  function setHidden(id, hidden) {
    const el = $(id);
    if (!el) return;
    el.classList.toggle("hidden", hidden);
  }

  function setProjectModal(open) {
    const modal = $("project-modal");
    if (!modal) return;
    state.projectModalOpen = Boolean(open);
    modal.classList.toggle("hidden", !state.projectModalOpen);
    if (state.projectModalOpen && $("project-create-name")) {
      $("project-create-name").focus();
    }
  }

  function syncPageChrome(page) {
    document.body.dataset.page = page;
    document.querySelectorAll(".nav-item").forEach((btn) => {
      const targetPage = btn.dataset.page || "";
      const shouldHighlight = targetPage === page || (page === "story" && targetPage === "stories");
      btn.classList.toggle("active", shouldHighlight);
    });
    setText("header-title", pages[page].title);
    setText("header-subtitle", pages[page].subtitle);

    if (page === "overview") {
      setHidden("header-boot-cta", true);
      setHidden("header-chips", false);
    } else {
      setHidden("header-boot-cta", true);
      setHidden("header-chips", true);
    }
  }

  function setPage(page) {
    if (page === "boot") page = "projects";
    if (!Object.prototype.hasOwnProperty.call(PAGE_ROUTES, page)) return;
    if (page !== "projects") setProjectModal(false);
    if (state.page !== page) {
      window.location.href = PAGE_ROUTES[page];
      return;
    }
    state.page = page;
    syncPageChrome(page);
    refreshIcons();
    refresh().catch((err) => console.error(err));
  }

  function getStoryIdFromQuery() {
    const params = new URLSearchParams(window.location.search || "");
    const raw = params.get("storyId");
    return raw ? raw.trim() : "";
  }

  function openStoryDetailPage(storyId) {
    if (!storyId) return;
    window.location.href = `/story.html?storyId=${encodeURIComponent(storyId)}`;
  }

  function updateHeaderHealth(health) {
    setText("chip-env", health?.service?.available ? "env: single-instance" : "env: degraded");
    setText("chip-timezone", "timezone: UTC+8");
  }

  function renderBootTabs() {
    const defs = [
      { step: 1, label: "1 Workspace" },
      { step: 2, label: "2 Vision" },
      { step: 3, label: "3 Preflight" },
      { step: 4, label: "4 Boot" },
    ];
    return defs
      .map((d) => `<button class="step-tab ${state.bootStep === d.step ? "active" : ""}" data-step="${d.step}">${esc(d.label)}</button>`)
      .join("");
  }

  function normalizeProjectStage(stage) {
    const raw = String(stage || "").trim().toLowerCase();
    if (raw === "in-progress" || raw === "inprogress") return "in_progress";
    if (PROJECT_STAGE_ORDER.includes(raw)) return raw;
    return "backlog";
  }

  function projectTagTone(tag, idx) {
    const raw = String(tag || "").toLowerCase();
    if (raw.includes("critical") || raw.includes("high") || raw.includes("urgent")) return "red";
    if (raw.includes("api") || raw.includes("ops") || raw.includes("infra")) return "green";
    if (raw.includes("security") || raw.includes("scheduler")) return "amber";
    if (raw.includes("core")) return "pink";
    const tones = ["blue", "green", "amber", "red", "pink"];
    return tones[idx % tones.length];
  }

  function renderProjectCard(project) {
    const stage = normalizeProjectStage(project.stage);
    const stageIndex = PROJECT_STAGE_ORDER.indexOf(stage);
    const canPrev = stageIndex > 0;
    const canNext = stageIndex >= 0 && stageIndex < PROJECT_STAGE_ORDER.length - 1;
    const tags = Array.isArray(project.tags) ? project.tags : [];
    const storyCount = Number.isFinite(project.storyCount) ? project.storyCount : 0;
    const progress = Number.isFinite(project.progressPct) ? Math.max(0, Math.min(100, project.progressPct)) : 0;
    const dateText = project.targetDate || (project.updatedAt ? formatEast8(project.updatedAt, true).slice(0, 10) : "--");
    const isSuccess = progress >= 100 || stage === "done";

    return `
      <article class="project-card" data-project-id="${esc(project.id)}" data-project-stage="${esc(stage)}">
        <h4>${esc(project.name || "Untitled")}</h4>
        <p>${esc(project.description || "no description")}</p>
        <div class="project-tags">
          ${(tags.length
            ? tags.slice(0, 5).map((tag, idx) => `<span class="project-tag ${projectTagTone(tag, idx)}">${esc(tag)}</span>`).join("")
            : '<span class="project-tag blue">project</span>')}
        </div>
        <div class="project-foot ${isSuccess ? "success" : ""}">
          <span>${esc(`${storyCount} stories · ${progress}%`)}</span>
          <span>${esc(dateText)}</span>
        </div>
        <div class="project-card-actions">
          <button class="btn btn-accent" data-project-control="start" data-project-id="${esc(project.id)}" data-project-mode="${esc(project.bootMode || "resume_existing")}">Start</button>
          <button class="btn btn-dark" data-project-control="pause" data-project-id="${esc(project.id)}">Pause</button>
          <button class="btn btn-ok" data-project-control="resume" data-project-id="${esc(project.id)}">Resume</button>
          <button class="btn btn-soft" data-project-action="edit" data-project-id="${esc(project.id)}">Edit</button>
          <button class="btn btn-soft" data-project-action="move_prev" data-project-id="${esc(project.id)}" data-project-stage="${esc(stage)}" ${canPrev ? "" : "disabled"}>←</button>
          <button class="btn btn-soft" data-project-action="move_next" data-project-id="${esc(project.id)}" data-project-stage="${esc(stage)}" ${canNext ? "" : "disabled"}>→</button>
          <button class="btn btn-bad" data-project-action="delete" data-project-id="${esc(project.id)}">Delete</button>
        </div>
      </article>
    `;
  }

  function renderProjectsBoard(snapshot) {
    const items = snapshot?.items || [];
    const byStage = snapshot?.totals?.byStage || {};
    setText("project-total", `total: ${snapshot?.totals?.all ?? items.length} projects`);

    const stageTargets = {
      backlog: { count: "projects-backlog-count", list: "projects-backlog-list" },
      in_progress: { count: "projects-in-progress-count", list: "projects-in-progress-list" },
      review: { count: "projects-review-count", list: "projects-review-list" },
      done: { count: "projects-done-count", list: "projects-done-list" },
    };

    for (const stage of PROJECT_STAGE_ORDER) {
      const target = stageTargets[stage];
      setText(target.count, String(byStage[stage] ?? 0));
      const stageItems = items.filter((x) => normalizeProjectStage(x.stage) === stage);
      const html = stageItems.length
        ? stageItems.map((x) => renderProjectCard(x)).join("")
        : `<article class="project-card project-card-empty"><h4>${esc(PROJECT_STAGE_LABELS[stage])}</h4><p>no projects</p></article>`;
      setHtml(target.list, html);
    }
  }

  function populateProjectRuntimeControls(snapshot, health) {
    const select = $("project-control-id");
    if (!select) return;
    const items = snapshot?.items || [];
    if (!state.selectedProjectId || !items.some((item) => item.id === state.selectedProjectId)) {
      state.selectedProjectId = items[0]?.id || null;
    }
    const options = items.length
      ? items
          .map((item) => {
            const selected = item.id === state.selectedProjectId ? " selected" : "";
            return `<option value="${esc(item.id)}"${selected}>${esc(item.name || item.id)} · ${esc(item.stage || "backlog")}</option>`;
          })
          .join("")
      : "<option value=\"\">no projects</option>";
    setHtml(select, options);
    if (state.selectedProjectId) select.value = state.selectedProjectId;

    const modeSelect = $("project-control-mode");
    const current = items.find((item) => item.id === state.selectedProjectId) || null;
    if (modeSelect && current?.bootMode) modeSelect.value = current.bootMode;
    if ($("project-control-prd-file")) $("project-control-prd-file").value = current?.prdFile || "";
    if ($("project-control-roadmap-file")) $("project-control-roadmap-file").value = current?.roadmapFile || "";

    const paused = Boolean(health?.control?.paused);
    const meta = current
      ? `${current.name || current.id} · stage=${current.stage || "backlog"} · runtime=${paused ? "paused" : "running"}`
      : `no project selected · runtime=${paused ? "paused" : "running"}`;
    setText("project-control-state", meta);
  }

  function getProjectCreatePayload() {
    const name = $("project-create-name")?.value?.trim() || "";
    if (!name) throw new Error("project name is required");

    const stage = normalizeProjectStage($("project-create-stage")?.value || "backlog");
    const description = $("project-create-description")?.value?.trim() || "";
    const tags = ($("project-create-tags")?.value || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    const storyCountRaw = Number.parseInt($("project-create-story-count")?.value || "0", 10);
    const progressRaw = Number.parseInt($("project-create-progress-pct")?.value || "0", 10);
    const targetDate = $("project-create-target-date")?.value?.trim() || null;
    const bootMode = $("project-create-boot-mode")?.value?.trim() || "resume_existing";
    const prdFile = $("project-create-prd-file")?.value?.trim() || null;
    const workspacePath = $("project-create-workspace-path")?.value?.trim() || null;
    const roadmapFile = $("project-create-roadmap-file")?.value?.trim() || null;

    return {
      name,
      stage,
      description,
      tags,
      storyCount: Number.isFinite(storyCountRaw) && storyCountRaw >= 0 ? storyCountRaw : 0,
      progressPct: Number.isFinite(progressRaw) ? Math.max(0, Math.min(100, progressRaw)) : 0,
      targetDate,
      bootMode,
      prdFile,
      workspacePath,
      roadmapFile,
    };
  }

  function clearProjectCreateForm() {
    if ($("project-edit-id")) $("project-edit-id").value = "";
    if ($("project-create-name")) $("project-create-name").value = "";
    if ($("project-create-description")) $("project-create-description").value = "";
    if ($("project-create-tags")) $("project-create-tags").value = "";
    if ($("project-create-story-count")) $("project-create-story-count").value = "0";
    if ($("project-create-progress-pct")) $("project-create-progress-pct").value = "0";
    if ($("project-create-target-date")) $("project-create-target-date").value = "";
    if ($("project-create-stage")) $("project-create-stage").value = "backlog";
    if ($("project-create-boot-mode")) $("project-create-boot-mode").value = "resume_existing";
    if ($("project-create-prd-file")) $("project-create-prd-file").value = "";
    if ($("project-create-workspace-path")) $("project-create-workspace-path").value = "";
    if ($("project-create-roadmap-file")) $("project-create-roadmap-file").value = "";
    if ($("project-create-submit")) $("project-create-submit").textContent = "Create Project";
  }

  async function createProject() {
    const editId = $("project-edit-id")?.value?.trim() || "";
    const payload = getProjectCreatePayload();
    if (editId) {
      await patchJson(`/projects/${encodeURIComponent(editId)}`, payload);
    } else {
      await postJson("/projects", payload);
    }
    clearProjectCreateForm();
    clearCache(["projects"]);
    setText("control-result", `${editId ? "project updated" : "project created"} · ${formatEast8(Date.now(), true)}`);
    await renderBoot();
  }

  async function startEditProject(projectId) {
    if (!projectId) return;
    const response = await fetchJson(`/projects/${encodeURIComponent(projectId)}`);
    const project = response?.project || null;
    if (!project) throw new Error("project not found");

    if ($("project-edit-id")) $("project-edit-id").value = project.id || "";
    if ($("project-create-name")) $("project-create-name").value = project.name || "";
    if ($("project-create-stage")) $("project-create-stage").value = normalizeProjectStage(project.stage || "backlog");
    if ($("project-create-description")) $("project-create-description").value = project.description || "";
    if ($("project-create-tags")) $("project-create-tags").value = Array.isArray(project.tags) ? project.tags.join(", ") : "";
    if ($("project-create-story-count")) $("project-create-story-count").value = String(project.storyCount ?? 0);
    if ($("project-create-progress-pct")) $("project-create-progress-pct").value = String(project.progressPct ?? 0);
    if ($("project-create-target-date")) $("project-create-target-date").value = project.targetDate || "";
    if ($("project-create-boot-mode")) $("project-create-boot-mode").value = project.bootMode || "resume_existing";
    if ($("project-create-prd-file")) $("project-create-prd-file").value = project.prdFile || "";
    if ($("project-create-workspace-path")) $("project-create-workspace-path").value = project.workspacePath || "";
    if ($("project-create-roadmap-file")) $("project-create-roadmap-file").value = project.roadmapFile || "";
    if ($("project-create-submit")) $("project-create-submit").textContent = "Save Project";
    setProjectModal(true);
  }

  async function moveProject(projectId, currentStage, direction) {
    const current = normalizeProjectStage(currentStage);
    const idx = PROJECT_STAGE_ORDER.indexOf(current);
    if (idx < 0) return;
    const nextIdx = direction === "prev" ? idx - 1 : idx + 1;
    if (nextIdx < 0 || nextIdx >= PROJECT_STAGE_ORDER.length) return;
    await patchJson(`/projects/${encodeURIComponent(projectId)}`, {
      stage: PROJECT_STAGE_ORDER[nextIdx],
    });
    clearCache(["projects"]);
    setText("control-result", `project moved · ${formatEast8(Date.now(), true)}`);
    await renderBoot();
  }

  async function deleteProject(projectId) {
    const ok = window.confirm("Delete this project?");
    if (!ok) return;
    await deleteJson(`/projects/${encodeURIComponent(projectId)}`);
    clearCache(["projects"]);
    setText("control-result", `project deleted · ${formatEast8(Date.now(), true)}`);
    await renderBoot();
  }

  function renderBootStep1(workspace) {
    const rmq = workspace?.rmq || {};
    const mqRoot = workspace?.mqRoot || workspace?.workspaceRoot || "";
    return `
      <div class="wizard-form">
        <div class="wizard-fields">
          <div class="field">
            <label>workspaceRoot</label>
            <input class="input mono-input" value="${esc(workspace?.workspaceRoot || "")}" readonly>
          </div>
          <div class="field">
            <label>mqRoot</label>
            <input class="input mono-input" value="${esc(mqRoot)}" readonly>
          </div>
        </div>
        <div class="wizard-fields">
          <div class="field">
            <label>worktreeDir</label>
            <input class="input mono-input" value="${esc(workspace?.worktreeDir || ".worktrees")}" readonly>
          </div>
          <div class="field">
            <label>timezone</label>
            <input class="input mono-input" value="UTC+8" readonly>
          </div>
        </div>
        <div class="step-chip-row">
          <span class="step-chip active">${esc(workspace?.defaultTool || "codex")}</span>
          <span class="step-chip active">${esc(workspace?.deliverySemantics || "at-least-once")}</span>
          <span class="step-chip">${esc(workspace?.ackMode || "manual_ack")}</span>
          <span class="step-chip">${esc(rmq.workQueue || "aha.work")}</span>
        </div>
      </div>
    `;
  }

  function renderBootStep2(vision) {
    const raw = vision?.exists ? vision.content || "" : "project.vision.md not found";
    return `
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px;min-height:320px;">
        <div>
          <div class="panel-meta">Rendered Markdown</div>
          <div class="markdown" style="height:280px;">${markdownToHtml(raw)}</div>
        </div>
        <div>
          <div class="panel-meta">Source</div>
          <div class="json-view" style="height:280px;"><pre class="mono" style="white-space:pre-wrap;margin:0;">${esc(raw)}</pre></div>
        </div>
      </div>
    `;
  }

  function checkItem(label, ok, meta) {
    return `
      <div class="metric-box">
        <span>${esc(label)}</span>
        <b>${ok ? "PASS" : "FAIL"}</b>
        <span>${esc(meta || "")}</span>
      </div>
    `;
  }

  function renderBootStep3(health) {
    const queueOk = Boolean(health?.queue?.ok);
    const schedulerAlive = Boolean(health?.scheduler?.alive);
    const workerAlive = Boolean(health?.worker?.alive);
    const serviceAvailable = Boolean(health?.service?.available);
    return `
      <div class="inline-metrics">
        ${checkItem("RabbitMQ", queueOk, `${health?.queue?.url || "broker"}`)}
        ${checkItem("Scheduler", schedulerAlive, health?.scheduler?.lastHeartbeatAt ? formatEast8(health.scheduler.lastHeartbeatAt) : "--")}
        ${checkItem("Worker", workerAlive, health?.worker?.lastHeartbeatAt ? formatEast8(health.worker.lastHeartbeatAt) : "--")}
        ${checkItem("Service Availability", serviceAvailable, health?.control?.paused ? `paused: ${health.control.pauseReason || "--"}` : "ready")}
      </div>
      <div style="margin-top:10px;" class="json-view">${renderJsonNode(null, {
        queues: health?.queue?.queues || {},
        runtimeConsumers: health?.queue?.runtimeConsumers || {},
        control: health?.control || {},
      })}</div>
    `;
  }

  function renderBootStep4(workspace, health) {
    return renderBootStep4WithPreflight(workspace, health, null);
  }

  function renderBootStep4WithPreflight(workspace, health, preflight) {
    const files = preflight?.files || {};
    const mode = preflight?.defaultMode || "resume_existing";
    const fileStatus = {
      roadmap: files.roadmap?.exists ? "found" : "missing",
      prd: files.prd?.exists ? "found" : "missing",
      vision: files.vision?.exists ? "found" : "missing",
    };
    return `
      <div class="wizard-form">
        <div class="inline-metrics">
          ${renderMetricBoxes([
            { label: "defaultTool", value: workspace?.defaultTool || "--" },
            { label: "semantics", value: workspace?.deliverySemantics || "--" },
            { label: "scheduler", value: health?.scheduler?.alive ? "alive" : "down" },
            { label: "worker", value: health?.worker?.alive ? "alive" : "down" },
          ])}
        </div>
        <div class="json-view" style="margin-top:10px;">
          ${renderJsonNode(null, {
            nextAction: "select one boot mode and trigger backend startup orchestration",
            bootEndpoint: "/boot/start",
            defaultMode: mode,
            files: {
              roadmap: { path: files.roadmap?.path || workspace?.boot?.inputs?.roadmapFile || "", status: fileStatus.roadmap },
              prd: { path: files.prd?.path || workspace?.boot?.inputs?.prdFile || "", status: fileStatus.prd },
              vision: { path: files.vision?.path || workspace?.boot?.inputs?.visionFile || "", status: fileStatus.vision },
            },
            now: formatEast8(Date.now()),
          })}
        </div>
        <div style="margin-top:10px;">
          <div class="control-actions">
            <button class="btn btn-accent" data-boot-start="resume_existing">BOOT: Resume</button>
            <button class="btn btn-soft" data-boot-start="reload_from_roadmap" ${fileStatus.roadmap === "found" ? "" : "disabled"}>BOOT: Reload Roadmap</button>
            <button class="btn btn-muted" data-boot-start="reload_from_prd" ${fileStatus.prd === "found" ? "" : "disabled"}>BOOT: Reload PRD</button>
          </div>
        </div>
      </div>
    `;
  }

  async function renderBoot() {
    const [workspace, vision, health, preflight, projects] = await Promise.all([
      fetchWithCache("bootWorkspace", "/boot/workspace"),
      fetchWithCache("bootVision", "/boot/vision"),
      fetchWithCache("health", "/health"),
      fetchWithCache("bootPreflight", "/boot/preflight").catch(() => null),
      fetchWithCache("projects", "/projects?limit=300").catch(() => ({ items: [], totals: { all: 0, byStage: {} } })),
    ]);

    const stepMeta = {
      1: { title: "Step 1 / 4 · Workspace Setup", subtitle: "点击步骤或 Next/Prev 顺序切换。每次只处理一个步骤。" },
      2: { title: "Step 2 / 4 · Vision", subtitle: "review rendered markdown and raw source" },
      3: { title: "Step 3 / 4 · Validate", subtitle: "verify broker, scheduler, worker, and control state" },
      4: { title: "Step 4 / 4 · Boot Run", subtitle: "confirm setup and launch execution" },
    }[state.bootStep];

    setText("boot-step-title", stepMeta.title);
    setText("boot-step-subtitle", stepMeta.subtitle);
    setText("boot-step-indicator", `${state.bootStep} / 4`);
    setHtml("boot-step-tabs", renderBootTabs());

    let html = "";
    if (state.bootStep === 1) html = renderBootStep1(workspace);
    if (state.bootStep === 2) html = renderBootStep2(vision);
    if (state.bootStep === 3) html = renderBootStep3(health);
    if (state.bootStep === 4) html = renderBootStep4WithPreflight(workspace, health, preflight);
    setHtml("boot-step-body", html);
    renderProjectsBoard(projects);
    populateProjectRuntimeControls(projects, health);
    refreshIcons();
  }

  function signedNumber(value) {
    const num = Number(value) || 0;
    if (num > 0) return `+${num}`;
    return `${num}`;
  }

  function toPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "--";
    return `${num.toFixed(1)}%`;
  }

  function renderDistributionBars(counts, { emptyText = "no data", labelMap = null, maxItems = 8 } = {}) {
    const entries = Object.entries(counts || {})
      .map(([key, raw]) => [key, Number(raw) || 0])
      .filter(([, value]) => value >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxItems);
    if (!entries.length) return `<div class="list-item">${esc(emptyText)}</div>`;
    const max = Math.max(1, ...entries.map(([, value]) => value));
    return `
      <div class="phase-bars">
        ${entries
          .map(([rawKey, value]) => {
            const key = String(rawKey || "unknown");
            const label = labelMap && Object.prototype.hasOwnProperty.call(labelMap, key) ? labelMap[key] : key;
            const width = Math.round((value / max) * 100);
            return `
              <div class="phase-row">
                <span>${esc(label)}</span>
                <div class="phase-track"><div class="phase-fill" style="width:${width}%"></div></div>
                <span>${esc(value)}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function summarizeFailureHotspots(runItems) {
    const grouped = new Map();
    for (const run of runItems || []) {
      if (!isFailureStatus(run?.status)) continue;
      const storyId = String(run?.storyId || "--");
      const prev = grouped.get(storyId) || {
        storyId,
        count: 0,
        latestAt: null,
        latestPhase: null,
        latestRunId: null,
      };
      prev.count += 1;
      const updatedAt = run?.updatedAt || run?.finishAt || run?.startAt || run?.dispatchAt || null;
      if (!prev.latestAt || (updatedAt && Date.parse(updatedAt) > Date.parse(prev.latestAt))) {
        prev.latestAt = updatedAt;
        prev.latestPhase = run?.phase || "--";
        prev.latestRunId = run?.runId || "--";
      }
      grouped.set(storyId, prev);
    }
    return [...grouped.values()]
      .sort((a, b) => b.count - a.count || Date.parse(b.latestAt || 0) - Date.parse(a.latestAt || 0))
      .slice(0, 5);
  }

  function renderQueueTrend(q, latency, overviewMetrics = null) {
    const range = state.overviewRange === "15m" ? "15m" : "5m";
    const activeWindow = range === "15m" ? latency?.latest?.last15m : latency?.latest?.last5m;
    const work = Number(q?.work?.messageCount ?? -1);
    const retry = Number(q?.retry?.messageCount ?? -1);
    const dead = Number(q?.dead?.messageCount ?? -1);
    const p95 = Number(activeWindow?.p95Ms ?? 0);
    const avg = Number(activeWindow?.avgMs ?? 0);
    const p95Other = Number((range === "15m" ? latency?.latest?.last5m : latency?.latest?.last15m)?.p95Ms ?? 0);

    pushHistory("work", work >= 0 ? work : 0);
    pushHistory("retry", retry >= 0 ? retry : 0);
    pushHistory("dead", dead >= 0 ? dead : 0);
    pushHistory("p95", p95);

    setText("ov-work-spark", tinySpark(state.history.work));
    setText("ov-retry-spark", tinySpark(state.history.retry));
    setText("ov-dead-spark", tinySpark(state.history.dead));
    setText("ov-latency-spark", tinySpark(state.history.p95));

    const historySeries = Array.isArray(overviewMetrics?.series) ? overviewMetrics.series.slice(-12) : [];
    const hasHistorySeries = historySeries.length >= 2;
    const fallbackPoints = 7;
    const samples = hasHistorySeries
      ? {
          work: historySeries.map((x) => Math.max(0, Number(x?.queues?.work ?? 0))),
          retry: historySeries.map((x) => Math.max(0, Number(x?.queues?.retry ?? 0))),
          dead: historySeries.map((x) => Math.max(0, Number(x?.queues?.dead ?? 0))),
          p95: historySeries.map((x) => {
            const latencyPoint = range === "15m" ? x?.latency15m : x?.latency5m;
            return (Number(latencyPoint?.p95Ms ?? 0) || 0) / 100;
          }),
        }
      : {
          work: state.history.work.slice(-fallbackPoints).map((x) => Number(x.v) || 0),
          retry: state.history.retry.slice(-fallbackPoints).map((x) => Number(x.v) || 0),
          dead: state.history.dead.slice(-fallbackPoints).map((x) => Number(x.v) || 0),
          p95: state.history.p95.slice(-fallbackPoints).map((x) => (Number(x.v) || 0) / 100),
        };

    const xLabels = hasHistorySeries
      ? historySeries.map((pt) => formatEast8(pt.timestamp || Date.now(), false).slice(0, 5))
      : state.history.work.slice(-fallbackPoints).map((pt) => formatEast8(pt.t, false).slice(0, 5));
    const pointCount = Math.max(samples.work.length, samples.retry.length, samples.dead.length, samples.p95.length);
    while (xLabels.length < pointCount) xLabels.unshift("--:--");

    const w = 740;
    const h = 176;
    const left = 34;
    const top = 10;
    const right = 8;
    const bottom = 24;
    const innerW = w - left - right;
    const innerH = h - top - bottom;
    const allValues = [...samples.work, ...samples.retry, ...samples.dead, ...samples.p95];
    const yMaxBase = Math.max(10, ...allValues);
    const yMax = Math.ceil(yMaxBase * 1.2);
    const yTicks = [yMax, Math.round(yMax * 0.66), Math.round(yMax * 0.33), 0];

    const buildPath = (values) => {
      if (!values.length) return "";
      const step = values.length <= 1 ? 0 : innerW / (values.length - 1);
      return values
        .map((v, i) => {
          const x = left + i * step;
          const y = top + innerH - (Math.min(yMax, Math.max(0, v)) / yMax) * innerH;
          return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
        })
        .join(" ");
    };

    const gridYs = [0, 1, 2, 3].map((i) => top + (innerH / 3) * i);
    const workPath = buildPath(samples.work);
    const retryPath = buildPath(samples.retry);
    const deadPath = buildPath(samples.dead);
    const p95Path = buildPath(samples.p95);

    setHtml(
      "overview-trend",
      `
      <div class="timeline-canvas">
        <svg viewBox="0 0 ${w} ${h}" aria-hidden="true">
          ${gridYs
            .map(
              (y) => `<line x1="${left}" y1="${y}" x2="${w - right}" y2="${y}" stroke="#E2E8F0" stroke-width="1" />`,
            )
            .join("")}
          ${yTicks
            .map((tick, i) => `<text x="2" y="${gridYs[i] + 3}" class="axis-label">${esc(String(tick))}</text>`)
            .join("")}
          <path d="${workPath}" class="line-work" />
          <path d="${retryPath}" class="line-retry" />
          <path d="${deadPath}" class="line-dead" />
          <path d="${p95Path}" class="line-p95" />
          ${xLabels
            .map((label, i) => {
              const step = xLabels.length <= 1 ? 0 : innerW / (xLabels.length - 1);
              const x = left + i * step;
              const y = h - 4;
              return `<text x="${x}" y="${y}" class="axis-label x-label">${esc(label)}</text>`;
            })
            .join("")}
        </svg>
      </div>
      `,
    );

    const sourceTag = hasHistorySeries ? "monitor_history" : "live_fallback";
    setText(
      "overview-trend-meta",
      `window ${range} · points ${pointCount} · source ${sourceTag} · refresh ${Math.round(POLL_MS / 1000)}s`,
    );

    setHtml(
      "overview-latency",
      `
        <div class="timeline-legend">
          <span class="legend-item"><i class="dot-work"></i>work</span>
          <span class="legend-item"><i class="dot-retry"></i>retry</span>
          <span class="legend-item"><i class="dot-dead"></i>dead</span>
          <span class="legend-item"><i class="dot-p95"></i>p95 / 100</span>
        </div>
        <div class="timeline-ranges">
          <button class="range-pill ${range === "5m" ? "active" : ""}" data-latency-range="5m">5m</button>
          <button class="range-pill ${range === "15m" ? "active" : ""}" data-latency-range="15m">15m</button>
          <span class="range-meta">avg ${esc(toMs(avg))} · p95 ${esc(toMs(p95))} · other ${esc(toMs(p95Other))}</span>
        </div>
      `,
    );

    const delta = overviewMetrics?.delta || {};
    const rate = overviewMetrics?.rates || {};
    setHtml(
      "overview-queue-deltas",
      renderMetricBoxes([
        { label: "work Δ", value: signedNumber(delta.queueWork || 0) },
        { label: "retry Δ", value: signedNumber(delta.queueRetry || 0) },
        { label: "dead Δ", value: signedNumber(delta.queueDead || 0) },
        { label: "dispatch/min", value: String(Number(rate.dispatchedPerMin || 0).toFixed(2)) },
      ]),
    );
  }

  async function renderOverview() {
    const health = await fetchWithCache("health", "/health").catch(() => ({
      timestamp: new Date().toISOString(),
      queue: {
        ok: false,
        queues: {
          work: { messageCount: 0, consumerCount: 0 },
          retry: { messageCount: 0, consumerCount: 0 },
          dead: { messageCount: 0, consumerCount: 0 },
        },
        runtimeConsumers: { work: 0, dead: 0 },
      },
      service: { alive: true, available: false },
      control: { paused: false },
      scheduler: { alive: false },
      worker: { alive: false },
      counters: { dispatched: 0, retryEvents: 0 },
      latency: {
        last5m: { avgMs: 0, p95Ms: 0 },
        last15m: { avgMs: 0, p95Ms: 0 },
      },
    }));
    const range = state.overviewRange === "15m" ? "15m" : "5m";
    const [overviewMetrics, queues, stories, runs, alerts, latency, vision] = await Promise.all([
      fetchOverviewMetrics(range),
      fetchWithCache("queuesMetrics", "/metrics/queues").catch(() => ({
        timestamp: health.timestamp || new Date().toISOString(),
        queue: health.queue || { queues: { work: {}, retry: {}, dead: {} } },
        source: "health_fallback",
      })),
      fetchWithCache("stories100", "/stories?limit=100").catch(() => ({ totals: {}, items: [] })),
      fetchWithCache("runs120", "/runs?limit=300").catch(() => ({ totals: {}, items: [] })),
      fetchWithCache("alerts8", "/alerts?limit=8").catch(() => ({ recent: [] })),
      fetchWithCache("latency", "/metrics/latency").catch(() => ({
        latest: {
          last5m: health?.latency?.last5m || { avgMs: 0, p95Ms: 0 },
          last15m: health?.latency?.last15m || { avgMs: 0, p95Ms: 0 },
        },
        series: { last5m: [], last15m: [] },
        source: "health_fallback",
      })),
      fetchWithCache("bootVision", "/boot/vision").catch(() => ({ path: null })),
    ]);

    const latestOverview = overviewMetrics?.latest || null;
    const queueSnapshot = queues?.queue?.queues || {};
    const q = latestOverview?.queues
      ? {
          work: { messageCount: latestOverview.queues.work, consumerCount: queueSnapshot?.work?.consumerCount ?? 0 },
          retry: { messageCount: latestOverview.queues.retry, consumerCount: queueSnapshot?.retry?.consumerCount ?? 0 },
          dead: { messageCount: latestOverview.queues.dead, consumerCount: queueSnapshot?.dead?.consumerCount ?? 0 },
        }
      : queueSnapshot;
    const paused = Boolean(health?.control?.paused);
    setText("ov-system-title", paused ? "System Paused" : health?.service?.available ? "System Healthy" : "System Degraded");
    setText(
      "ov-system-meta",
      `broker=${health?.queue?.ok ? "up" : "down"} · scheduler=${health?.scheduler?.alive ? "alive" : "down"} · worker=${health?.worker?.alive ? "alive" : "down"} · semantics=${health?.queue?.semantics || "--"}`,
    );

    const displayMetric = (value) => (Number.isFinite(value) && value >= 0 ? String(value) : "--");
    setText("ov-work", displayMetric(Number(q.work?.messageCount)));
    setText("ov-work-meta", `consumer=${displayMetric(Number(q.work?.consumerCount))} · runtime=${displayMetric(Number(health?.queue?.runtimeConsumers?.work))}`);
    setText("ov-retry", displayMetric(Number(q.retry?.messageCount)));
    const retryRate = health?.counters?.dispatched > 0 ? (health.counters.retryEvents / health.counters.dispatched) * 100 : 0;
    setText("ov-retry-meta", `retry rate=${retryRate.toFixed(1)}%`);
    setText("ov-dead", displayMetric(Number(q.dead?.messageCount)));
    setText("ov-dead-meta", `consumer=${displayMetric(Number(q.dead?.consumerCount))}`);
    const activeLatency = state.overviewRange === "15m" ? latency?.latest?.last15m : latency?.latest?.last5m;
    setText("ov-latency", toMs(activeLatency?.p95Ms ?? 0));
    setText("ov-latency-meta", `window=${state.overviewRange} · avg=${toMs(activeLatency?.avgMs ?? 0)} · 15m=${toMs(latency?.latest?.last15m?.p95Ms ?? 0)}`);

    renderQueueTrend(q, latency, overviewMetrics);

    const storyRows = (stories?.items || [])
      .slice(0, 6)
      .map(
        (s) => `
      <div class="stream-row ${statusClass(s.status)}">
        <span class="stream-story">${esc(s.storyId)}</span>
        <span>${esc(s.phase || "--")}</span>
        ${statusPill(s.status)}
        <span>${esc(s.attempt || 0)}</span>
        <span class="stream-trace">${esc(s.traceId || "--")}</span>
      </div>
    `,
      )
      .join("");
    setHtml("overview-stories-body", storyRows || "<div class='list-item'>no stories</div>");

    const alertItems = (alerts?.recent || []).slice(0, 3).map((a) => ({
      title: `${statusPill(a.ruleId || "alert")} ${esc(a.ruleId || "alert")}`,
      meta: `${esc(a.message || "")} · ${esc(formatEast8(a.timestamp, true))}`,
    }));
    setHtml("overview-alerts", renderListItems(alertItems));

    const rate = overviewMetrics?.rates || {};
    const delta = overviewMetrics?.delta || {};
    setHtml(
      "overview-flow-metrics",
      renderMetricBoxes([
        { label: "completed/min", value: String(Number(rate.completedPerMin || 0).toFixed(2)) },
        { label: "failed/min", value: String(Number(rate.failedPerMin || 0).toFixed(2)) },
        { label: "success", value: toPercent(rate.successRate) },
        { label: "fail", value: toPercent(rate.failRate) },
        { label: "retry/dispatch", value: toPercent(rate.retryRatePerDispatch) },
        { label: "dead/dispatch", value: toPercent(rate.deadRatePerDispatch) },
      ]),
    );

    const hotspots = summarizeFailureHotspots(runs?.items || []);
    const hotspotItems = hotspots.map((x) => ({
      title: `${esc(x.storyId)} · ${x.count} fails`,
      meta: `phase=${esc(x.latestPhase || "--")} · run=${esc(x.latestRunId || "--")} · ${esc(formatEast8(x.latestAt, true))}`,
    }));
    setHtml("overview-hotspots", renderListItems(hotspotItems));

    setHtml("overview-run-status", renderDistributionBars(runs?.totals?.byStatus, { emptyText: "no run status data" }));
    setHtml("overview-phase-breakdown", renderDistributionBars(stories?.totals?.byPhase, { emptyText: "no phase data" }));

    setHtml(
      "overview-render-status",
      `
        <div class="render-line">markdown: parsed + highlighted</div>
        <div class="render-line">json: schema-view + diff-view</div>
        <div class="render-line">last sync: ${esc(formatEast8(Date.now(), true))} (UTC+8)</div>
        <div class="render-line">vision: ${esc(vision?.path || "--")}</div>
        <div class="render-line">overview samples: ${esc(String(overviewMetrics?.sampleCount || 0))}</div>
        <div class="render-line">overview delta: dispatched=${esc(String(delta.dispatched || 0))} completed=${esc(String(delta.completed || 0))} failed=${esc(String(delta.failed || 0))}</div>
        <div class="render-line">overview api: ${state.overviewMetricsUnsupported ? "fallback mode" : "enabled"}</div>
      `,
    );

    setText("control-result", state.lastControl ? `${state.lastControl.action || "action"} · ${formatEast8(state.lastControl.timestamp || Date.now(), true)}` : "no command sent");
  }

  function renderPhaseBars(byPhase) {
    const entries = Object.entries(byPhase || {});
    if (!entries.length) return "<div class='list-item'>no phase data</div>";
    const max = Math.max(1, ...entries.map(([, val]) => Number(val) || 0));
    return entries
      .map(([phase, val]) => {
        const num = Number(val) || 0;
        const width = Math.round((num / max) * 100);
        return `
          <div class="phase-row">
            <span>${esc(phase)}</span>
            <div class="phase-track"><div class="phase-fill" style="width:${width}%"></div></div>
            <span>${esc(num)}</span>
          </div>
        `;
      })
      .join("");
  }

  function getStorySortValue(story, sortKey) {
    if (!story || !sortKey) return "";
    if (sortKey === "attempt") {
      const value = Number(story.attempt);
      return Number.isFinite(value) ? value : -1;
    }
    if (sortKey === "updatedAt") {
      const ts = Date.parse(story.updatedAt || story.createdAt || 0);
      return Number.isFinite(ts) ? ts : 0;
    }
    return String(story[sortKey] ?? "").toLowerCase();
  }

  function sortStoryItems(items) {
    if (!state.storiesSort.key) return items.slice();
    const key = state.storiesSort.key;
    const direction = state.storiesSort.direction === "desc" ? -1 : 1;
    const sorted = items.slice().sort((a, b) => {
      const left = getStorySortValue(a, key);
      const right = getStorySortValue(b, key);

      let cmp = 0;
      if (typeof left === "number" && typeof right === "number") {
        cmp = left - right;
      } else {
        cmp = String(left).localeCompare(String(right), "zh-CN", { numeric: true, sensitivity: "base" });
      }

      if (cmp !== 0) return cmp * direction;
      return String(a.storyId || "").localeCompare(String(b.storyId || ""), "zh-CN", { numeric: true, sensitivity: "base" });
    });
    return sorted;
  }

  function updateStoriesSortUi() {
    const head = $("stories-head");
    if (!head) return;
    head.querySelectorAll("th.sortable[data-sort-key]").forEach((th) => {
      const sortKey = th.dataset.sortKey || "";
      const indicator = th.querySelector(".sort-indicator");
      th.classList.remove("sort-asc", "sort-desc");
      if (sortKey === state.storiesSort.key) {
        const isDesc = state.storiesSort.direction === "desc";
        th.classList.add(isDesc ? "sort-desc" : "sort-asc");
        if (indicator) indicator.textContent = isDesc ? "v" : "^";
      } else if (indicator) {
        indicator.textContent = "-";
      }
    });
  }

  function toggleStoriesSort(sortKey) {
    if (!sortKey) return;
    if (state.storiesSort.key !== sortKey) {
      state.storiesSort.key = sortKey;
      state.storiesSort.direction = "asc";
    } else {
      state.storiesSort.direction = state.storiesSort.direction === "asc" ? "desc" : "asc";
    }
  }

  async function renderStoryDetail(storyId) {
    if (!storyId) {
      setText("stories-detail", "click an Active Stories row to inspect details");
      return;
    }

    try {
      const detail = await fetchWithCache(`story-detail:${storyId}`, `/stories/${encodeURIComponent(storyId)}?limit=20`);
      setJsonView("stories-detail", detail);
    } catch (err) {
      try {
        const [stories, runs] = await Promise.all([
          fetchWithCache("stories100", "/stories?limit=200"),
          fetchWithCache("runs120", "/runs?limit=300"),
        ]);
        const story = (stories?.items || []).find((s) => s.storyId === storyId) || null;
        const allRuns = (runs?.items || []).filter((r) => r.storyId === storyId);
        const detail = {
          timestamp: new Date().toISOString(),
          source: "fallback:/stories+/runs",
          note: `story detail endpoint unavailable (${err.message})`,
          story,
          currentRun: story?.currentRunId ? (allRuns.find((r) => r.runId === story.currentRunId) || null) : null,
          recentRuns: allRuns.slice(0, 20),
        };
        setJsonView("stories-detail", detail);
      } catch (fallbackErr) {
        setText("stories-detail", `load story detail failed: ${fallbackErr.message}`);
      }
    }
  }

  function renderRunTimeline(items) {
    if (!items.length) return "<li class='list-item'>no runs</li>";
    return items
      .map((r) => {
        const runId = r.runId || "";
        const selected = runId && runId === state.selectedRunId ? " selected" : "";
        const reason = formatError(r.error || r.errorCode || "");
        const reasonLine = reason ? `<div class="meta run-error">${esc(reason)}</div>` : "";
        return `
          <li class="list-item run-item${selected}" data-run-id="${esc(runId)}">
            <div class="run-top">
              <div class="run-title">${statusPill(r.status)} <span class="run-id">${esc(runId || "--")}</span></div>
              <div class="run-actions">
                <button class="btn btn-soft run-log-btn" data-run-action="view" data-run-id="${esc(runId)}" ${runId ? "" : "disabled"}>View Log</button>
              </div>
            </div>
            <div class="meta">${esc(r.storyId || "--")} · ${esc(r.phase || "--")} · ${toMs(calcDurationMs(r))} · ${esc(formatEast8(r.updatedAt || r.finishAt || r.startAt || r.dispatchAt))}</div>
            ${reasonLine}
          </li>
        `;
      })
      .join("");
  }

  function updateStorySelectionUi() {
    document.querySelectorAll("#stories-body tr[data-story-id]").forEach((row) => {
      row.classList.toggle("selected", row.dataset.storyId === state.selectedStoryId);
    });
  }

  function updateRunSelectionUi() {
    document.querySelectorAll("#stories-runs .run-item[data-run-id]").forEach((row) => {
      row.classList.toggle("selected", row.dataset.runId === state.selectedRunId);
    });
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function classifyLogLine(line, stream) {
    const text = String(line || "").toLowerCase();
    if (stream === "stderr") {
      if (!text.trim()) return "neutral";
      if (/(warn|warning|retry|deprecated|deprecat)/.test(text)) return "warn";
      return "error";
    }
    if (/(error|exception|traceback|fatal|panic|illegal|cannot|unable|failed|冲突|失败|无法)/.test(text)) return "error";
    if (/(warn|warning|retry|deprecated|deprecat|注意|重试)/.test(text)) return "warn";
    return "neutral";
  }

  function normalizeLogText(value) {
    const raw = typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.join("\n")
        : value == null
          ? ""
          : String(value);

    // Remove ANSI escape sequences and normalize control chars for readable rendering.
    return raw
      .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\u009B[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u0000/g, "")
      .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\t/g, "  ");
  }

  function buildLogRows(text, maxLines = 240) {
    const lines = String(text || "").split("\n");
    if (lines.length === 1 && lines[0] === "") return { rows: [], total: 0 };
    if (lines.length <= maxLines) {
      return {
        total: lines.length,
        rows: lines.map((line, idx) => ({ lineNo: idx + 1, text: line, omitted: false })),
      };
    }

    const headCount = Math.floor(maxLines * 0.6);
    const tailCount = maxLines - headCount;
    const head = lines.slice(0, headCount).map((line, idx) => ({ lineNo: idx + 1, text: line, omitted: false }));
    const tailStart = Math.max(headCount, lines.length - tailCount);
    const tail = lines.slice(tailStart).map((line, idx) => ({ lineNo: tailStart + idx + 1, text: line, omitted: false }));
    const omitted = lines.length - head.length - tail.length;
    const middle = omitted > 0
      ? [{ lineNo: null, text: `... ${omitted} lines omitted ...`, omitted: true }]
      : [];
    return {
      total: lines.length,
      rows: [...head, ...middle, ...tail],
    };
  }

  function renderLogPanel(
    stream,
    text,
    { maxLines = 240, totalChars = null, truncated = false, tailChars = null } = {},
  ) {
    const safeText = normalizeLogText(text);
    const { rows, total } = buildLogRows(safeText, maxLines);
    const nonEmpty = safeText.trim().length > 0;
    const badgeClass = stream === "stderr" ? "status-bad" : "status-info";
    const title = stream === "stderr" ? "stderr" : "stdout";
    const visibleChars = safeText.length;
    const sourceChars = Number.isFinite(totalChars) ? totalChars : visibleChars;
    const isTruncated = Boolean(truncated) || sourceChars > visibleChars;

    if (!nonEmpty) {
      const emptyMeta = isTruncated
        ? `tail only · ${formatBytes(visibleChars)} / ${formatBytes(sourceChars)}`
        : "empty";
      return `
        <article class="log-panel">
          <div class="log-head">
            <span class="status-pill ${badgeClass}">${title}</span>
            <span class="panel-meta">${emptyMeta}</span>
          </div>
          <div class="log-empty">no ${title} output</div>
        </article>
      `;
    }

    const tableRows = rows
      .map((row) => {
        if (row.omitted) {
          return `
            <tr class="log-row omitted">
              <td class="log-no">...</td>
              <td class="log-line">${esc(row.text)}</td>
            </tr>
          `;
        }
        const tone = classifyLogLine(row.text, stream);
        return `
          <tr class="log-row ${tone}">
            <td class="log-no">${row.lineNo}</td>
            <td class="log-line">${esc(row.text)}</td>
          </tr>
        `;
      })
      .join("");

    const metaParts = [`${total} lines`, `${formatBytes(visibleChars)}`];
    if (isTruncated) {
      metaParts.push(`tail only (${formatBytes(visibleChars)} / ${formatBytes(sourceChars)})`);
    }
    if (Number.isFinite(tailChars) && tailChars > 0) {
      metaParts.push(`tailChars=${tailChars}`);
    }

    return `
      <article class="log-panel">
        <div class="log-head">
          <span class="status-pill ${badgeClass}">${title}</span>
          <span class="panel-meta">${metaParts.join(" · ")}</span>
        </div>
        <div class="log-scroll">
          <table class="log-table">
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </article>
    `;
  }

  function renderRunDetailContent(detail) {
    const output = detail?.output || {};
    const hasError = Boolean(detail?.error || detail?.errorCode);
    const duration = toMs(detail?.durationMs);
    const updatedAt = formatEast8(detail?.updatedAt || detail?.finishAt || detail?.startAt || detail?.dispatchAt, true);
    const cards = renderMetricBoxes([
      { label: "runId", value: detail?.runId || "--" },
      { label: "phase", value: detail?.phase || "--" },
      { label: "status", value: detail?.status || "--" },
      { label: "attempt", value: detail?.attempt ?? "--" },
      { label: "exitCode", value: detail?.exitCode ?? "--" },
      { label: "duration", value: duration },
      { label: "updatedAt", value: updatedAt },
    ]);

    const errorBlock = hasError
      ? `<div class="run-detail-error">${esc(formatError(detail.errorCode || detail.error || ""))}</div>`
      : "<div class='run-detail-ok'>no error signal</div>";

    return `
      <div class="run-detail-wrap">
        <div class="inline-metrics">${cards}</div>
        ${errorBlock}
        <div class="log-grid">
          ${renderLogPanel("stdout", output.stdout || "", {
            maxLines: 220,
            totalChars: output.stdoutLength,
            truncated: output.stdoutTruncated,
            tailChars: output.tailChars,
          })}
          ${renderLogPanel("stderr", output.stderr || "", {
            maxLines: 220,
            totalChars: output.stderrLength,
            truncated: output.stderrTruncated,
            tailChars: output.tailChars,
          })}
        </div>
      </div>
    `;
  }

  async function renderRunDetail(runId) {
    if (!runId) {
      setText("stories-run-detail", "click a run item to inspect");
      return;
    }

    try {
      const detail = await fetchWithCache(`run-detail:${runId}`, `/runs/${encodeURIComponent(runId)}?tail=16000`);
      setHtml("stories-run-detail", renderRunDetailContent(detail));
    } catch (err) {
      try {
        const runs = await fetchWithCache("runs120", "/runs?limit=300");
        const run = (runs?.items || []).find((item) => item.runId === runId) || null;
        setJsonView("stories-run-detail", {
          timestamp: new Date().toISOString(),
          source: "fallback:/runs",
          note: `run detail endpoint unavailable (${err.message})`,
          run,
        });
      } catch (fallbackErr) {
        setText("stories-run-detail", `load run detail failed: ${fallbackErr.message}`);
      }
    }
  }

  async function renderStories() {
    const [stories, runs] = await Promise.all([
      fetchWithCache("stories100", "/stories?limit=100"),
      fetchWithCache("runs120", "/runs?limit=120"),
    ]);

    const totals = stories?.totals || {};
    const byStatus = totals.byStatus || {};
    setHtml(
      "stories-summary",
      renderMetricBoxes([
        { label: "total", value: totals.all ?? (stories?.items || []).length },
        { label: "running", value: byStatus.running ?? 0 },
        { label: "queued", value: byStatus.queued ?? 0 },
        { label: "pending", value: byStatus.pending ?? 0 },
        { label: "completed", value: byStatus.completed ?? 0 },
        { label: "dead", value: byStatus.dead ?? 0 },
      ]),
    );
    setHtml("stories-phase", renderPhaseBars(totals.byPhase || {}));

    const items = stories?.items || [];
    const sortedItems = sortStoryItems(items);
    if (!state.selectedStoryId && sortedItems.length) state.selectedStoryId = sortedItems[0].storyId;
    if (state.selectedStoryId && !sortedItems.some((s) => s.storyId === state.selectedStoryId)) {
      state.selectedStoryId = sortedItems[0]?.storyId || null;
    }

    const rows = sortedItems
      .map((s) => {
        const selectedClass = s.storyId === state.selectedStoryId ? "selected" : "";
        const storyHref = `/story.html?storyId=${encodeURIComponent(s.storyId || "")}`;
        return `
          <tr class="${selectedClass}" data-story-id="${esc(s.storyId)}">
            <td><a class="story-link" data-open-story="true" data-story-id="${esc(s.storyId)}" href="${storyHref}">${esc(s.storyId)}</a></td>
            <td>${esc(s.prdId || "")}</td>
            <td>${esc(s.phase || "")}</td>
            <td>${statusPill(s.status)}</td>
            <td>${esc(s.attempt)}</td>
            <td>${esc(s.currentRunId || "")}</td>
            <td>${esc(s.traceId || "")}</td>
            <td>${esc(formatEast8(s.updatedAt, true))}</td>
            <td>
              <div class="row-actions">
                <button class="action-retry" data-story-action="retry" data-story-id="${esc(s.storyId)}">Retry</button>
                <button class="action-delete" data-story-action="delete" data-story-id="${esc(s.storyId)}">Delete</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
    setHtml("stories-body", rows || "<tr><td colspan='9'>no stories</td></tr>");
    updateStoriesSortUi();
    updateStorySelectionUi();

    const runItems = (runs?.items || []).slice(0, 12);
    if (!state.selectedRunId && runItems.length) {
      const firstFailed = runItems.find((r) => isFailureStatus(r.status));
      state.selectedRunId = firstFailed?.runId || runItems[0]?.runId || null;
    }
    if (state.selectedRunId && !runItems.some((r) => r.runId === state.selectedRunId)) {
      const firstFailed = runItems.find((r) => isFailureStatus(r.status));
      state.selectedRunId = firstFailed?.runId || runItems[0]?.runId || null;
    }
    setHtml("stories-runs", renderRunTimeline(runItems));
    updateRunSelectionUi();

    updateNotificationUi();
    if (state.notifications.enabled && !state.notifications.primed) {
      rememberFailureRuns(runs?.items || []);
      state.notifications.primed = true;
    }
    notifyFailureRuns(runs?.items || []);

    await renderRunDetail(state.selectedRunId);
    await renderStoryDetail(state.selectedStoryId);
  }

  function inferPhaseBadge(phase, story, run) {
    const normalizedStatus = String(run?.status || "").toLowerCase();
    if (run) {
      if (normalizedStatus === "success") return { label: "PASS", tone: "status-ok" };
      if (isFailureStatus(normalizedStatus)) return { label: normalizedStatus || "FAIL", tone: "status-bad" };
      if (normalizedStatus) return { label: normalizedStatus, tone: "status-info" };
    }

    if (story?.phase === phase) {
      if (isFailureStatus(story.status)) return { label: String(story.status), tone: "status-bad" };
      return { label: "current", tone: "status-info" };
    }

    const phases = Array.isArray(story?.phases) ? story.phases : [];
    const currentIndex = phases.indexOf(story?.phase);
    const phaseIndex = phases.indexOf(phase);
    if (phaseIndex >= 0 && currentIndex >= 0 && phaseIndex < currentIndex) {
      return { label: "done", tone: "status-ok" };
    }
    return { label: "pending", tone: "status-neutral" };
  }

  function renderStoryPhaseCard(phase, story, run, runDetail) {
    const badge = inferPhaseBadge(phase, story, run);
    const meta = run
      ? `${run.runId || "--"} · attempt ${run.attempt ?? "--"} · ${formatEast8(run.updatedAt || run.finishAt || run.startAt || run.dispatchAt, true)}`
      : "no run record";
    const error = runDetail?.error || run?.error || run?.errorCode || "";
    const errorBlock = error
      ? `<div class="phase-error">${esc(formatError(error))}</div>`
      : "<div class='phase-ok'>no error signal</div>";

    return `
      <article class="phase-card">
        <div class="phase-head">
          <h4>${esc(phase)}</h4>
          <span class="status-pill ${badge.tone}">${esc(badge.label)}</span>
        </div>
        <div class="phase-meta">${esc(meta)}</div>
        ${errorBlock}
        <div class="log-grid">
          ${renderLogPanel("stdout", runDetail?.output?.stdout || "", {
            maxLines: 120,
            totalChars: runDetail?.output?.stdoutLength,
            truncated: runDetail?.output?.stdoutTruncated,
            tailChars: runDetail?.output?.tailChars,
          })}
          ${renderLogPanel("stderr", runDetail?.output?.stderr || "", {
            maxLines: 120,
            totalChars: runDetail?.output?.stderrLength,
            truncated: runDetail?.output?.stderrTruncated,
            tailChars: runDetail?.output?.tailChars,
          })}
        </div>
      </article>
    `;
  }

  async function renderStoryPage() {
    const storyId = getStoryIdFromQuery();
    if (!storyId) {
      setText("story-page-title", "Story not selected");
      setText("story-page-subtitle", "open this page with /story.html?storyId=...");
      setHtml("story-summary", renderMetricBoxes([{ label: "storyId", value: "--" }, { label: "status", value: "--" }]));
      setHtml("story-phase-grid", "<article class='phase-card phase-card-empty'><h4>No story selected</h4><p>go back to Stories and click one row</p></article>");
      setText("story-run-list", "no runs");
      setJsonView("story-raw-detail", { error: "missing_story_id_query" });
      return;
    }

    const detail = await fetchWithCache(`story-detail:${storyId}`, `/stories/${encodeURIComponent(storyId)}?limit=80`);
    const story = detail?.story || {};
    const recentRuns = Array.isArray(detail?.recentRuns) ? detail.recentRuns : [];

    setText("story-page-title", storyId);
    setText("story-page-subtitle", `${story.phase || "--"} · ${story.status || "--"} · attempt ${story.attempt ?? "--"}/${story.maxAttempts ?? "--"}`);
    setHtml(
      "story-summary",
      renderMetricBoxes([
        { label: "storyId", value: story.storyId || story.id || storyId },
        { label: "prdId", value: story.prdId || "--" },
        { label: "status", value: story.status || "--" },
        { label: "phase", value: story.phase || "--" },
        { label: "attempt", value: `${story.attempt ?? "--"} / ${story.maxAttempts ?? "--"}` },
        { label: "updatedAt", value: formatEast8(story.updatedAt, true) },
      ]),
    );

    const phaseList = Array.isArray(story.phases) && story.phases.length > 0
      ? story.phases
      : ["research", "explore", "plan", "implement", "review"];
    const latestRunByPhase = new Map();
    for (const run of recentRuns) {
      const phase = run?.phase;
      if (!phase || latestRunByPhase.has(phase)) continue;
      latestRunByPhase.set(phase, run);
    }

    const phaseRunIds = [...latestRunByPhase.values()]
      .map((run) => run?.runId)
      .filter(Boolean);
    const runDetailPairs = await Promise.all(
      phaseRunIds.map(async (runId) => {
        try {
          const runDetail = await fetchWithCache(`run-detail-full:${runId}`, `/runs/${encodeURIComponent(runId)}?tail=20000`);
          return [runId, runDetail];
        } catch {
          return [runId, null];
        }
      }),
    );
    const runDetailByRunId = new Map(runDetailPairs);

    const phaseCards = phaseList
      .map((phase) => {
        const phaseRun = latestRunByPhase.get(phase) || null;
        const phaseRunDetail = phaseRun ? runDetailByRunId.get(phaseRun.runId) : null;
        return renderStoryPhaseCard(phase, story, phaseRun, phaseRunDetail);
      })
      .join("");
    setHtml(
      "story-phase-grid",
      phaseCards || "<article class='phase-card phase-card-empty'><h4>No phases</h4><p>story has no configured phases</p></article>",
    );

    const recentRunRows = recentRuns
      .slice(0, 20)
      .map((run) => `${run.runId || "--"} · ${run.phase || "--"} · ${run.status || "--"} · ${formatEast8(run.updatedAt || run.finishAt || run.dispatchAt, true)}`)
      .join("\n");
    setText("story-run-list", recentRunRows || "no runs");
    setJsonView("story-raw-detail", detail);
  }

  function renderRuleCard(name, rule, runtimeState) {
    const active = Boolean(runtimeState?.activeSince || runtimeState?.active);
    const threshold = typeof rule?.threshold === "number" ? `${Math.round(rule.threshold * 100)}%` : String(rule?.threshold || "--");
    const durationMs = Number(rule?.durationMs || 0);
    const durationLabel = durationMs ? `${Math.round(durationMs / 60000)}m` : "--";
    const severityClass = name.toLowerCase().includes("dead")
      ? "pill-high"
      : name.toLowerCase().includes("retry")
        ? "pill-medium"
        : "pill-low";

    return `
      <div class="rule-card">
        <div class="rule-top">
          <div class="rule-name">${esc(name)}</div>
          <span class="status-pill ${active ? "status-ok" : "status-bad"}">${active ? "ON" : "OFF"}</span>
        </div>
        <div class="rule-meta">${esc(runtimeState?.message || "rule threshold and duration config")}</div>
        <div class="rule-grid">
          <div class="field">
            <label>Threshold</label>
            <input class="input mono-input" value="${esc(threshold)}" readonly>
          </div>
          <div class="field">
            <label>Duration</label>
            <input class="input mono-input" value="${esc(durationLabel)}" readonly>
          </div>
          <div>
            <label class="panel-meta">Severity</label>
            <div class="pill ${severityClass}">${name.toLowerCase().includes("dead") ? "HIGH" : name.toLowerCase().includes("retry") ? "MEDIUM" : "LOW"}</div>
          </div>
        </div>
      </div>
    `;
  }

  function renderFailureTaxonomy(items) {
    const map = new Map();
    for (const item of items || []) {
      const key = item.errorCode || item.payload?.errorCode || "UNKNOWN";
      map.set(key, (map.get(key) || 0) + 1);
    }
    const rows = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (!rows.length) return renderMetricBoxes([{ label: "no failures", value: 0 }]);
    return renderMetricBoxes(rows.map(([k, v]) => ({ label: k, value: v })));
  }

  function renderDeadDetail(item) {
    if (!item) {
      setText("incidents-dead-detail", "click a row to inspect");
      return;
    }
    setJsonView("incidents-dead-detail", item);
  }

  async function renderIncidents() {
    const [alerts, dead, health] = await Promise.all([
      fetchWithCache("alerts200", "/alerts?limit=200"),
      fetchWithCache("dead200", "/dead-letters?limit=200"),
      fetchWithCache("health", "/health"),
    ]);

    const live = (alerts?.recent || []).slice(0, 12).map((a) => ({
      title: `${statusPill(a.ruleId || "alert")} <span>${esc(a.ruleId || "alert")}</span>`,
      meta: `${esc(a.message || "")} · ${esc(formatEast8(a.timestamp, true))}`,
    }));
    setHtml("incidents-alerts", renderListItems(live));

    const rules = alerts?.rules || {};
    const alertState = alerts?.runtime?.alertState || {};
    const ruleCards = Object.entries(rules)
      .map(([name, rule]) => renderRuleCard(name, rule, alertState[name] || {}))
      .join("");
    setHtml(
      "incidents-rules",
      `${ruleCards}
       <div class="rule-actions">
         <div class="rule-actions-left">
           <button class="btn btn-soft" data-rule-action="test">Test Rule</button>
           <button class="btn btn-muted" data-rule-action="reset">Reset</button>
         </div>
         <button class="btn btn-accent" data-rule-action="apply">Apply Rules</button>
       </div>`,
    );

    state.deadItems = dead?.items || [];
    if (state.deadSelected == null && state.deadItems.length > 0) state.deadSelected = 0;
    if (state.deadSelected != null && state.deadSelected >= state.deadItems.length) state.deadSelected = state.deadItems.length - 1;
    if (!state.deadItems.length) state.deadSelected = null;

    setText("incidents-dead-count", `${state.deadItems.length}`);
    const deadStoryCount = Number(health?.storyStatus?.dead || 0);
    const reviveBtn = $("incidents-revive-dead");
    if (reviveBtn) {
      reviveBtn.disabled = deadStoryCount <= 0;
      reviveBtn.textContent = deadStoryCount > 0 ? `Reset Dead -> Pending (${deadStoryCount})` : "Reset Dead -> Pending";
    }
    const rows = state.deadItems
      .map((d, index) => {
        const storyId = d.storyId || d.payload?.storyId || "";
        const phase = d.phase || d.payload?.phase || "";
        const attempt = d.attempt || d.payload?.attempt || "";
        const traceId = d.traceId || d.payload?.traceId || "";
        const error = formatError(d.error || d.lastError || d.payload?.lastError || "");
        const selected = state.deadSelected === index ? "selected" : "";
        return `
          <tr data-dead-index="${index}" class="${selected}">
            <td>${esc(storyId)}</td>
            <td>${esc(phase)}</td>
            <td>${esc(attempt)}</td>
            <td>${esc(traceId)}</td>
            <td>${esc(error)}</td>
          </tr>
        `;
      })
      .join("");
    setHtml("incidents-dead-body", rows || "<tr><td colspan='5'>no dead letters</td></tr>");

    renderDeadDetail(state.deadItems[state.deadSelected] || null);
    setHtml("incidents-failure", renderFailureTaxonomy(state.deadItems));

    setJsonView("incidents-command-state", {
      control: health?.control || {},
      lastCommand: state.lastControl || null,
    });
  }

  async function sendControl(action, extra = {}) {
    const storyId = $("control-story-id")?.value?.trim() || "";
    const runId = $("control-run-id")?.value?.trim() || "";
    const body = { action, reason: "requested_from_dashboard", ...extra };
    if (storyId) body.storyId = storyId;
    if (runId) body.runId = runId;
    const response = await postJson("/control", body);
    state.lastControl = { ...response, action, timestamp: new Date().toISOString() };
    clearCache(["health", "stories100", "stories12", "runs120", "alerts200", "alerts8", "dead200", "projects", "overviewMetrics"]);
    for (const key of Object.keys(state.cache)) {
      if (key.startsWith("story-detail:") || key.startsWith("run-detail:") || key.startsWith("run-detail-full:")) {
        delete state.cache[key];
      }
    }
    const revivedCount = Number(response?.payload?.revivedCount || 0);
    const summary = action === "revive_dead" ? `${action} ok (${revivedCount})` : `${action} ok`;
    setText("control-result", `${summary} · ${formatEast8(Date.now(), true)}`);
    await refresh();
  }

  async function sendProjectControl(action, extra = {}) {
    const projectId = extra.projectId || $("project-control-id")?.value?.trim() || state.selectedProjectId || "";
    if (!projectId) throw new Error("projectId is required");
    const mode = extra.mode || $("project-control-mode")?.value?.trim() || "resume_existing";
    const prdFileInput = $("project-control-prd-file")?.value?.trim() || "";
    const roadmapFileInput = $("project-control-roadmap-file")?.value?.trim() || "";
    const body = { action, mode, reason: "requested_from_projects", ...extra };
    if (action === "start") {
      if (prdFileInput) body.prdFile = prdFileInput;
      if (roadmapFileInput) body.roadmapFile = roadmapFileInput;
    }
    delete body.projectId;
    delete body.mode;
    body.mode = mode;
    const response = await postJson(`/projects/${encodeURIComponent(projectId)}/control`, body);
    state.lastControl = { ...response, action: `project:${action}`, timestamp: new Date().toISOString() };
    clearCache(["health", "stories100", "stories12", "runs120", "alerts200", "alerts8", "dead200", "projects", "queuesMetrics", "latency", "overviewMetrics"]);
    for (const key of Object.keys(state.cache)) {
      if (
        key.startsWith("story-detail:")
        || key.startsWith("run-detail:")
        || key.startsWith("run-detail-full:")
      ) {
        delete state.cache[key];
      }
    }
    const summary = response?.payload?.action || action;
    setText("project-control-state", `${summary} ok · ${formatEast8(Date.now(), true)}`);
    setText("control-result", `${summary} ok · ${formatEast8(Date.now(), true)}`);
    await refresh();
  }

  async function sendBootStart(mode, extra = {}) {
    const body = {
      mode,
      reason: "boot_from_ui",
      autoResume: true,
      resetBeforeLoad: true,
      ...extra,
    };
    const response = await postJson("/boot/start", body);
    state.lastControl = { ...response, action: `boot:${mode}`, timestamp: new Date().toISOString() };
    clearCache(["health", "bootWorkspace", "bootVision", "bootPreflight", "stories100", "stories12", "runs120", "alerts200", "alerts8", "dead200", "projects", "overviewMetrics"]);
    for (const key of Object.keys(state.cache)) {
      if (key.startsWith("story-detail:") || key.startsWith("run-detail:") || key.startsWith("run-detail-full:")) {
        delete state.cache[key];
      }
    }
    setText("control-result", `boot ${mode} ok · ${formatEast8(Date.now(), true)}`);
    await refresh();
  }

  async function handleStoryAction(action, storyId) {
    if (!storyId) return;
    const controlAction = action === "retry" ? "restart" : "cancel";
    const reason = action === "retry" ? "retry_from_story_table" : "delete_from_story_table";
    const extra = action === "retry"
      ? { storyId, reason, resetAttempts: true }
      : { storyId, reason };
    await sendControl(controlAction, extra);
  }

  async function refresh() {
    if (state.refreshInFlight) return;
    state.refreshInFlight = true;
    try {
      try {
        const health = await fetchWithCache("health", "/health");
        updateHeaderHealth(health);
      } catch (err) {
        setText("chip-env", "env: degraded");
        setText("chip-timezone", "timezone: UTC+8");
        console.error(err);
      }

      if (state.page === "projects" || state.page === "boot") await renderBoot();
      if (state.page === "overview") await renderOverview();
      if (state.page === "stories") await renderStories();
      if (state.page === "story") await renderStoryPage();
      if (state.page === "incidents") await renderIncidents();
    } catch (err) {
      console.error(err);
    } finally {
      state.refreshInFlight = false;
      setText("chip-refresh", `refresh ${Math.round(POLL_MS / 1000)}s · ${formatEast8(Date.now(), false)} (UTC+8)`);
    }
  }

  loadNotificationPrefs();
  updateNotificationUi();

  syncPageChrome(state.page);
  refreshIcons();

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setPage(btn.dataset.page));
  });

  document.addEventListener("click", async (event) => {
    const pageBtn = event.target.closest("button[data-page], a[data-page]");
    if (pageBtn && !pageBtn.classList.contains("nav-item")) {
      const targetPage = pageBtn.dataset.page || "";
      if (Object.prototype.hasOwnProperty.call(PAGE_ROUTES, targetPage)) {
        setPage(targetPage);
        return;
      }
    }

    const projectModalBtn = event.target.closest("[data-project-modal]");
    if (projectModalBtn) {
      const action = projectModalBtn.dataset.projectModal;
      if (action === "open") setProjectModal(true);
      if (action === "close") setProjectModal(false);
      return;
    }

    const projectActionBtn = event.target.closest("[data-project-action]");
    if (projectActionBtn) {
      const action = projectActionBtn.dataset.projectAction;
      const projectId = projectActionBtn.dataset.projectId || "";
      const stage = projectActionBtn.dataset.projectStage || "";
      try {
        if (action === "create") {
          await createProject();
          return;
        }
        if (action === "cancel_edit") {
          clearProjectCreateForm();
          return;
        }
        if (action === "edit" && projectId) {
          await startEditProject(projectId);
          return;
        }
        if (action === "move_prev" && projectId) {
          await moveProject(projectId, stage, "prev");
          return;
        }
        if (action === "move_next" && projectId) {
          await moveProject(projectId, stage, "next");
          return;
        }
        if (action === "delete" && projectId) {
          await deleteProject(projectId);
          return;
        }
      } catch (err) {
        setText("control-result", `project action failed: ${err.message}`);
        return;
      }
    }

    const projectControlBtn = event.target.closest("[data-project-control]");
    if (projectControlBtn) {
      const action = projectControlBtn.dataset.projectControl || "";
      const explicitProjectId = projectControlBtn.dataset.projectId || "";
      const explicitMode = projectControlBtn.dataset.projectMode || "";
      try {
        const extra = {};
        if (explicitProjectId) extra.projectId = explicitProjectId;
        if (explicitMode) extra.mode = explicitMode;
        await sendProjectControl(action, extra);
      } catch (err) {
        setText("project-control-state", `project control failed: ${err.message}`);
        setText("control-result", `project control failed: ${err.message}`);
      }
      return;
    }

    const stepBtn = event.target.closest("[data-step]");
    if (stepBtn && $("boot-step-tabs")?.contains(stepBtn)) {
      state.bootStep = Number.parseInt(stepBtn.dataset.step || "1", 10);
      await renderBoot();
      return;
    }

    if (event.target.closest("#boot-prev")) {
      state.bootStep = Math.max(1, state.bootStep - 1);
      await renderBoot();
      return;
    }

    if (event.target.closest("#boot-next")) {
      state.bootStep = Math.min(4, state.bootStep + 1);
      await renderBoot();
      return;
    }

    const controlBtn = event.target.closest("[data-control]");
    if (controlBtn) {
      const action = controlBtn.dataset.control;
      if (action === "revive_dead") {
        const deadStoryCount = Number(state.cache?.health?.storyStatus?.dead || 0);
        const confirmText =
          deadStoryCount > 0
            ? `Reset ${deadStoryCount} dead stories to pending?`
            : "Reset all dead stories to pending?";
        if (!window.confirm(confirmText)) return;
      }
      try {
        const reason = action === "revive_dead" ? "revive_dead_from_incidents" : undefined;
        await sendControl(action, reason ? { reason } : {});
      } catch (err) {
        setText("control-result", `control failed: ${err.message}`);
      }
      return;
    }

    const sortTh = event.target.closest("#stories-head th.sortable[data-sort-key]");
    if (sortTh) {
      toggleStoriesSort(sortTh.dataset.sortKey || "");
      await renderStories();
      return;
    }

    const rangeBtn = event.target.closest("[data-latency-range]");
    if (rangeBtn) {
      state.overviewRange = rangeBtn.dataset.latencyRange === "15m" ? "15m" : "5m";
      await renderOverview();
      return;
    }

    const bootStartBtn = event.target.closest("[data-boot-start]");
    if (bootStartBtn) {
      const mode = bootStartBtn.dataset.bootStart || "resume_existing";
      try {
        await sendBootStart(mode);
      } catch (err) {
        setText("control-result", `boot failed: ${err.message}`);
      }
      return;
    }

    const storyActionBtn = event.target.closest("[data-story-action]");
    if (storyActionBtn) {
      event.stopPropagation();
      const action = storyActionBtn.dataset.storyAction;
      const storyId = storyActionBtn.dataset.storyId;
      try {
        await handleStoryAction(action, storyId);
      } catch (err) {
        setText("control-result", `story action failed: ${err.message}`);
      }
      return;
    }

    const runActionBtn = event.target.closest("[data-run-action]");
    if (runActionBtn) {
      event.stopPropagation();
      const runId = runActionBtn.dataset.runId || "";
      if (runId) {
        state.selectedRunId = runId;
        updateRunSelectionUi();
        await renderRunDetail(runId);
      }
      return;
    }

    const openStoryBtn = event.target.closest("[data-open-story]");
    if (openStoryBtn) {
      event.preventDefault();
      const storyId = openStoryBtn.dataset.storyId || "";
      if (storyId) openStoryDetailPage(storyId);
      return;
    }

    const storyRow = event.target.closest("#stories-body tr[data-story-id]");
    if (storyRow) {
      const storyId = storyRow.dataset.storyId || "";
      if (storyId) {
        state.selectedStoryId = storyId;
        updateStorySelectionUi();
        await renderStoryDetail(storyId);
      }
      return;
    }

    const runRow = event.target.closest("#stories-runs .run-item[data-run-id]");
    if (runRow) {
      const runId = runRow.dataset.runId || "";
      if (runId) {
        state.selectedRunId = runId;
        updateRunSelectionUi();
        await renderRunDetail(runId);
      }
      return;
    }

    const notifyActionBtn = event.target.closest("[data-notify-action]");
    if (notifyActionBtn) {
      const action = notifyActionBtn.dataset.notifyAction;
      if (action === "enable") {
        const permission = await requestNotificationPermission();
        if (permission === "granted") {
          state.notifications.enabled = true;
          rememberFailureRuns(state.cache.runs120?.items || []);
          state.notifications.primed = true;
          saveNotificationPrefs();
          updateNotificationUi();
          setText("control-result", `notifications enabled · ${formatEast8(Date.now(), true)}`);
        } else {
          state.notifications.enabled = false;
          saveNotificationPrefs();
          updateNotificationUi();
          setText("control-result", `notifications unavailable: ${permission}`);
        }
        return;
      }
      if (action === "disable") {
        state.notifications.enabled = false;
        saveNotificationPrefs();
        updateNotificationUi();
        setText("control-result", `notifications muted · ${formatEast8(Date.now(), true)}`);
        return;
      }
      if (action === "test") {
        const permission = await requestNotificationPermission();
        updateNotificationUi();
        if (permission === "granted") {
          sendSystemNotification(
            "Aha Loop MQ reminder",
            `test notification · ${formatEast8(Date.now(), true)}`,
            "aha-loop-mq-test",
          );
          setText("control-result", `notification test sent · ${formatEast8(Date.now(), true)}`);
        } else {
          setText("control-result", `notification test blocked: ${permission}`);
        }
        return;
      }
    }

    const deadRow = event.target.closest("#incidents-dead-body tr[data-dead-index]");
    if (deadRow) {
      const index = Number.parseInt(deadRow.dataset.deadIndex || "-1", 10);
      if (!Number.isNaN(index) && index >= 0) {
        state.deadSelected = index;
        renderDeadDetail(state.deadItems[index] || null);
        document.querySelectorAll("#incidents-dead-body tr").forEach((row) => row.classList.remove("selected"));
        deadRow.classList.add("selected");
      }
      return;
    }

    const ruleAction = event.target.closest("[data-rule-action]");
    if (ruleAction) {
      const action = ruleAction.dataset.ruleAction;
      setText("control-result", `rule ${action} requested (backend rule mutation endpoint not yet available)`);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!state.projectModalOpen) return;
    setProjectModal(false);
  });

  document.addEventListener("change", async (event) => {
    const projectSelect = event.target.closest("#project-control-id");
    if (projectSelect) {
      state.selectedProjectId = projectSelect.value || null;
      const projects = state.cache.projects;
      const current = (projects?.items || []).find((item) => item.id === state.selectedProjectId);
      const modeSelect = $("project-control-mode");
      if (modeSelect && current?.bootMode) modeSelect.value = current.bootMode;
      if ($("project-control-prd-file")) $("project-control-prd-file").value = current?.prdFile || "";
      if ($("project-control-roadmap-file")) $("project-control-roadmap-file").value = current?.roadmapFile || "";
      return;
    }

  });

  refresh().catch((err) => console.error(err));
  setInterval(() => refresh().catch((err) => console.error(err)), POLL_MS);
})();
