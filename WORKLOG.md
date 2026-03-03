# 任务：P0/P1/P2 生产可用性修复
创建时间：2025-01-01T00:00:00Z
评估结果：理解深度高 / 变更范围系统 / 风险等级高

## 执行计划
1. [阶段 1] - P0：日志结构化、队列指标、消费语义确认
2. [阶段 2] - P1：延迟/重试/死信指标、健康增强
3. [阶段 3] - P2：AMQP 消费迁移与可观测后端预留

## 当前状态
正在执行：阶段 3
进度：100%

## 已完成
- [x] 初始化工作记录
- [x] 三队列统一 health 指标接口（work/retry/dead message+consumer）
- [x] 关键生命周期事件统一 JSON 日志字段（dispatch/start/success/fail/retry/dead/merge）
- [x] 明确并固化 at-least-once 消费语义（manual_ack + worker 异常重投）
- [x] Monitor 最小告警规则（dead/retry rate/work-stuck）+ webhook 输出
- [x] RabbitMQ 消费从 HTTP polling 迁移为 amqplib manual-ack（默认 at-least-once）
- [x] health 中增加 runtimeConsumers，修复 consumerCount 语义误解
- [x] dead 事件落盘 `.aha-loop/dead-letters.jsonl`，补齐死信可追踪链路
- [x] 端到端延迟指标（dispatch/start/finish）与 5/15m avg+p95 聚合
- [x] 新增监控 API：stories / alerts / dead-letters / boot / latency / prometheus
- [x] 并发背压语义修正：并发打满时 broker requeue，不消耗 attempt

## 下一步行动
- 进入联调：前端 5 页面接入 monitor API

## 风险点
- 消费语义修改可能影响现有行为：需要明确策略
- 引入 AMQP 依赖可能影响部署
