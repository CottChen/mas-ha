# MAS 自主性待办

本文记录 MAS 自主性机制的具体待办事项；长期原则见 `AGENTS.md`，设计背景见 `docs/AUTONOMY.md`。

## 最小闭环

- [ ] 为 `mas reflect due` 增加端到端回归测试，覆盖 scheduled -> completed / cancelled。
- [ ] 为 `mas reflect dream` 增加裁剪回归测试，覆盖预算耗尽节点进入 `pruned`。
- [ ] 在任务结束后的 Experience Graph 写入中补充 `execution_trace` 节点，串联关键工具调用和验证命令。
- [ ] 为 `reflection_tasks` 增加幂等保护，避免同一个 run 结束路径重复创建反思任务。

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
- [ ] 为 Node.js timer 调度增加回归测试，覆盖 tick 调用 due reflection 和 dream prune。
- [ ] 增加 scheduled -> running 的原子 claim，避免多调度源重复处理同一反思任务。
- [ ] 为后台反思和 Dream 增加独立审计事件，确保用户能追踪每次自动唤醒。

## 记忆和能力提升

- [ ] 将高置信经验沉淀到项目文档、技能或测试，而不是只保存在 SQLite。
- [ ] 设计 Experience Graph 检索接口，让 Ego/Superego 能感知相关历史经验。
- [ ] 明确哪些节点不可被 Dream 删除，例如用户明确规则、审计记录和安全边界。
- [ ] 设计从 Experience Graph 到 skill / docs / tests 的晋升路径。
