# 多项目运行时隔离分阶段落地方案（不做大规模内核改造）

## 1. 目标与边界
- 目标：在现有单进程运行时基础上，逐步把“project 作用域”升级为“可验证的运行时隔离”。
- 约束：本轮不做大规模重构，不一次性拆成多套独立内核。
- 判定标准：隔离必须覆盖队列路由、调度配额、会话池并发、状态命名空间、迁移与回滚、可观测性。

## 2. 现状审计：已做的 project 作用域
以下能力已存在，属于“数据/控制面作用域”：

1. 加载与实体写入携带 `projectId`
- `src/pipeline/prd-loader.js:20` 支持从入参/文件解析默认 `projectId`。
- `src/pipeline/prd-loader.js:61`、`src/pipeline/prd-loader.js:90` 将 `projectId` 写入 PRD/Story。
- `src/pipeline/prd-loader.js:487` 对跨项目同 ID 冲突做拒绝。

2. Store 查询支持 project 过滤
- `src/store/store.js:89`、`src/store/store.js:120`、`src/store/store.js:178`、`src/store/store.js:205` 支持按 `projectId` 过滤 PRD/Story/Run/Worktree。

3. 调度与执行链路透传 `projectId`
- `src/scheduler/scheduler.js:452`、`src/scheduler/scheduler.js:523` 分发 run/task 时携带 `projectId`。
- `src/worker/worker.js:210` 计算 `effectiveProjectId`，`src/worker/worker.js:272` 写入 session。
- `src/worker/worker.js:378` 校验 worktree 中 `projectId` 与任务一致性。

4. 监控与 API 查询支持 project 视图
- `src/monitor/monitor.js:178` 构建 project 范围快照。
- `src/monitor/monitor.js:1913`、`src/monitor/monitor.js:1959`、`src/monitor/monitor.js:1983` 支持 `projectId` 查询参数。

5. 基础测试已覆盖 project 透传/过滤
- `src/pipeline/__tests__/prd-loader-project-id.test.js`
- `src/store/__tests__/store-project-id-filter.test.js`
- `src/scheduler/__tests__/scheduler-project-id-dispatch.test.js`
- `src/worker/__tests__/worker-project-id-session.test.js`
- `src/monitor/__tests__/monitor-project-scope-and-control.test.js`

## 3. 关键差距：尚未实现“真正运行时隔离”
当前瓶颈是“共享运行时资源”：

1. 队列仍是全局三队列
- `src/config.js:22`~`src/config.js:24` 只有全局 `work/retry/dead` 队列名。
- `src/queue/queue.js:289` 固定发往 `config.workQueue`。
- `src/queue/queue.js:396` 固定消费 `config.workQueue`。

2. 调度配额是全局，不按项目分区
- `src/scheduler/scheduler.js:171`~`src/scheduler/scheduler.js:179` 只按全局 `maxConcurrency` 控制可分发数。

3. sessionPool 是全局池，不按项目限流
- `src/worker/session-pool.js:293` 仅一个 `_active` Map。
- `src/worker/worker.js:252` 仅用 `sessionPool.size` 对全局并发背压。

4. 状态存储是单文件单命名空间
- `src/config.js:56` 全局 `stateFile=.aha-loop/state.json`。
- `src/store/store.js:68` 的 reset 对执行态是全局清空。

5. 项目控制入口存在“逻辑作用域”，但调控对象仍是全局运行时
- `src/monitor/monitor.js:1487` 为项目入口；但调用 `RuntimeControl` 全局 pause/resume/cancel/restart。
- `src/control/runtime-control.js:23`、`src/control/runtime-control.js:35` 操作全局 scheduler。

结论：目前是“project 标记 + 查询过滤 + 局部校验”，还不是“资源隔离 + 故障域隔离”。

## 4. 分阶段实施方案

## Phase 1（软隔离，低风险，先落地）
### 4.1 队列策略（路由键优先，不拆物理队列）
- 保留当前三队列（work/retry/dead）不变。
- 新增 exchange（建议 direct/topic），发布时附加 routing key：`project.<projectId|default>`。
- 消费端先继续从现有 work 队列消费；同时把 routing key 与 `projectId` 写入消息头/日志，建立后续分片基础。

### 4.2 调度分区
- 在 `Scheduler.poll()` 中引入“按项目轮转”的 dispatch 策略：
- 从 `pending` 按 `projectId` 分桶，按轮转/最小在运行数优先分配 `availableSlots`。
- 默认公平策略：单项目不得连续占满全部空槽（避免饥饿）。

### 4.3 sessionPool 隔离
- 保留单 pool，实现“配额视图”：
- 新增 `activeByProject` 计数（可由 `_active` 派生，避免双写风险）。
- 配置 `maxConcurrencyPerProject`（默认 `ceil(global/projectCount)` 或静态默认值）。
- `Worker.handleTask` 在全局阈值前增加项目阈值检查，超限时 `requeue=true`。

### 4.4 状态命名空间
- 保持单 `state.json`，新增命名空间字段：
- `run.namespace = projectId || "_default"`，`session.namespace` 同步。
- 新增索引快照（可选）`projectRuntimeStats`，便于 O(1) 查看各项目运行占用。

### 4.5 迁移策略
- 零停机、向后兼容：
- 旧消息无 routing key 时默认 `_default`。
- 旧 state 无 namespace 时读时回填（不阻塞启动）。
- 先灰度开启 feature flag：`RUNTIME_ISOLATION_PHASE1=true`。

### 4.6 回滚策略
- 开关回退到旧行为：关闭 Phase1 flag。
- 保留旧字段语义不变，回滚不需要数据回写。
- 若轮转调度异常，立即退回“原 pending 顺序 + 全局并发”策略。

