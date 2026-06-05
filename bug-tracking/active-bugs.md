# 当前待处理缺陷

本文件只记录仍需修复、澄清或设计决策的问题。已修复待复测的问题移动到 `pending-verification.md`，已验证和已关闭的问题分别移动到 `verified-*` 与 `archive/closed-*`。

## 汇总

| ID | 严重级别 | 标题 | 状态 | 来源 |
| --- | --- | --- | --- | --- |
| BUG-20260605-001 | P2 | `mas autonomy tick` stdout 返回 claim 快照，completed job 仍显示 `running` | active | AionUI 真实 E2E |
| BUG-20260605-002 | P2 | reflection job 完成后 Experience Graph 的 reflection 节点仍显示 `scheduled` | active | 长期 Goal E2E |
| BUG-20260605-003 | P2 | 长期 Goal 的 `goal_continuation` 会被用户普通 prompt 取消，后续无 `goal_runs` | active | 长期 Goal E2E |
| BUG-20260605-004 | P3 | 全局 autonomy tick 缺少按 runId/jobId 过滤，测试时会处理无关历史 due job | active | AionUI 真实 E2E |
| BUG-20260605-005 | P3 | `user_feedback` 低熵信号声明存在，但 AionUI 用户纠正链路尚未验证能沉淀该信号 | active | 代码检查 + E2E 缺口 |

## BUG-20260605-001：`mas autonomy tick` stdout 返回 claim 快照，completed job 仍显示 `running`

- 严重级别：P2
- 状态：active
- 发现日期：2026-06-05
- 来源：AionUI 真实 E2E、自主性 due job 补测
- 影响范围：CLI 可观测性、自主性调度排查、测试断言

复现步骤：

1. 准备至少一个 due `autonomy_jobs` 记录。
2. 执行 `./bin/mas autonomy tick --limit 20 --dream-limit 20`。
3. 对比 stdout 中 `due.completed[]` 和 SQLite 中同一 job 的最终状态。

期望结果：

- stdout 中已完成 job 的状态应显示最终状态 `completed`。

实际结果：

- stdout 的 `due.completed[]` 内 job 对象来自 claim 时快照，字段仍显示 `status=running`。
- SQLite 中同一 job 已更新为 `completed`。

证据：

- `RTE_AUTONOMY_DREAM_20260605_1425`
- `RTE_LONG_AUTONOMY_SELF_CORRECT_20260605_150051`
- `docs/E2E_TEST_REPORT_2026-06-05.md`

当前判断或修复建议：

- `runDueAutonomyJobs` 返回值应使用更新后的 job 快照，或 CLI 输出中明确区分 `claimed` 与 `final`。

复测要求：

- 构造 due reflection、consolidation、dream job。
- 执行 tick 后断言 stdout 和 DB 最终状态一致。

## BUG-20260605-002：reflection job 完成后 Experience Graph 的 reflection 节点仍显示 `scheduled`

- 严重级别：P2
- 状态：active
- 发现日期：2026-06-05
- 来源：长期 Goal E2E
- 影响范围：Experience Graph 状态一致性、反思可观测性

复现步骤：

1. 运行长期 Goal 任务 `RTE_LONG_AUTONOMY_SELF_CORRECT_20260605_150051`。
2. 将该 run 的 reflection job 置为 due。
3. 执行 `./bin/mas autonomy tick --limit 20 --dream-limit 20`。
4. 查询 `reflection_tasks`、`autonomy_jobs` 和 `experience_nodes.type='reflection'`。

期望结果：

- reflection job 和对应 Experience Graph 节点状态一致，或新增一个到期反思完成节点。

实际结果：

- `reflection_tasks` 和 `autonomy_jobs` 已为 `completed`。
- 原 `experience_nodes.type=reflection` 节点仍为 `scheduled`。

证据：

- Run：`729b5cfa-0791-4bf7-aa1c-d43972193a2c`
- Reflection：`reflection:729b5cfa-0791-4bf7-aa1c-d43972193a2c`
- `docs/E2E_TEST_REPORT_2026-06-05.md`

当前判断或修复建议：

- `runDueAutonomyJobs` 处理 reflection job 后同步更新对应 `experience_nodes` 状态，或显式写入一条 `reflection completed` 经验节点并把旧节点视为计划节点。

复测要求：

- tick 后同时断言 job、reflection task 和 Experience Graph 中的反思状态。

