# MAS 自主性待办

本文记录 MAS 自主性机制的具体待办事项；长期原则见 `AGENTS.md`，设计背景见 `docs/AUTONOMY.md`。

低熵自主性与 Goal 控制面设计见 `docs/GOAL_ENTROPY_CONTROL.md`。核心原则是：MAS 不依赖 Goal 也持续自主改进；Goal 只增加人的可控性。

## 最小闭环

- [ ] 为 `mas autonomy tick` / `mas reflect due` 增加端到端回归测试，覆盖 scheduled -> running -> completed / cancelled。
- [ ] 为 `mas reflect dream` 增加裁剪回归测试，覆盖预算耗尽节点进入 `pruned`。
- [ ] 在任务结束后的 Experience Graph 写入中补充 `execution_trace` 节点，串联关键工具调用和验证命令。
- [ ] 为 `reflection_tasks` 增加幂等保护，避免同一个 run 结束路径重复创建反思任务。

## 低熵自主改进底座

- [x] 新增 `EntropyLedger` 类型和 `entropy_ledgers` 表，记录 0 到 1 归一化的 uncertainty、evidence、risk、informationGain、阈值版本和 nextBestObservation。
- [x] 新增 `LowEntropySignal` 类型和 `low_entropy_signals` 表，统一记录 test、typecheck、lint、schema、audit、approval、user_feedback、production_trace 和 golden_sample。
- [x] 为 `LowEntropySignal` 增加 source URI、hash、capturedAt、TTL、retentionPolicy、sensitivity、redactionStatus 和 secretScanStatus。
- [x] 新增 `ContextPerturbation` 类型和 `context_perturbations` 表，记录 role、trigger、injectionPoint、contextPatchHash、status、safetyGateResult、appliedRunId 和 producedSignalId。
- [ ] 每次普通 run 结束后，即使没有 Goal，也必须将 `AuditPacket`、Ego verification、审批拒绝和用户纠正转换为低熵信号。
- [x] Experience Graph 增加 LowEntropySignal 与 run/result/experience 的因果边；`goal_id` 只作为可选关联。
- [ ] 扩展 HA 验收合同，逐步结构化 `objective`、只读输入、允许输出、禁止状态、完成判据、失败判据、必须证据和 validator。
- [ ] 扩展 Ego prompt，要求每轮优先选择最大信息增益动作，并在结构化结果中报告关键证据缺口。
- [ ] 扩展 Superego typed tool，输出 `entropyDelta`、`evidenceQuality`、`remainingUncertainty` 和 `nextBestObservation`。
- [ ] 为 evidenceScore、riskScore、uncertaintyScore、informationGainScore 和 evidenceQuality 增加固定初始权重、阈值和回归测试。

## 统一自主调度

- [ ] 将 `reflection_tasks` 泛化为统一 `autonomy_jobs`，覆盖 `reflection | dream | prune | consolidation | goal_continuation`；`goal_id` 仅为可选关联。
- [ ] 全局 scheduler 按 `owner_id` / `lease_until` 原子 claim due AutonomyJob，避免多个 AionUI 会话或 daemon 重复执行。
- [ ] 无 active Goal 时，scheduler 仍可处理 reflection、dream、prune 和 consolidation。
- [ ] 为 Reflection、Dream、Consolidation 和 Goal continuation 的 claim/release/status transition 增加回归测试。
- [ ] 用户新消息到达时抢占 `goal_continuation`，但不取消已安全运行的无副作用 reflection、dream 和 consolidation。

## Goal 可控面

