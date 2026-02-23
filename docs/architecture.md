# Aha-Loop MQ 执行引擎 — 架构设计

## 唯一入口: project-vision

用户只需提供一个 `project.vision.md` 文件，系统自动完成全部流程：

```
用户输入                     系统自动完成
─────────                   ──────────────────────────────────────────
project.vision.md    →      Pipeline: vision → architect → roadmap → PRD
                     →      Scheduler: 拆解 Story → 分配 Worktree → 发 RabbitMQ
                     →      Worker: 消费任务 → spawn AI agent → 执行 → 上报
                     →      Scheduler: 推进阶段 → 合并 Worktree → 完成
```

**启动方式:**

```bash
npx aha-loop --vision ./project.vision.md --workspace /path/to/project
```

---

## 设计原则

1. **Vision 驱动** — 用户只提供 vision，系统自动编排全部后续流程（architect → roadmap → PRD → execute）
2. **调度与执行分离** — Scheduler 只做决策（读 Store、发 MQ），Worker 只做执行（消费 MQ、spawn 进程）
3. **状态机驱动** — Pipeline / PRD / Story 生命周期由有限状态机管理，所有转换显式定义
4. **Worktree 隔离** — 每个活跃 Story 独占一个 git worktree，天然支持并行，完成后合并
5. **RabbitMQ 作为唯一调度通道** — Scheduler→Worker 的所有通信走 RabbitMQ，持久化、可重试、可扩展
6. **单进程起步，可拆分** — MVP 阶段 Scheduler+Worker 在同一进程，未来可拆为独立服务

---

## 目录结构

```
Aha-Loop-mq-framework/
├── package.json
├── src/
│   ├── index.js                 # 主入口: 解析 CLI → 启动 pipeline/scheduler/worker
│   ├── config.js                # 配置中心 (环境变量 + CLI args)
│   │
│   ├── core/
│   │   ├── state-machine.js     # 通用有限状态机引擎
│   │   ├── event-bus.js         # 进程内事件总线
│   │   └── retry.js             # 指数退避 + 抖动
│   │
│   ├── store/
│   │   ├── store.js             # 统一存储 (PRD / Story / Session / Worktree)
│   │   └── schemas.js           # 状态定义 + 合法转换表
│   │
│   ├── queue/
│   │   └── queue.js             # RabbitMQ 拓扑 + publish / consume
│   │
│   ├── pipeline/                # Vision → PRD 自动化流水线
│   │   ├── pipeline.js          # 流水线编排: vision → architect → roadmap → PRD
│   │   └── prd-loader.js        # 从 roadmap 加载 PRD/Story 到 Store
│   │
│   ├── scheduler/
│   │   └── scheduler.js         # 调度器: poll Store → 检查依赖 → 发 RabbitMQ
│   │
│   ├── worker/
│   │   ├── worker.js            # 消费者: 取任务 → 交给 SessionPool
│   │   └── session-pool.js      # 进程池: spawn / poll / timeout / kill
│   │
│   ├── worktree/
│   │   └── worktree.js          # Git Worktree 管理: ensure / merge / cleanup
│   │
│   └── monitor/
│       └── monitor.js           # 健康报告 + 统计 + 僵尸检测
│
├── templates/
│   └── project.vision.template.md  # Vision 模板 (用户入口)
```

---

## 实体模型

### PRD

```js
{
  id:           "PRD-001",
  status:       "active",        // queued | active | completed | completed_with_errors
  stories:      ["US-001", "US-002", ...],
  workspacePath: "/srv/projects/my-app",
  createdAt, updatedAt, finishedAt
}
```

### Story

```js
{
  id:           "US-007",
  prdId:        "PRD-001",
  phase:        "implement",     // research | explore | plan | implement | review
  status:       "running",       // pending | queued | running | phase_done | merging | completed | failed | dead
  phases:       ["research", "implement", "review"],  // 该 story 需要经历的阶段 (可配置)
  attempt:      1,
  maxAttempts:  3,
  dependencies: ["US-005"],      // 前置依赖 (必须 completed 才能调度)
  worktreeId:   "wt-us007",
  sessionId:    "ses-xxx",       // 当前活跃 session
  tool:         "claude",
  timeoutMs:    600000,
  createdAt, updatedAt, startedAt, finishedAt,
  error:        null
}
```

### Session

