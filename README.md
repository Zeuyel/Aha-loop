# Aha-Loop MQ

状态机 + RabbitMQ + Git Worktree 并行调度框架。

## 作为 npm 应用使用

安装（全局）：

```bash
npm install -g aha-loop-mq
```

可用命令：

- `aha-loop` / `aha-loop-mq`：启动完整引擎
- `aha-loop-web`：仅启动前端页面与监控 API（联调模式）

示例：

```bash
aha-loop --vision ./project.vision.md --workspace /path/to/project
aha-loop-web --monitor-port 17373
```

也可直接使用 npx：

```bash
npx -y aha-loop-mq --vision ./project.vision.md --workspace /path/to/project
```

## 唯一入口

用户只需提供 `project.vision.md`:

```bash
npx aha-loop --vision ./project.vision.md --workspace /path/to/project
```

或使用本地监控入口（默认恢复状态）:

```bash
npm run ui
```

仅启动前端页面与只读/项目管理 API（不启动 MQ worker/scheduler）:

```bash
npm run web
```

说明：`web` 模式下控制动作返回模拟结果，仅用于页面联调/演示。

## 全局项目持久化

- 默认不再按当前工作目录隔离状态。
- 项目与运行态统一持久化到用户级目录：
  - Windows: `%APPDATA%\\aha-loop-mq\\state.json`
  - macOS: `~/Library/Application Support/aha-loop-mq/state.json`
  - Linux: `$XDG_STATE_HOME/aha-loop-mq/state.json`（未设置时为 `~/.local/state/aha-loop-mq/state.json`）
- 首次启动时，如果全局 state 不存在且当前 workspace 下存在旧 `.aha-loop/state.json`，会自动迁移一次。
- 可覆盖：
  - `AHA_LOOP_HOME=/path/to/home`
  - `AHA_LOOP_STATE_FILE=/path/to/state.json`
  - `node src/index.js --state-file /path/to/state.json`

系统自动完成:
1. **Vision → Architecture** — AI 分析愿景, 生成架构文档
2. **Architecture → Roadmap** — AI 规划里程碑, 拆分 PRD
3. **PRD → Stories** — 每个 Story 进入状态机, 由 Scheduler 调度
4. **Stories → Worktrees** — 每个 Story 独占一个 git worktree, 并行执行
5. **Worktrees → Merge Gate** — 默认进入人工审批 gate，显式 `approve_merge` 后才执行合并

执行编排由 `src/scheduler/scheduler.js` 完成，不依赖旧的 shell 调度循环。

## 架构

```
Pipeline (串行)          Scheduler (轮询)         Worker Pool (并行)
vision.md               Store ←→ StateMachine    SessionPool
  → architect             ↓                        ↓
  → roadmap            RabbitMQ                  spawn AI agent
  → PRD                  work / retry / dead       ↓
  → Store.load                                   git worktree
```

## Story 阶段标准

- 默认阶段统一为 **5 phase**：`research → explore → plan → implement → review`
- 对已完成标记自动跳过阶段：
  - `researchCompleted=true` 跳过 `research`
  - `explorationCompleted=true` 跳过 `explore`
  - `planReviewCompletedAt` 或 `planCompleted=true` 跳过 `plan`
  - `qualityReviewCompletedAt` / `qualityReviewCompleted=true` / `reviewCompleted=true` 跳过 `review`
- 若 roadmap/prd 显式提供 `phases`，则按显式配置执行
- `review` 统一代表质量验收阶段，别名 `quality-review` / `quality_review` / `qa` 都会归一到 `review`

## 执行契约与状态源

- `phase-engine` 要求执行代理输出结构化回执：`AHA_LOOP_PHASE_RESULT_JSON: {...}`
- `session-pool` 优先消费结构化回执，文本语义判错仅作为兼容兜底
- `.aha-loop/prd.json` 作为业务输入只读；运行态快照写入 `.aha-loop/runtime/story-context.json`

## Merge 策略

- 默认 `MERGE_MODE=manual_gate`（推荐，安全）
- 可显式设置 `MERGE_MODE=auto` 启用自动合并
- 手工审批接口：
  - `POST /control` with `{"action":"approve_merge","storyId":"..."}`
  - `POST /projects/{id}/control` with `{"action":"approve_merge","storyId":"..."}`

## 权限默认值

- 默认不使用危险权限标志（最小权限）：
  - `TOOL_DANGEROUS_BYPASS=false`
  - `TOOL_SKIP_GIT_REPO_CHECK=true`
- 仅在确有必要时显式开启：
  - CLI: `--tool-dangerous-bypass`
  - ENV: `TOOL_DANGEROUS_BYPASS=true`

## 并行调度模式

- scheduler 支持 roadmap 内并行执行：
  - PRD 级：`dependsOn` 满足后自动 `queued → active`
  - Story 级：`dependencies`/`dependsOn` 满足后进入可分发集合
  - 同一 PRD 内无依赖冲突的 story 可并行运行
- 实际并行度由 `maxConcurrency` 与 RabbitMQ `prefetch` 共同决定：
  - 默认 `RMQ_PREFETCH=0`（自动跟随 `maxConcurrency`）
  - 可用 `MAX_CONCURRENCY` / `RMQ_PREFETCH` 显式覆盖

## 前端框架选型（MQ Monitor UI）