- [x] 新增 `goal_tasks` 和 `goal_subgoals` 表，记录 Goal 状态、risk/novelty/entropy/perturbation 预算、验收合同、claim lease、最近 run 和下一次唤醒时间。
- [x] 新增 `mas goal set/status/pause/resume/clear/list` 命令。
- [x] 新增 `mas subgoal add/list/confirm/reject/remove` 命令；HA/Superego 只能创建 candidate，用户确认后才能 active。
- [x] 新增 `GoalCommandRouter`，ACP 层只识别 `/goal` 和 `/subgoal` 并调用控制面接口。
- [x] 通过 `session/update` 展示当前 Goal 状态，展示数据来自 Goal 控制面查询结果。
- [ ] Goal 状态变化必须写入 audit 和 events，覆盖创建、暂停、恢复、完成、阻塞、过期和清除。
- [x] Goal 不影响无 Goal 的 reflection、dream、prune 和 consolidation 自主改进闭环。

## Goal Judge 和受控续跑

- [ ] 新增 `GoalJudgeResult` typed tool schema，基于 Goal、Subgoal、EgoResult、SuperegoReview、AuditPacket 和 EntropyLedger 判断 `done | continue | pause | blocked | expire`。
- [ ] 将预算耗尽、连续失败、审计门禁、权限上下文变化和低证据质量作为确定性暂停/阻塞条件。
- [ ] 新增 `GoalController`，负责 continuation prompt、状态机转换、预算扣减和下一次唤醒时间。
- [ ] 通过统一 scheduler claim `goal_continuation` job，避免在 `MasRunner.run` 内递归续跑。
- [ ] Goal continuation 必须读取当前权限策略，不继承过期或已变更的审批上下文；`context_only` 扰动不能绕过工具审批。
- [ ] 为 Goal 跨进程重启续跑、预算暂停、审计阻塞和用户抢占增加回归测试。

## 角色上下文扰动机制

- [ ] 新增 `ContextPerturbationController`，负责生成 SelfPerturbation 和 PerturbationProposal。
- [ ] 增加角色扰动矩阵：HA 很低、Ego 高、Superego 自身低到中且可给 Ego 高扰动、Dream 中到高但离线。
- [ ] 为扰动增加安全门禁：context-only、数据块隔离、来源标注、hash、角色注入点、可验证和预算约束。
- [ ] 扰动片段进入 prompt 时必须作为候选数据，不得作为指令，不得覆盖系统规则、用户目标、验收合同、权限策略和确定性门禁。
- [ ] 在 `entropyDelta=unchanged`、同质返工、验证停滞、普通任务或 Goal 长期无证据增益时触发低风险扰动。
- [ ] 扰动只允许进入 HA/Ego/Superego/Dream 上下文；任何读写或执行都必须转入 Ego 普通工具链并走权限审批。
- [ ] Dream 负责发现固定吸引子和重复模式，生成扰动候选库；Superego / AutonomyLoop 默认评估扰动安全性和信息增益，有 Goal 时 GoalController 参与控制面判断。
- [ ] 将扰动结果转成 `LowEntropySignal` 后才能固化到 Experience Graph、eval、policy、skill 或 doc candidate。
- [ ] 固定低风险角色扰动作为 MVP 默认机制；复杂算法策略按 novelty、harmlessness、validationYield、escapeRate、regret 和 safetyIncidents 评估后再晋升。

## 持续改进飞轮

- [ ] 新增 `EvalCandidate` 结构，高价值失败、用户纠正和重复失败自动生成候选。
- [ ] Dream 将高置信低熵经验压缩为 eval、policy、skill、doc 或 validator candidate，而不是只生成反思摘要。
- [ ] 为 candidate 增加人工确认和晋升路径，避免后台自主修改用户工作区。
- [ ] 将已晋升 eval 纳入后续 Superego 和 HA 终验的回归门禁。
- [ ] Experience Graph 增加 LowEntropySignal、EvalCandidate 与 run/result/experience 的因果边；Goal 只作为可选控制面关联。

## Superego 反思