```js
{
  id:           "ses-abc123",
  storyId:      "US-007",
  prdId:        "PRD-001",
  phase:        "implement",
  status:       "running",       // running | completed | failed | timeout | killed
  pid:          12345,
  worktreePath: "/srv/projects/my-app/.worktrees/US-007",
  exitCode:     null,
  error:        null,
  attempt:      1,
  createdAt, startedAt, finishedAt, lastHeartbeat
}
```

### Worktree

```js
{
  id:           "wt-us007",
  storyId:      "US-007",
  branch:       "story/US-007",
  path:         "/srv/projects/my-app/.worktrees/US-007",
  status:       "active",        // active | merged | conflict | cleaned
  createdAt, mergedAt, cleanedAt
}
```

---

## 状态转换表

### Story Lifecycle

```
pending     → queued       : Scheduler.dispatch()
queued      → running      : Worker.consume()
running     → phase_done   : Session 正常退出 (exit=0)
running     → failed       : Session 异常退出 / 超时
phase_done  → pending      : Scheduler.advancePhase() (还有下一阶段)

---

## 模块接口契约

### 1. StateMachine (`core/state-machine.js`)

通用有限状态机引擎。不含业务逻辑，只做状态转换验证。

```js
class StateMachine {
  constructor(name, { states, transitions, initial })

  // 验证转换是否合法
  canTransition(currentState, targetState) → boolean

  // 执行转换 (不合法则 throw)
  transition(entity, targetState, metadata) → entity

  // 获取某状态的所有合法出口
  validTransitions(currentState) → string[]
}

// 使用示例:
const storyMachine = new StateMachine('story', {
  states: ['pending','queued','running','phase_done','merging','completed','failed','dead'],
  transitions: [
    { from: 'pending',    to: 'queued',     action: 'dispatch' },
    { from: 'queued',     to: 'running',    action: 'consume' },
    { from: 'running',    to: 'phase_done', action: 'succeed' },
    { from: 'running',    to: 'failed',     action: 'fail' },
    { from: 'phase_done', to: 'pending',    action: 'advance_phase' },
    { from: 'phase_done', to: 'merging',    action: 'start_merge' },
    { from: 'merging',    to: 'completed',  action: 'merge_ok' },
    { from: 'merging',    to: 'failed',     action: 'merge_conflict' },
    { from: 'failed',     to: 'pending',    action: 'retry' },
    { from: 'failed',     to: 'dead',       action: 'give_up' },
  ],
  initial: 'pending'
});
```

### 2. Store (`store/store.js`)

统一存储，所有状态变更的唯一入口。通过 StateMachine 校验每次状态转换。

```js
class Store {
  constructor(stateFile, stateMachines, eventBus)

  // PRD
  loadPrd(prdData)                    // 从 prd.json 导入
  listPrds(filter?)                   → PRD[]
  getPrd(id)                          → PRD | null
  setPrd(prd)                         → PRD

  // Story
  listStories(filter?)                → Story[]
  getStory(id)                        → Story | null
  transitionStory(id, targetStatus, patch?)  → Story  // 经过状态机校验

  // Session
  listSessions(filter?)               → Session[]
  getSession(id)                      → Session | null
  setSession(session)                 → Session

  // Worktree
  listWorktrees(filter?)              → Worktree[]
  getWorktree(id)                     → Worktree | null
  setWorktree(wt)                     → Worktree

  // 持久化
  flushNow()                          → Promise<void>
}
```

### 3. Queue (`queue/queue.js`)

RabbitMQ 客户端。三队列拓扑 + amqplib 消费。

```js
function createQueueClient(config, eventBus, logger) → {
  connect()                            → Promise<void>

  // Scheduler 调用: 发布任务到 work 队列
  publishTask(taskMessage)             → Promise<void>

  // Worker 调用: 消费 work 队列 (manual ack, at-least-once)
  consumeTasks(handler)                → Promise<void>
  //   handler: async (task) => void
  //   成功: ack
  //   失败 + 可重试: 路由到 retry 队列
  //   失败 + 不可重试: 路由到 dead 队列

  // 可选: 消费 dead 队列
  consumeDeadLetters(handler)          → Promise<void>

  healthCheck()                        → Promise<{
    ok,
    semantics,
    ackMode,
    queues: {
      work:  { messageCount, consumerCount },
      retry: { messageCount, consumerCount },
      dead:  { messageCount, consumerCount }
    },
    runtimeConsumers: { work, dead },
    transport
  }>
  close()                              → Promise<void>
}
```

### 4. Scheduler (`scheduler/scheduler.js`)

调度器。定期轮询 Store，决定哪些 Story 可以执行，分发到 MQ。

**这是整个系统的大脑。**

```js
class Scheduler {
  constructor(config, store, queue, worktreeManager, eventBus, logger)