- **框架**: Vanilla HTML/CSS/JS（多页面 MPA）
- **原因**: 当前 `src/monitor/monitor.js` 直接托管 `src/public` 静态文件，无构建链；该方案与现有运行方式完全兼容，部署成本最低。
- **页面**:
  - `/projects.html`
  - `/overview.html`
  - `/stories.html`
  - `/incidents.html`
  - `/` 默认重定向到 `/projects.html`

## 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| StateMachine | `src/core/state-machine.js` | 通用有限状态机引擎 |
| Store | `src/store/store.js` | 统一存储 + 状态机校验 |
| Queue | `src/queue/queue.js` | RabbitMQ 三队列拓扑 |
| Scheduler | `src/scheduler/scheduler.js` | 轮询调度 (大脑) |
| Worker | `src/worker/worker.js` | MQ 消费 → 执行 |
| SessionPool | `src/worker/session-pool.js` | 进程池管理 |
| WorktreeManager | `src/worktree/worktree.js` | git worktree 生命周期 |
| Pipeline | `src/pipeline/pipeline.js` | Vision → PRD 自动化 |
| Monitor | `src/monitor/monitor.js` | 健康报告 |

## 前置条件

- Node.js >= 18
- RabbitMQ AMQP 端口可用 (默认 `amqp://127.0.0.1:5672/%2F`)
- RabbitMQ Management API 可用 (默认 `http://127.0.0.1:15672`)
- Git

## 可观测接口

启动后默认开放监控接口（`MONITOR_HTTP_PORT=17373`）:

- `GET /`  
  监控前端 UI（重定向到 `/projects.html`）
- `GET /projects.html`  
  Projects 页面（项目 CRUD + 启停控制）
- `GET /boot.html`  
  兼容入口（重定向到 `/projects.html`）
- `GET /overview.html`  
  总览页面（队列、延迟、生命周期流、告警、控制）
- `GET /stories.html`  
  Stories 页面（状态分布、故事表、运行时间线）
- `GET /incidents.html`  
  Incidents 页面（告警、规则、死信、故障分类）
- `GET /metrics/queues`  
  单接口返回 `work/retry/dead` 三队列的 `messageCount` 与 `consumerCount`
- `GET /health`  
  同时返回 `service.alive` 与 `service.available`，并包含 queue / scheduler / worker / sessionPool 状态  
  queue 内含 `runtimeConsumers`（本进程消费器数）和 broker 侧 `consumerCount`
- `GET /metrics/latency`  
  返回最近 5/15 分钟的延迟聚合（count/avg/p95）和趋势序列
- `GET /metrics/prometheus`  
  Prometheus 文本格式指标（queue/counter/latency/service）
- `GET /stories`  
  story 状态统计与最近列表（含 `currentRunId/currentRunStatus`，支持 `?limit=50`）
- `GET /runs`  
  codex 调用级运行记录（runId / sessionId / status / start/finish / errorCode，支持 `?limit=100&storyId=...`）
- `GET /alerts`  
  告警规则阈值、运行窗口与最近告警事件（支持 `?limit=50`）
- `GET /dead-letters`  
  从 `.aha-loop/dead-letters.jsonl` 读取最近死信记录（支持 `?limit=50`）
- `GET /boot/workspace`  
  workspace / queue / semantics / tool / maxConcurrency / prefetch 等运行配置
- `GET /boot/vision`  
  当前 vision 文件路径与内容（若存在）

## 结构化日志

日志统一为 JSON，关键事件至少覆盖:

- `dispatch`
- `start`
- `success`
- `fail`
- `retry`
- `dead`
- `merge`

关键事件统一字段:

- `timestamp`
- `level`
- `event`
- `storyId`
- `prdId`
- `phase`
- `attempt`
- `traceId`
- `error`

run 级关键字段:

- `runId`
- `sessionId`
- `exitCode`
- `errorCode`
- `errorSource`

可通过 `storyId` + `traceId` 串联完整生命周期。

## 消费语义（已固化）

当前消费模式为 **amqplib consumer + manual ack/nack**，语义定义为 **at-least-once**。

- worker 异常退出时，未 ack 消息会由 broker 重新投递（可能重复，需幂等）
- handler 失败时：优先路由 retry，超过上限进入 dead
- session pool 并发打满时：消息直接 `nack(requeue=true)` 回队列，不消耗 attempt
- 失败处理为 fail-fast：仅在 worker/session 明确失败（异常/非零退出/超时）时推进 `failed/retry/dead`
- scheduler 不做自动恢复/自动纠偏；状态异常只记录 `anomaly` 日志，等待显式错误或人工处理
- 系统会记录 `delivery_semantics` 日志用于复盘
- 可通过 `DELIVERY_SEMANTICS` / `RMQ_ACK_MODE` 配置查看或覆盖，默认强制对齐 at-least-once

## 基础告警规则

Monitor 已内置最小告警规则（日志事件 `alert`，可选 webhook）:

- dead 队列长度 `> 0` 持续 `2` 分钟
- retry rate `> 20%`（5 分钟窗口）
- work 队列持续上涨且 completed 不上涨（3 分钟窗口）

可选 webhook:

- `ALERT_WEBHOOK_URL=https://your-webhook`

死信落盘:

- `DEAD_LETTER_LOG_FILE=.aha-loop/dead-letters.jsonl`

## 详细设计

见 [docs/architecture.md](docs/architecture.md)