### 4.7 可观测性指标
- 新增指标：
- `aha_loop_project_active_sessions{project}`
- `aha_loop_project_queued_stories{project}`
- `aha_loop_scheduler_dispatch_fairness_ratio{project}`
- `aha_loop_backpressure_requeue_total{project,reason}`

### 4.8 Phase 1 验收清单
- [ ] 同时有 2+ 项目时，任一项目不会长期独占全部并发槽。
- [ ] `sessionPool` 达到项目阈值后只回退该项目任务，不阻塞其他项目任务启动。
- [ ] 指标可按项目看到 active/queued/requeue 变化。
- [ ] 关闭 Phase1 flag 后，行为与当前主干一致。

## Phase 2（中隔离，队列分片 + 调度/执行一致分区）
### 4.9 队列策略（分片）
- 引入固定分片数 `N`（如 8 或 16），按 `hash(projectId) % N` 路由：
- Work：`aha_loop_jobs_s{n}`
- Retry：`aha_loop_jobs_retry_s{n}`
- Dead：`aha_loop_jobs_dlq_s{n}`
- 保留老队列作为兼容通道，逐步 drain。

### 4.10 调度分区
- 调度器按项目映射到分片，分发时直接投递到目标分片。
- 分片级并发上限 + 项目级并发上限双重控制（防止热点项目冲垮单分片）。

### 4.11 sessionPool 隔离
- 维护 `activeByShard` + `activeByProject`。
- Worker 消费时携带 shard 上下文；拒绝跨 shard 的错路由任务（入 dead 或专用 quarantine 队列）。

### 4.12 状态命名空间
- state 结构升级为项目子树（逻辑）：
- `projects[projectId].{prds,stories,runs,sessions,worktrees}`
- 对外 API 保持兼容，旧查询接口通过聚合适配器返回。

### 4.13 迁移策略
- 双写期：
- 写新结构，同时保留旧扁平结构（只读兼容）。
- 消费端先支持老队列+新分片双读，确认稳定后停止老队列写入。

### 4.14 回滚策略
- 一键切回老队列投递（保留老绑定与消费者）。
- 读取路径优先旧结构，新结构仅做旁路。
- 回滚期间禁止自动清理新分片队列，避免消息丢失。

### 4.15 可观测性指标
- `aha_loop_queue_messages{shard,queue}`
- `aha_loop_project_shard_mapping{project,shard}`
- `aha_loop_shard_dispatch_latency_ms{shard}`
- `aha_loop_shard_rebalance_total`

### 4.16 Phase 2 验收清单
- [ ] 任一项目的任务仅进入其映射分片（抽样验证 message headers + queue）。
- [ ] 热点项目负载上升时，其它项目 p95 启动延迟不明显恶化（阈值可设 <20%）。
- [ ] 新旧队列双读双写期间无丢任务、无重复执行异常增长。
- [ ] 回滚演练可在目标时限内恢复到老通道（建议 <10 分钟）。

## Phase 3（强隔离，运行时故障域隔离）
### 4.17 队列策略（项目级 lane）
- 对关键项目启用独立 lane（独立 work/retry/dead 前缀），普通项目继续走分片池。
- lane 升级为可配置策略（SLA 高项目独享，低 SLA 项目共享）。

### 4.18 调度分区
- scheduler/worker 进程按 lane 部署（至少逻辑上独立实例）。
- 每个 lane 独立暂停、恢复、限流、故障熔断，不影响其它 lane。

### 4.19 sessionPool 隔离
- sessionPool 按 lane 独立（进程内多池或多进程单池）。
- kill/restart/revive 操作限定在 lane 边界内。

### 4.20 状态命名空间
- 物理拆分状态：
- `.aha-loop/state/<lane>/state.json` 或独立存储后端分库分表。
- 提供聚合视图用于全局看板，不再依赖单文件全量读写。

### 4.21 迁移策略
- 按项目白名单逐批迁移到独立 lane（canary -> 扩容）。
- 每批迁移必须通过“消息一致性 + 延迟 + 错误率”门禁后再扩大范围。

### 4.22 回滚策略
- 项目级回滚：将单个项目从独立 lane 迁回共享分片池。
- 保留跨 lane 消息桥接窗口，确保在途消息可消费完毕。

### 4.23 可观测性指标
- `aha_loop_lane_active_sessions{lane}`
- `aha_loop_lane_queue_lag{lane,queue}`
- `aha_loop_lane_error_rate{lane}`
- `aha_loop_cross_lane_fallback_total{project,from,to}`

### 4.24 Phase 3 验收清单
- [ ] 任一 lane 故障不会导致其他 lane 调度停摆。
- [ ] 支持项目级 pause/resume/restart，不影响其他项目执行。
- [ ] 项目迁入/迁出 lane 的回滚演练可重复成功。
- [ ] 全局看板可同时展示 lane 级与 project 级指标。

## 5. 迁移总策略（跨阶段）
1. 先可观测、后限流、再路由、最后物理隔离。
2. 每阶段引入 feature flag，默认关闭，灰度启用。
3. 每阶段必须做“并发压测 + 故障注入 + 回滚演练”三件套后再进入下一阶段。

## 6. 回滚总原则
1. 回滚路径必须比升级路径更短（开关优先，结构回退次之）。
2. 队列/状态升级均保留兼容读取窗口，不做一次性切断。
3. 回滚不清理新结构数据，先保留证据，待稳定后异步清理。

## 7. 本轮建议落地范围（建议执行）
- 实施 Phase 1 全量。
- Phase 2 先做技术预埋（routing key + shard 计算函数 + 指标埋点），不开启流量切换。
- Phase 3 仅输出设计与演练计划，不进入开发。