  start()                              // 启动轮询循环
  stop()                               // 停止

  // --- 核心调度循环 (每 N 秒执行) ---
  async poll() {
    // 1. 处理 phase_done: 推进到下一阶段或合并
    // 2. 处理 failed: 决定重试还是判死
    // 3. 处理 pending: 检查依赖 → 创建 worktree → 发 MQ
    // 4. 检查 PRD 完成度
  }

  // --- 内部逻辑 ---
  dependenciesMet(story, allStories)   → boolean
  canSchedule()                        → boolean   // 并发上限检查
  nextPhase(story)                     → string | null
  dispatch(story)                      → Promise<void>
  startMerge(story)                    → Promise<void>
}
```

**调度算法伪代码:**

```
poll():
  stories = store.listStories()

  // Step 1: 推进已完成阶段
  for story in stories where status = 'phase_done':
    next = nextPhase(story)
    if next:
      story.phase = next
      store.transitionStory(story.id, 'pending')
    else:
      store.transitionStory(story.id, 'merging')
      await worktreeManager.merge(story.worktreeId)
      store.transitionStory(story.id, 'completed')
      worktreeManager.cleanup(story.worktreeId)

  // Step 2: 处理失败
  for story in stories where status = 'failed':
    if story.attempt < story.maxAttempts:
      story.attempt++
      store.transitionStory(story.id, 'pending')
    else:
      store.transitionStory(story.id, 'dead')

  // Step 3: 分发可执行任务
  for story in stories where status = 'pending':
    if not dependenciesMet(story, stories): continue
    if not canSchedule(): break

    wt = await worktreeManager.ensure(story)
    store.transitionStory(story.id, 'queued', { worktreeId: wt.id })
    await queue.publishTask({
      storyId: story.id,
      prdId:   story.prdId,
      phase:   story.phase,
      worktreePath: wt.path,
      tool:    story.tool,
      prompt:  buildPrompt(story),
      attempt: story.attempt,
      timeoutMs: story.timeoutMs,
    })

  // Step 4: PRD 完成度
  for prd in store.listPrds({ status: 'active' }):
    checkPrdCompletion(prd)
```

### 5. Worker (`worker/worker.js`)

消费者。从 MQ 取任务，交给 SessionPool 执行。**不做调度决策。**

```js
class Worker {
  constructor(config, store, sessionPool, eventBus, logger)

  // 处理单条任务消息
  async handleTask(task) {
    // 1. 幂等检查 (同 storyId 是否已有 running session)
    // 2. 并发检查 (sessionPool.size vs maxConcurrency)
    // 3. 更新 story 状态: queued → running
    // 4. sessionPool.launch(task) → spawn 进程
    // 5. 注册 session 到 store
  }
}

async function startWorker(queue, worker, logger) {
  await queue.consumeTasks(task => worker.handleTask(task));
}
```

### 6. SessionPool (`worker/session-pool.js`)

进程池。管理所有 spawn 出来的 AI agent 进程。

```js
class SessionPool {
  constructor(config, store, eventBus, logger)

  start()                              // 启动轮询循环
  stop()                               // 停止 + 杀死所有进程

  launch(task)                         → Session  // spawn 子进程, 非阻塞
  kill(sessionId)                      → boolean
  getOutput(sessionId)                 → { stdout[], stderr[] }

  get size                             → number   // 当前活跃数

  // --- 内部轮询 (每 3 秒) ---
  _pollAll() {
    for each active session:
      1. process.kill(pid, 0) → 检查存活
      2. age > timeoutMs     → kill + 标记 timeout
      3. 收集 stdout/stderr
  }

  // --- 进程退出回调 ---
  _finalize(sessionId, { exitCode, error }) {
    session.status = exitCode === 0 ? 'completed' : 'failed'
    store.setSession(session)
    // 同时更新 story 状态:
    store.transitionStory(session.storyId,
      exitCode === 0 ? 'phase_done' : 'failed')
    eventBus.fire('session:completed' | 'session:failed')
  }
}
```

### 7. WorktreeManager (`worktree/worktree.js`)

Git worktree 的完整生命周期管理。

```js
class WorktreeManager {
  constructor(config, store, logger)

