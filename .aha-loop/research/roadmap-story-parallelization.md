# Research Report: Roadmap Story Parallelization

**Date:** 2026-02-19
**Status:** Complete

## Research Topics

1. 是否可以在同一 roadmap 内并行执行多个 story
2. 当前 MQ 实现中并行受限点是什么
3. 如何在不破坏依赖顺序的前提下开启并行

## Findings

### Topic 1: Roadmap 内 story 并行可行性

**结论:** 可行，前提是依赖图允许。

- Story 无依赖（或依赖已完成）即可并行分发。
- 同一 PRD 内多个独立 story 可并行。
- 跨 PRD 需要遵守 `dependsOn`；依赖 PRD 完成后再激活下游 PRD。

### Topic 2: 当前实现受限点

**发现:** 之前默认 `rmqPrefetch=1`，导致 broker 一次只投递 1 条未 ack 消息，系统表现接近串行。

### Topic 3: 改造策略

**已落地策略:**

1. `RMQ_PREFETCH` 默认改为自动跟随 `MAX_CONCURRENCY`（`0 => auto`）。
2. 解析 roadmap 的 `prds` 与 `milestones[].prds[]`，统一为 PRD 列表。
3. 读取 PRD 级 `dependsOn/dependencies`，并在 scheduler 中自动激活依赖满足的 PRD。
4. 读取 Story 级 `dependencies/dependsOn`（含 PRD 引用），仅在依赖满足时分发。

## Recommendation

- 将 roadmap 设计为 DAG：
  - PRD 用 `dependsOn` 表达粗粒度先后。
  - Story 用 `dependencies` 表达细粒度先后。
- 以 `MAX_CONCURRENCY` 作为主并行阀值，通常与 CPU/IO 能力对齐，再按负载微调 `RMQ_PREFETCH`。
