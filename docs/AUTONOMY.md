# MAS 自主性设计记录

本文记录 MAS 自主性机制的设计讨论和当前最小闭环实现。

## 角色边界

- HA 是人类助理层，只负责面向用户接收任务、解释结果和澄清需求，不参与后台反思、定时唤醒或梦境裁剪。
- Ego 是执行层，负责完成任务、产生执行过程和结果证据，并把任务过程写入经验图。
- Superego 是评估层，负责验收任务、生成未来反思意图、控制反思预算并取消无价值反思。
- Id / Dream 是低权限生成层，用于在低规约状态下重组经验图、裁剪低价值节点和抽象长期经验。

## Experience Graph

自主性不只需要串联反思任务，也需要串联已经执行过的任务、过程、结果和经验。因此使用 Experience Graph，而不是只使用 Reflection Graph。

当前节点类型：

- `task`：用户任务和上下文。
- `execution_trace`：关键执行过程。
- `result`：任务结果、验证结果和风险。
- `experience`：任务后抽象出的经验摘要。
- `reflection`：未来反思意图或到期反思记录。
- `dream`：梦境裁剪或重组记录。

当前边类型：

- `caused`
- `produced`
- `generalized_to`
- `scheduled`
- `reflected_on`
- `dream_pruned`

## 能量预算和拓扑约束

反思任务必须带预算，避免自我引用失控：

- `depth` / `maxDepth`：反思链深度。
- `wakeups` / `maxWakeups`：唤醒次数。
- `maxChildren`：后续分支数。
- `allowNested`：是否允许后续嵌套反思。

到期反思需要先经过预算门控。没有新外部信号时，默认取消反思链；达到预算上限时，关闭后续反思。

## 生物学参照

- 睡眠与记忆巩固：任务日志类似情景记忆，梦境把它抽象为长期经验。
- 突触修剪：低价值边和节点应被弱化或裁剪。
- 默认模式网络：非任务状态下做自由联想和未来模拟，对应 Dream 模式。
- 稳态调节：通过全局预算、深度和唤醒次数维持系统活跃度。
- 预测处理：优先保留能降低预测误差和未来不确定性的反思。

## Dream 模式

Dream 模式是低权限、低规约模式。

允许：

- 自由重组经验图。
- 强化、弱化、合并、抽象、裁剪节点和边。
- 取消无价值反思。

禁止：

- 执行外部工具。
- 写用户工作区文件。
- 创建新的定时嵌套反思。
- 直接向用户发送任务结果。

## 全局自主性调度器

自主性是跨会话机制，不属于某个 AionUI ACP 会话。AionUI 会话只产生任务结果、经验和反思意图；真正的唤醒、裁剪和做梦由全局 Node.js 调度器统一处理。

推荐入口：

```bash
mas autonomy daemon --interval 60000
```

辅助入口：

```bash
mas autonomy tick
mas autonomy status
```

调度器使用 SQLite `scheduler_leases` 维护全局租约：

- `name = global-autonomy-scheduler`
- `owner_id` 标识当前 daemon。
- `heartbeat_at` / `expires_at` 控制接管。
- 同一时刻只有持有未过期 lease 的进程处理自主性任务。

每次 tick 是一个多路复用调度周期：

1. 尝试 claim 全局 scheduler lease。
2. 原子 claim 到期 reflection 任务，将 `scheduled` 改为 `running`。
3. 处理 reflection 任务并写入 Experience Graph。
4. 触发 Dream/Prune 裁剪预算耗尽的任务。
5. 写入审计日志和 heartbeat。

`reflection_tasks` 已使用 claim 模式，避免多个调度源重复处理同一到期任务。后续会把 `reflection_tasks` 泛化为统一的 `autonomy_jobs`：

```text
reflection | dream | prune | consolidation
```

## 自主任务产物

这些任务完成后的产物不是面向用户的回复，而是 Experience Graph 的结构变化、可检索经验资产和调度决策。

统一产物模型：

```ts
AutonomyJobResult {
  jobId: string;
  type: "reflection" | "dream" | "prune" | "consolidation";
  decision: "complete" | "reschedule" | "cancel" | "escalate";
  summary: string;
  graphOps: GraphOperation[];
  memoryArtifacts: MemoryArtifact[];
  followupJobs: AutonomyJobSpec[];
  confidence: number;
  evidence: string[];
}
```

`MemoryArtifact` 是未来 HA / Ego / Superego 可检索和注入的低熵经验：

```ts
MemoryArtifact {
  kind: "lesson" | "risk" | "pattern" | "rule_candidate" | "test_candidate" | "doc_candidate" | "hypothesis";
  scope: "task" | "project" | "global";
  content: string;
  confidence: number;
  sourceNodeIds: string[];
  activationHints: string[];
}
```

使用路径：

- HA：生成验收合同时检索相似任务经验、边界规则和用户偏好。
- Ego：执行前检索历史失败模式、环境约束和推荐操作策略。
- Superego：评审前检索审计规则、抽样策略和历史风险。
- Scheduler：根据 `followupJobs`、`decision` 和预算继续调度、取消或裁剪任务。
- Consolidation：高置信、多次命中的经验才晋升为 `AGENTS.md` 规则、`docs/` 文档或 smoke/test。

