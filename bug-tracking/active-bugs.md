# 当前待处理缺陷

本文件只记录仍需修复、澄清或设计决策的问题。已修复待复测的问题移动到 `pending-verification.md`，已验证和已关闭的问题分别移动到 `verified-*` 与 `archive/closed-*`。

## 汇总

| ID | 严重级别 | 标题 | 状态 | 来源 |
| --- | --- | --- | --- | --- |
| BUG-20260605-003 | P2 | 长期 Goal 的 `goal_continuation` 会被用户普通 prompt 取消，后续无 `goal_runs` | active | 长期 Goal E2E |
| BUG-20260605-005 | P3 | `user_feedback` 低熵信号声明存在，但 AionUI 用户纠正链路尚未验证能沉淀该信号 | active | 代码检查 + E2E 缺口 |
| BUG-20260605-006 | P3 | AionUI 思考区持续追加大量重复感 thought，MAS 缺少 thought 流去重、分段和诊断信息 | active | AionUI 真实会话排查 |

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

## BUG-20260605-006：AionUI 思考区持续追加大量重复感 thought，MAS 缺少 thought 流去重、分段和诊断信息

- 严重级别：P3
- 状态：active
- 发现日期：2026-06-05
- 来源：AionUI 真实会话排查
- 影响范围：AionUI 可读性、长任务性能、thought 流排查

复现或观察入口：

1. 打开 AionUI workspace `custom-temp-1780650717388`。
2. 观察任务运行期间的折叠“思考中”区域。
3. 查询 MAS 数据库 `C:/Users/Administrator/.mas/orchestration/data/mas.sqlite` 中 run `7acaa17e-0588-473d-a84e-76978ca13570` 的事件。

期望结果：

- AionUI 思考区应能按角色、轮次或阶段清晰展示，或对高频 thought chunk 做限流、折叠和去重。
- MAS 应保留足够的非敏感诊断信息，例如 thought chunk 计数、长度、hash、role、iteration、contentIndex 和 block 边界，便于判断是模型重复、SDK 重放还是 UI 追加策略问题。

实际结果：

- 目标 run 仍处于 `running`，但 thought 流已产生大量事件。
- 该 run 已记录约 4985 条 `thinking_delta`，其中 Superego 第 1 轮约 3396 条，Ego 第 2 轮约 1284 条。
- MAS 当前把 Pi SDK 的 `thinking_delta.delta` 原样转成 ACP `agent_thought_chunk`，没有角色前缀、分块、限流或去重。
- MAS 对 `message_update` 的 raw 内容返回 `undefined`，导致事后无法确认具体 thought 文本是否完全重复。
- AionUI 普通日志和 Local/Session Storage 未保留该会话的 ACP thought 内容，无法从 UI 侧复原每个 chunk。

证据：

- Workspace：`custom-temp-1780650717388`
- Session：`mas-b1385ca4-813e-4237-b97e-711627c088e7`
- Run：`7acaa17e-0588-473d-a84e-76978ca13570`
- 代码路径：`src/pi/pi-sdk.ts` 将 `thinking_delta` 直接调用 `sink.thought`；`src/acp/acp-sink.ts` 将其发送为 `agent_thought_chunk`。
- 诊断盲点：`src/pi/pi-sdk.ts` 的 `rawPiEventForStorage` 对 `message_update` 返回 `undefined`。

当前判断或修复建议：

- 优先实现 thought 流限流和展示分段：按 role/iteration 增加阶段前缀，并对连续重复片段或超长 thought 做折叠。
- 增加非敏感 thought telemetry：只记录长度、hash、contentIndex、block 序号和是否疑似重复，不落库原始思考文本。
- 如需保持 AionUI 思考区轻量，可默认只发送阶段提示，不逐 token 转发全部 `thinking_delta`。

复测要求：

- 构造长任务或使用真实 AionUI 会话运行 MAS。
- 断言 AionUI 思考区不会无限追加重复感短句，且 MAS 事件中能看到 thought 计数、hash 和折叠统计。
