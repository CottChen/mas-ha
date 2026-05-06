# 通信与事件追溯

本文记录 `feature/comm-versioning` 当前实现的内部事件和审计追溯规则。

## 设计边界

MAS 不替代 Pi SDK 的事件模型。Pi SDK 仍然是 agent 运行时事件源，MAS 只在外层做持久化、查询和 HA / Ego / Superego 语义补充。

当前事件分两类：

- `source = "pi"`：来自 Pi SDK `session.subscribe()` 或 extension hook 的原始运行时事件。
- `source = "mas"`：MAS 自己生成的语义事件，例如 run 生命周期、HA 决策、Ego 迭代、Superego 评审和审批决策。

## SQLite 表

`events` 是 append-only 事件表，字段包括：

- `sequence`：数据库内递增顺序。
- `event_id`：事件 UUID。
- `run_id`、`session_id`：关联 MAS run 和 ACP session。
- `role`、`iteration`：关联 HA / Ego / Superego 角色和迭代轮次。
- `source`、`type`、`actor`：事件来源、类型和发起者。
- `tool_call_id`：关联 Pi 工具调用。
- `parent_event_id`、`correlation_id`：预留给后续因果链和跨事件关联。
- `payload_json`：稳定摘要或 MAS 语义载荷。
- `raw_json`：必要时保存原始输入或 Pi 原始事件。

## 当前记录的事件

MAS 语义事件：

- `mas.run.started`
- `mas.run.completed`
- `mas.run.needs_attention`
- `mas.run.failed`
- `mas.agent_session.created`
- `mas.agent_prompt.started`
- `mas.agent_prompt.completed`
- `mas.agent_session.disposed`
- `mas.ha.decision.created`
- `mas.ego.iteration.completed`
- `mas.superego.review.completed`
- `mas.approval.decided`

Pi 运行时事件：

- `pi.agent_start`
- `pi.agent_end`
- `pi.turn_start`
- `pi.turn_end`
- `pi.message_start`
- `pi.message_update`
- `pi.message_end`
- `pi.tool_call`
- `pi.tool_execution_start`
- `pi.tool_execution_update`
- `pi.tool_result`
- `pi.tool_execution_end`

## raw 保存策略

为避免 token 级流式事件让 SQLite 快速膨胀，以下事件只保存摘要到 `payload_json`，不保存 `raw_json`：

- `pi.message_update`
- `pi.message_start`
- `pi.message_end`
- `pi.agent_end`
- `pi.turn_end`

工具执行、工具审批和工具结果事件仍保留 raw，用于审计命令、文件路径、工具输入和执行结果。

## 已知限制

- 当前还没有 `mas logs` / `mas replay` CLI，事件只能通过 SQLite 查询。
- 当前还没有 artifact version 表，下载文件、代码变更和验证结果尚未形成不可变工件版本链。
- 旧数据库中已经写入的高频 raw 事件不会自动压缩；raw 精简策略只影响后续新 run。
