# MAS 自主性机制

本文说明当前已经接线的任务后自主性机制。系统定位和角色边界见 [ARCHITECTURE.md](ARCHITECTURE.md)；尚未解决的设计偏差见 [理念对齐 TODO](../quality/DESIGN_ALIGNMENT_TODO.md)。

## 边界

- 主任务由 HA、Ego、Superego 和确定性框架完成。
- 自主性机制消费任务、执行、审计和验收产物，不替代主任务交付。
- 后台任务不直接回复用户，不绕过权限，不写用户工作区。
- Goal / Subgoal 是低优先级控制实验，不是 Reflection、Dream、组织学习或普通任务完成的前置条件。

## 当前闭环

一次 run 收口后，`AutonomyLoop.recordTaskClosure()` 执行以下步骤：

1. 写入 task、execution trace、result 和 experience 节点。
2. 把 verification、approval、audit finding、diff 和 critique 转成 `LowEntropySignal`。
3. 生成启发式不确定性账本 `EntropyLedger` 和必要的 eval candidate。
4. 在预算允许时安排 reflection，并始终安排 consolidation candidate。
5. 失败、低信息增益或图规模达到阈值时安排 Dream job。

这里的 `EntropyLedger` 是固定权重启发式，不是 Shannon entropy。当前命名、校准和证据独立性问题登记在理念对齐 TODO。

## Experience Graph

当前主要节点：

| 节点 | 含义 |
| --- | --- |
| `task` | 用户任务和必要上下文 |
| `execution_trace` | 事件、角色运行和验证摘要 |
| `result` | run 状态、交付和评审结果 |
| `experience` | 单次任务后的经验摘要 |
| `signal` | 验证、审计、审批或反馈候选 |
| `reflection` | 后续反思意图和结果 |
| `dream` | Dream 图操作候选与裁剪记录 |
| `eval_candidate` | 失败模式和回归测试候选 |

图边记录 produced、caused、generalized、observed 和 scheduled 等关系。当前检索仍以标题和摘要的 SQLite `LIKE` 查询为主，不应被描述为成熟的语义记忆系统。

## 调度器

推荐入口：

```bash
mas autonomy daemon --interval 60000
```

辅助入口：

```bash
mas autonomy tick
mas autonomy status
```

调度器通过 SQLite `scheduler_leases` 保证全局单实例，并原子 claim `autonomy_jobs`。当前 job 类型包括 reflection、dream、prune、consolidation 和 goal_continuation。

每个 job 必须记录来源 run、预算、claim owner、状态变化、结果 payload 和审计事件。AionUI timer、系统 cron 和人工命令只能作为唤醒方式，不能替代 SQLite 中的调度事实。

## Reflection

Reflection 受以下预算约束：

- `depth` / `maxDepth`
- `wakeups` / `maxWakeups`
- `maxChildren`
- `allowNested`
- 全局活跃任务上限和 scheduler lease

当前到期判断主要依据唤醒预算和 source run 邻域节点数量；没有新信号时取消，达到预算时完成或裁剪。它是可审计调度骨架，还不是由 Superego 基于新证据完成的成熟语义反思。

## Dream

Dream 的确定性安全边界：

- 只操作 Experience Graph。
- 不执行外部工具。
- 不写用户工作区。
- 不创建新的嵌套反思。
- 不直接向用户交付结论。

当前实现会生成固定类型的 `DreamGraphPatch` candidate，衰减部分旧边，并裁剪已取消、过期或预算耗尽的节点。它尚未实现跨任务自由重组、吸引子检测、扰动效果评估或候选策略生成，因此不能宣称已经实现 Freud 梦机制或混沌动力系统。

## 候选晋升

后台任务只能创建 candidate。eval、validator、policy、skill 和 doc 的人工确认、回滚和 Git 落地规则见 [候选晋升](../governance/CANDIDATE_PROMOTION.md)。历史候选不是事实来源，使用前必须通过当前任务证据验证。

## 审计证据

Superego 评审前，框架把完整 AuditPacket 持久化为 run artifact，Prompt 只注入摘要和索引。AuditPacket 至少覆盖审批、命令、写入、边界声明、snapshot/diff、`changed_files` 对账和 agent health。

当前状态违规由确定性门禁阻塞；历史已清理问题保留事实但不永久阻塞。HA 和 Superego 可通过只读工具按需读取 artifact section，Agent 自报不能覆盖这些系统事实。

## 当前限制

- 评分、反思、Dream 和图检索仍包含未经真实任务校准的启发式。
- Dream patch、边衰减和节点裁剪还没有形成“输入扰动 -> 应用 -> 新证据 -> 效果评估”的闭环。
- 外部证据尚未以统一 Evidence Packet 进入 Experience Graph。
- 当前问题和后续改动只维护在 [理念对齐 TODO](../quality/DESIGN_ALIGNMENT_TODO.md)，验证方法只维护在 [测试与验证](../quality/TESTING.md)。