## BUG-20260605-003：长期 Goal 的 `goal_continuation` 会被用户普通 prompt 取消，后续无 `goal_runs`

- 严重级别：P2
- 状态：active
- 发现日期：2026-06-05
- 来源：长期 Goal E2E
- 影响范围：长期 Goal 自主推进、跨轮续跑能力

复现步骤：

1. 在 AionUI 新会话中执行 `/goal set <objective>`。
2. 追加若干 `/subgoal add ...`。
3. 发送普通真实执行 prompt。
4. 查询 `autonomy_jobs` 和 `goal_runs`。

期望结果：

- 如果长期 Goal 设计目标包含自主续跑，应保留或重建 `goal_continuation`，并在调度后产生 `goal_runs`。
- 如果当前设计是用户 prompt 抢占续跑，应在文档和 UI 状态中明确说明。

实际结果：

- Goal 创建时的 `goal_continuation` job 被普通用户 prompt 取消。
- `goal_runs` 为空。
- Goal 仍记录 `last_run_id`、`turns_used=1`、`consecutive_failures=1`。

证据：

- Goal：`3b4f3c98-79ec-4db1-8f44-64b8693cb28d`
- Run：`729b5cfa-0791-4bf7-aa1c-d43972193a2c`
- `goal_continuation` payload 中 `reason=user_prompt_preempts_goal_continuation`

当前判断或修复建议：

- 需要产品/架构确认：这是预期的“用户 prompt 抢占后台续跑”，还是长期自主性实现缺口。
- 若目标是长期自主推进，应在 run 收口后基于 GoalJudge 重新调度 continuation。

复测要求：

- 创建 Goal 后发送普通 prompt，确认是否会按设计产生下一次 continuation 或明确取消原因。

## BUG-20260605-004：全局 autonomy tick 缺少按 runId/jobId 过滤，测试时会处理无关历史 due job

- 严重级别：P3
- 状态：active
- 发现日期：2026-06-05
- 来源：AionUI 真实 E2E、长期 Goal E2E
- 影响范围：真实环境测试隔离、运维安全、缺陷定位

复现步骤：

1. 在真实 MAS_HOME 中让多个历史 job 到期。
2. 为某个目标 run 推进 due job。
3. 执行 `./bin/mas autonomy tick --limit 20 --dream-limit 20`。

期望结果：

- 测试或诊断时可以按 runId/jobId 限定 tick 范围，避免处理无关历史 job。

实际结果：

- tick 是全局 due 扫描。
- 本轮长期 Goal 补测中，除目标 run 的 3 个 job 外，还处理了 2 个旧 due consolidation job。

证据：

- `RTE_LONG_AUTONOMY_SELF_CORRECT_20260605_150051` tick 输出 `due.processed=5`，目标 run 只占 3 个 job。

当前判断或修复建议：

- 为 CLI 增加 `--run-id` 或 `--job-id` 过滤。
- E2E 默认使用隔离 `MAS_HOME`。

复测要求：

- 构造多个 due job，使用过滤参数只处理目标 run/job。

## BUG-20260605-005：`user_feedback` 低熵信号声明存在，但 AionUI 用户纠正链路尚未验证能沉淀该信号

- 严重级别：P3
- 状态：active
- 发现日期：2026-06-05
- 来源：代码检查 + E2E 缺口
- 影响范围：用户纠错记忆、自主性学习信号完整性

复现步骤：

1. 在 AionUI 中让 MAS 产生一个可纠正错误。
2. 用户发送明确纠正反馈。
3. 查询 `low_entropy_signals` 是否出现 `type=user_feedback`。

期望结果：

- 用户纠正被沉淀为 goal/run scoped `user_feedback` 低熵信号，并进入 EntropyLedger。

实际结果：

- 目前只确认 `LowEntropySignalType` 声明包含 `user_feedback`。
- 当前 run 收口逻辑主要从 verification、approval、audit、diff、critique 收集信号，尚未完成真实 AionUI 用户纠正沉淀验证。

证据：

- `src/types.ts` 声明 `user_feedback`。
- `src/core/entropy.ts` 当前信号收集路径。
- `docs/E2E_TEST_REPORT_2026-06-05.md` 未覆盖项。

当前判断或修复建议：

- 补一条 AionUI 用户纠正 E2E。
- 若复现确认缺失，应新增消息级用户反馈提取并写入 `low_entropy_signals`。

复测要求：

- 用户纠正后能查询到 `user_feedback` signal，且 ledger 的 `signalIds` 包含该 signal。