- [x] 为 Superego 增加 `AuditPacket` 输入，覆盖审批记录、写入路径、命令摘要和 `changed_files` 对账。
- [x] 增加确定性审计门禁：发现 `changed_files` 漏报、`output` 目录外写入或只读输入路径写入时，禁止 `accept`。
- [x] 在 `AuditPacket` 中加入抽样复核建议，让 Superego 根据任务类型自主决定分层风险抽样、少量随机扰动和只读实施内容。
- [x] 将默认验收策略调整为当前状态门禁 + 历史事实留痕，避免历史已清理越界写入永久阻塞任务收敛。
- [x] 明确 snapshot/diff 默认采用边界目录轻量元数据 diff + 风险触发深查，不做全量重审计。
- [ ] 将当前启发式 `planReflection` 升级为 Superego typed tool 输出。
- [ ] 为反思意图增加结构化字段：`entropyReason`、`expectedSignal`、`noNewSignalAction`、`informationGainScore`。
- [ ] 到期反思时读取 source run、Experience Graph 邻域和用户反馈，而不是只读取反思任务自身。
- [ ] 支持 Superego 在到期反思中显式决定 `cancel`、`complete`、`reschedule`、`abstract`。
- [ ] 将 `AuditPacket` 扩展到命令副作用解析，例如识别 shell 中的重定向、复制、移动和脚本生成文件。
- [x] 为只读输入边界和输出边界实现轻量元数据 snapshot/diff，并仅在风险升高时触发 hash 或内容级深查。
- [ ] 为 boundary snapshot 增加可配置目录深度、文件数上限和大目录降级策略。
- [ ] 为高风险数据任务沉淀可复用抽样复算模板，但保持 Superego 可根据任务上下文自主选择抽样点。

## Dream 模式

- [ ] 定义 `DreamGraphPatch` typed tool schema。
- [ ] 将 Dream 从手动 `mas reflect dream` 升级为 `autonomy_jobs` 中的 `dream` 类型，由全局 scheduler 到期唤醒。
- [ ] Dream 只允许操作 Experience Graph，不允许外部工具、用户工作区写入和新建嵌套反思。
- [ ] 增加图复杂度阈值，超过阈值时强制进入 Dream 裁剪。
- [ ] 增加边权衰减、节点合并、重复经验抽象和低价值节点裁剪。

## 能量预算和拓扑约束

- [ ] 引入全局反思预算，例如最大活跃反思数、每日最大唤醒数和最大 Dream 运行时长。
- [ ] 增加环检测和 loop count，允许有向循环但限制重复唤醒。
- [ ] 为 `maxChildren` 增加真实子节点统计，避免反思链无限分叉。
- [ ] 增加 `expiresAt`，让长期未命中的反思自动过期。

## 调度接入

- [x] 文档化外部 cron 调用 `mas reflect due` 的推荐方式。
- [x] 提供 Node.js timer 作为 ACP 进程内的外部唤醒源，避免完全依赖 AionUI 会话级 cron。
- [x] 增加全局 Node.js autonomy daemon 入口，使用 SQLite scheduler lease 作为跨会话单实例调度器。
- [x] 增加 scheduled -> running 的原子 claim，避免多调度源重复处理同一反思任务。
- [ ] 为 Node.js timer 调度增加回归测试，覆盖 tick 调用 due reflection 和 dream prune。
- [ ] 将 `reflection_tasks` 迁移到统一 `autonomy_jobs` 后，保留 `mas reflect due` / `mas reflect dream` 兼容入口。
- [ ] 为后台反思和 Dream 增加独立审计事件，确保用户能追踪每次自动唤醒。

## 记忆和能力提升

- [ ] 实现 `MemoryArtifact` 检索接口，让 HA/Ego/Superego 能消费 reflection/dream/prune/consolidation 的产物。
- [ ] 将高置信经验沉淀到项目文档、技能或测试，而不是只保存在 SQLite。
- [ ] 设计 Experience Graph 检索接口，让 Ego/Superego 能感知相关历史经验。
- [ ] 明确哪些节点不可被 Dream 删除，例如用户明确规则、审计记录和安全边界。
- [ ] 设计从 Experience Graph 到 skill / docs / tests 的晋升路径。