  // 确保 story 有可用的 worktree (幂等)
  async ensure(story) → Worktree {
    // 1. 检查 store 中是否已有该 story 的 active worktree
    // 2. 如果没有:
    //    git worktree add .worktrees/US-007 -b story/US-007
    // 3. 注册到 store
  }

  // 合并 worktree 回主分支
  async merge(worktreeId) → { ok, conflicts? } {
    // 1. git checkout main
    // 2. git merge story/US-007
    // 3. 如果冲突: 返回 { ok: false, conflicts }
    // 4. 如果成功: 更新 worktree.status = 'merged'
  }

  // 清理 worktree
  async cleanup(worktreeId) {
    // 1. git worktree remove .worktrees/US-007
    // 2. git branch -d story/US-007
    // 3. 更新 worktree.status = 'cleaned'
  }

  // 列出所有 worktree
  list() → Worktree[]
}
```

---

## MQ 拓扑

```
Queue: aha_loop_jobs
  - durable: true
  - x-dead-letter-exchange: ""
  - x-dead-letter-routing-key: aha_loop_jobs_dlq

Queue: aha_loop_jobs_retry
  - durable: true
  - x-message-ttl: 10000 (可配置)
  - x-dead-letter-exchange: ""
  - x-dead-letter-routing-key: aha_loop_jobs    ← TTL 到期后重新投递到 work

Queue: aha_loop_jobs_dlq
  - durable: true                      ← Monitor 记录/告警
```

**消息格式:**

```json
{
  "storyId":      "US-007",
  "prdId":        "PRD-001",
  "phase":        "implement",
  "worktreePath": "/srv/projects/my-app/.worktrees/US-007",
  "workspacePath": "/srv/projects/my-app",
  "tool":         "claude",
  "prompt":       "...",
  "attempt":      1,
  "maxAttempts":  3,
  "timeoutMs":    600000,
  "publishedAt":  "2025-07-14T12:00:00Z"
}
```

---

## 流水线: Vision → 执行

用户唯一入口是 `project.vision.md`。Pipeline 自动串行完成规划阶段，然后交给 Scheduler 并行执行。

### Pipeline 阶段

```
vision.md → [AI: architect] → project.architecture.md
         → [AI: roadmap]   → project.roadmap.json
         → [AI: prd]       → tasks/PRD-001.json, PRD-002.json ...
         → [Store.load]    → Story 实体全部进入 Store (status=pending)
         → [Scheduler]     → 开始并行调度执行
```

### Pipeline 状态机

```
loaded → architecting → planning_roadmap → generating_prds → executing → completed | failed
```

Pipeline 前三步（architect / roadmap / prd）在主进程内串行执行（AI 调用），
`executing` 阶段交给 Scheduler + Worker + RabbitMQ 并行执行。

### 入口

```bash
# 完整自动化: vision → 全部完成
npx aha-loop --vision ./project.vision.md --workspace /path/to/project

# 仅规划 (不执行)
npx aha-loop --vision ./project.vision.md --plan-only

# 从已有 roadmap 恢复执行
npx aha-loop --roadmap ./project.roadmap.json --workspace /path/to/project
```

---

## 实现优先级

| 阶段 | 模块 | 说明 |
|------|------|------|
| **P0** | package.json | 能跑起来 |
| **P0** | config.js | 统一配置 |
| **P0** | state-machine.js | 一切的基石 |
| **P0** | schemas.js | Pipeline/PRD/Story 状态定义 |
| **P0** | store.js | 统一存储 + 状态机校验 |
| **P0** | queue.js | RabbitMQ 三队列拓扑 |
| **P0** | scheduler.js | 核心调度逻辑 |
| **P0** | worker.js + session-pool.js | 执行层 |
| **P0** | worktree.js | git worktree ensure/merge/cleanup |
| **P0** | index.js | 入口编排 |
| **P1** | pipeline.js + prd-loader.js | Vision → PRD 自动化 |
| **P1** | monitor.js | 健康报告 |
| **P2** | DLQ 可视化 | 死信检索与回放 |
| **P2** | HTTP API 扩展 | 管理/查询接口 |
