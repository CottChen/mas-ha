# 待复测缺陷

本文件记录已有修复或处理结论、但尚未独立复测的问题。复测通过后移动到对应 `verified-*.md`，复测失败则移回 `active-bugs.md` 并补充失败证据。

## BUG-20260605-001：`mas autonomy tick` stdout 返回 claim 快照，completed job 仍显示 `running`

- 严重级别：P2
- 状态：pending-verification
- 修复来源：本地修复
- 修复摘要：`runDueAutonomyJobs` 和兼容的 `runDueReflections` 在状态更新后重新读取最终快照，再写入 `completed`、`cancelled`、`blocked` 返回数组；`autonomy tick` stdout 不再返回 claim 时的 `running` 快照。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：构造 due reflection、consolidation、dream 和 goal_continuation job，执行 `mas autonomy tick --limit 20 --dream-limit 20`，对比 stdout 与 SQLite 最终状态。
- 通过标准：stdout 中 `due.completed[]` 的目标 job 状态为 `completed`，且与 `autonomy_jobs` 最终状态一致。
- 复测人：
- 复测日期：
- 复测结果：本地 `npm run e2e:smoke` 已覆盖目标断言，仍待独立复测。

## BUG-20260605-002：reflection job 完成后 Experience Graph 的 reflection 节点仍显示 `scheduled`

- 严重级别：P2
- 状态：pending-verification
- 修复来源：本地修复
- 修复摘要：新增 `MasStore.updateExperienceNode`，在 due reflection task/job 完成后同步更新对应 `experience_nodes` 中同 `nodeId` 的计划型 reflection 节点状态，并保留原 payload 后叠加执行决策。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：为目标 run 构造 scheduled reflection Experience Node 和 due reflection autonomy job，执行 `mas autonomy tick --run-id <runId>` 后查询 `reflection_tasks`、`autonomy_jobs` 和 `experience_nodes`。
- 通过标准：job、兼容 reflection task 和对应 Experience Graph reflection 节点均为 `completed`。
- 复测人：
- 复测日期：
- 复测结果：本地 `npm run e2e:smoke` 已覆盖目标断言，仍待独立复测。

## BUG-20260605-004：全局 autonomy tick 缺少按 runId/jobId 过滤，测试时会处理无关历史 due job

- 严重级别：P3
- 状态：pending-verification
- 修复来源：本地修复
- 修复摘要：`claimDueAutonomyJobs` 支持 `sourceRunId` 和 `jobId` 过滤；`AutonomyLoop.runDueAutonomyJobs`、`ReflectionScheduler` 和 CLI `mas autonomy tick` 暴露 `--run-id`、`--job-id` 过滤参数。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：构造多个 due job，其中至少一个属于目标 run、一个属于无关 run；执行 `mas autonomy tick --run-id <runId>`。
- 通过标准：只处理目标 run 的 due job，无关 run 的 due job 保持 `scheduled`；使用 `--job-id <jobId>` 时只 claim 指定 job。
- 复测人：
- 复测日期：
- 复测结果：本地 `npm run e2e:smoke` 已覆盖 CLI `--run-id` 过滤和核心 `jobId` 过滤，CLI `--job-id` 仍待独立复测。

## BUG-20260609-001：HA 终验 typed tool 被拒绝且解析错误误报为 Superego

- 严重级别：P1
- 状态：pending-verification
- 修复来源：AionUI 真实会话 `custom-temp-1780992492653`
- 修复摘要：`ha_final_review` 加入内部结构化工具集合，避免在 `deny-writes` 下被当作普通执行工具拒绝；`parseCritique` 支持调用方传入来源，HA 终验解析失败时不再误报为 `Superego 未输出可解析 JSON`。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：在 `ha-ego-superego` 模式运行一次会触发 HA 终验的任务，确认 HA 能成功提交 `ha_final_review` typed tool；构造 HA 终验非 JSON 输出，确认错误消息为 `HA 终验 未输出可解析 JSON`。
- 通过标准：HA 终验工具调用不被权限层拒绝；终验失败时错误归因准确；AionUI 不再显示 `HA 终验结构化输出解析失败且自修复失败：Superego 未输出可解析 JSON`。
- 复测人：
- 复测日期：
- 复测结果：本地 `npm run typecheck` 和 `npm.cmd run e2e:smoke` 已通过；仍待真实 AionUI 会话独立复测。

## 记录模板

```md
## BUG-YYYYMMDD-NNN：标题

- 严重级别：
- 状态：pending-verification
- 修复来源：
- 修复摘要：
- 待复测版本或提交：
- 复测步骤：
- 通过标准：
- 复测人：
- 复测日期：
- 复测结果：
```