各类任务职责：

- Reflection 产生单任务经验、风险和后续调度决策。
- Dream 重组跨任务经验，生成主题、假设、合并和图裁剪建议。
- Prune 控制复杂度，软删除低价值节点或降低边权。
- Consolidation 把多次重复验证的经验固化为规则、文档候选或测试候选。

## 最小闭环

当前实现先打通最小闭环：

1. 任务结束后，Ego/Superego 结果被写入 Experience Graph。
2. Superego 生成一个 `reflection_tasks` 记录，包含触发时间和预算。
3. 全局 Node.js 调度器可以周期性执行 `mas autonomy tick` 等价逻辑。
4. 到期反思会根据是否有新信号和预算决定完成或取消。
5. `mas reflect dream` 会裁剪已经耗尽预算的反思任务。

调度入口统一为 `AutonomyLoop.runDueReflections()` 和全局 `mas autonomy daemon`；AionUI cron、系统 cron 和人工命令只作为调试或备用唤醒源，不作为推荐主路径。

当前 CLI：

```bash
mas reflect list
mas reflect due
mas reflect dream
```

ACP 进程也可以启用 Node.js timer 作为内嵌外部唤醒源：

```bash
mas acp --reflection-scheduler --reflection-interval 60000
```

该 timer 仅保留为开发/备用模式。正常跨会话自主性应使用全局 `mas autonomy daemon`，避免每个 ACP 会话都启动自己的 timer。真实调度状态仍以 SQLite lease 和任务状态为准。

## Superego 审计包

Superego 不能只依赖 Ego 自报结果。MAS 在 Superego 评审前生成 `AuditPacket`，把系统级证据传给 Superego，并在评审后执行确定性审计门禁。

当前 `AuditPacket` 包含：

- 审批记录和原始工具输入。
- `write` / `edit` 工具写入路径。
- 执行命令摘要。
- Ego 自报的 `changed_files`。
- 写入路径与 `changed_files` 的对账结果。
- 是否存在历史 `output` 目录外写入，以及当前是否仍存在 `output` 目录外写入。
- 是否存在历史 `data` / `template` 只读输入路径写入，以及当前是否仍存在只读输入路径写入。
- 面向 Superego 的抽样复核建议，包括任务类型提示和只读抽样规则。
- 边界 diff 策略说明：默认只做边界目录轻量元数据 diff，风险升高时才触发更深检查。

默认验收策略是“当前状态门禁 + 历史事实留痕”。当前仍存在 `output` 目录外写入、只读输入路径写入或失败验证伪装为成功时，即使模型评审返回 `accept`，MAS 审计门禁也会把结论改为 `revise`。历史已清理的越界写入和 `changed_files` 漏报会保留在审计包中，要求 Superego 记录和评估修复是否充分，但不单独作为永久阻塞。

Superego 抽样复核不是固定脚本，也不是全量重做 Ego 工作。MAS 只提供审计证据和抽样原则，由 Superego 根据任务类型、用户强调点、Ego 风险项和审计发现决定具体抽样策略。默认采用“分层风险抽样 + 少量随机扰动”：必查样本覆盖用户强调点和验收硬约束，风险样本覆盖 Ego 风险项、审计发现、空值/0值/异常值和边界条件，少量随机样本从剩余普通样本空间中选择，用于抵抗确认偏差。数据表任务通常优先抽样复算关键公式、检查输出结构和模板字段一致性；代码任务通常优先抽样检查改动文件、验证命令和用户可见行为。

抽样复核必须保持低副作用：允许只读检查，禁止写文件、编辑文件或执行有外部副作用的命令。如果 Superego 因权限、信息不足或成本过高没有抽样，必须在评审中说明原因，并相应降低质量分或提出返工建议。

文件系统 snapshot/diff 必须谨慎使用：默认不做全量工作区扫描或全量 hash，而是对用户声明的只读输入边界、输出边界和已知写入路径做轻量元数据对账。只有出现命令副作用、审计矛盾、返工失败或高风险数据任务时，才触发 hash 或内容级深查。

snapshot 由 MAS 框架层生成，不由 Ego 或 Superego 自报。HA 生成验收合同后，MAS 立即创建 baseline snapshot；Superego 评审前，MAS 创建 post snapshot 并计算 boundary diff。默认 diff 是摘要级元数据比较，只回答文件新增、修改、删除是否发生在允许边界内，不做 git diff 式逐行内容比较。

如需接入系统定时任务，可让 cron 定期执行：

```bash
mas reflect due
```

Windows / AionUI 环境推荐把外部定时任务配置为：

```text
cd C:\Users\Administrator\projects\mas-ha-orchestration
C:\Users\Administrator\custom\mas-ha-orchestration-acp-gitbash.cmd reflect due
```

该命令只唤醒已到期的 `reflection_tasks`；未到期任务保持 `scheduled`，已到期任务会写入 `reflection_completed` 审计记录并更新 `wakeups` 和状态。

后续演进方向：

- 把到期反思从启发式判断升级为 Superego typed tool。
- 把 Dream 输出升级为结构化 `DreamGraphPatch`。
- 增加信息增益评分、边权衰减、节点合并和图复杂度阈值。
- 允许 Dream 处理完整图切片，但继续保持低权限。
