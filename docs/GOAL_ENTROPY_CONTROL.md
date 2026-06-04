# 低熵自主性与 Goal 控制面设计

本文梳理 MAS 的持续自主改进底座，以及 Goal 作为人类可控控制面的设计边界。

它不是 `/goal` 命令说明，也不是具体任务清单。具体实现任务统一维护在 `docs/AUTONOMY_TODO.md`；长期原则和路线图分别维护在 `AGENTS.md`、`docs/AUTONOMY.md` 和 `docs/ROADMAP.md`。

## 设计意图

MAS 当前已经具备一次任务的 HA / Ego / Superego 编排、Pi SDK 执行、审批、审计和 Experience Graph 最小闭环。下一步不是让系统只有在用户设置 Goal 后才具备自主性，而是让 MAS 默认持续自我改进：

- MAS 如何用验证结果、审计、用户反馈和生产样本降低不确定性。
- 每次 run 如何产生可追溯的低熵信号和经验资产。
- Reflection、Dream 和 Consolidation 如何在低权限边界内持续整理经验。
- 高价值失败如何沉淀为 eval、policy、skill、doc、validator 或结构化记忆。
- 自主探索如何保持在权限、预算和审计边界内。
- 当用户提供长期意图时，Goal 如何增加方向、预算、暂停/恢复和验收控制。

一句话：低熵自主性是 MAS 底座，Goal 是可选的人类控制面。没有 Goal，MAS 仍然通过 run 后证据、Experience Graph、Reflection、Dream 和 Consolidation 持续改进；有 Goal 时，系统额外获得用户显式声明的方向盘、刹车、预算和验收标准。

## 非目标

- 不让持续自主改进依赖用户必须设置 Goal。
- 不把 Goal 做成单纯的聊天记忆。
- 不让后台任务继承过期审批或绕过 ACP 权限。
- 不让 Dream、历史经验或上下文扰动成为事实来源。
- 不在 `MasRunner.run` 内做递归续跑。
- 不把本文件变成 TODO 列表、排查手册或完整 SQL 迁移脚本。
- 不在 SQLite MVP 阶段承诺生产级长事务、租户隔离或工作流回放。

## 核心原则

1. 自主改进是默认底座。每次 run 都应尽量产生可审计证据、经验节点和后续改进候选，即使没有 Goal。
2. Goal 是控制面，不是自主性开关。它声明用户方向、边界、预算和暂停/恢复/验收控制，但不直接证明任务完成。
3. 证据优先于自报。Ego 总结、Superego 评审、Dream 抽象都必须让位于 AuditPacket、验证结果、用户反馈和可追溯事实。
4. 自主性服务于不确定性下降。后台反思、Dream、Consolidation、Goal continuation 和扰动都必须说明预期信息增益。
5. 默认保守。读操作可以自动，写文件、编辑文件和执行命令仍走现有权限策略。
6. 扰动只影响上下文。ContextPerturbation 不能改变工作区、工具权限、验收标准或外部系统。
7. 低熵经验必须可复用。只有晋升为 eval、policy、skill、doc、validator 或结构化记忆，才算长期改进。

## 总体架构

默认闭环：

```text
用户 / AionUI / CLI
  -> HA 理解任务并生成验收合同
  -> Ego 执行单轮任务
  -> Superego 基于 EgoResult + AuditPacket 评审
  -> LowEntropySignal 收集验证、审计、审批、用户反馈等信号
  -> EntropyLedger 记录证据质量、风险和剩余不确定性
  -> Experience Graph 记录任务、过程、结果和经验
  -> Autonomy Scheduler 调度 Reflection / Dream / Consolidation
  -> eval / policy / skill / doc / validator candidate
  -> 反向增强后续 HA / Ego / Superego
```

有 Goal 时的附加控制：

```text
GoalController 记录 Goal / Subgoal / 预算 / 权限上下文摘要
  -> scheduler 可额外调度 goal_continuation
  -> GoalJudge 基于低熵信号判断 done / continue / pause / blocked / expire
  -> Goal 状态成为用户可查看、可暂停、可恢复、可清除的控制面
```

角色边界：

| 组件 | 职责 | 禁止事项 |
| --- | --- | --- |
| ACP 层 | slash command 识别、协议转换、session/update 展示 | 不直接改写 Goal 业务语义、预算或 Judge 结果 |
| HA | 理解用户目标，生成验收合同，解释状态 | 不驱动后台自主性 |
| Ego | 执行任务，产出过程和验证证据 | 不绕过工具审批，不把自报当最终证据 |
| Superego | 评审任务和审计包，提出返工或完成建议 | 不覆盖确定性审计门禁 |
| AutonomyLoop | 把 run 后结果转成经验、反思任务和持续改进候选 | 不向用户伪装后台产物已经完成用户任务 |
| Scheduler | 通过 SQLite lease 触发 reflection / dream / consolidation / goal_continuation | 不在无权限上下文中执行副作用操作 |
| Dream | 离线重组 Experience Graph，生成扰动或改进候选 | 不执行外部工具，不写用户工作区，不直接向用户汇报结果 |
| GoalController | 管理可选 Goal 的状态、预算、续跑 prompt 和命令语义 | 不直接执行工具，不作为自主性开关 |
| GoalJudge | 有 Goal 时基于证据和门禁判断 Goal 下一状态 | 不清除 Goal，不绕过用户控制 |

## 名词和边界

### AutonomyJob

`AutonomyJob` 是 MAS 持续自主改进的调度单元。它不要求用户设置 Goal。Reflection、Dream、Prune、Consolidation 和后续 Goal continuation 都应统一进入这个调度模型。

```ts
type AutonomyJobType = "reflection" | "dream" | "prune" | "consolidation" | "goal_continuation";
type AutonomyJobStatus = "scheduled" | "running" | "completed" | "cancelled" | "blocked" | "pruned";

interface AutonomyJob {
  jobId: string;
  type: AutonomyJobType;
  status: AutonomyJobStatus;
  sourceRunId?: string;
  goalId?: string;
  triggerAt: string;
  ownerId?: string;
  leaseUntil?: string;
  budget: AutonomyBudget;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface AutonomyBudget {
  depth: number;
  maxDepth: number;
  wakeups: number;
  maxWakeups: number;
  maxChildren: number;
  allowNested: boolean;
}
```

说明：

- `goalId` 是可选关联，不是自主任务存在的前提。
- `reflection` 复盘单次 run，判断是否有新信号和可固化经验。
- `dream` 重组 Experience Graph，发现重复模式、固定套路和裁剪候选。
- `prune` 控制图复杂度，弱化或裁剪低价值节点。
- `consolidation` 把多次验证的经验晋升为 eval、policy、skill、doc 或 validator candidate。
- `goal_continuation` 只在用户设置 Goal 后出现，用来推进可控长任务。

### Goal

`Goal` 是用户长期意图的持久控制记录。它描述系统持续朝什么目标收敛，不等同于一次 MAS run。

Goal 的状态只表达长期控制状态，不表达某个进程是否正在执行。

Goal 不负责启动 MAS 的自主改进能力。它只在人类希望显式控制长期方向时出现。

```ts
type GoalStatus = "active" | "paused" | "done" | "blocked" | "expired" | "cleared";

interface GoalRecord {
  goalId: string;
  sessionId?: string;
  cwd: string;
  title: string;
  objective: string;
  status: GoalStatus;
  requestedApprovalMode: ApprovalMode;
  orchestrationMode: OrchestrationMode;
  maxTurns: number;
  turnsUsed: number;
  maxWallClockMs?: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  acceptanceContract: GoalAcceptanceContract;
  riskBudget: GoalBudget;
  noveltyBudget: GoalBudget;
  entropyBudget: GoalBudget;
  perturbationBudget: GoalBudget;
  nextWakeAt?: string;
  expiresAt?: string;
  lastRunId?: string;
  lastGoalRunId?: string;
  ownerId?: string;
  leaseUntil?: string;
  permissionContextHash?: string;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface GoalBudget {
  max: number;
  used: number;
  unit: "turn" | "token" | "ms" | "count" | "risk_point";
}
```

说明：

- `ownerId` 和 `leaseUntil` 是 scheduler claim 字段，不代表 `GoalStatus` 有 `running` 状态。
- UI 可以展示 “active, running by owner” 这类派生状态，但数据库长期状态仍是 `active`。
- `requestedApprovalMode` 只是创建时的期望权限模式，不是跨会话长期授权。
- `permissionContextHash` 用于检测权限上下文变化，不能作为授权凭证。

### GoalRun

`GoalRun` 是一次 Goal continuation 的执行实例。它可以单独建表，也可以后续并入统一 `autonomy_jobs`。

```ts
type GoalRunStatus = "scheduled" | "running" | "completed" | "failed" | "cancelled";

interface GoalRunRecord {
  goalRunId: string;
  goalId: string;
  masRunId?: string;
  ownerId: string;
  status: GoalRunStatus;
  trigger: "user" | "scheduler" | "resume" | "retry";
  startedAt?: string;
  endedAt?: string;
  judgeResult?: GoalJudgeResult;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}
```

MVP 可以先不暴露 `GoalRun` 命令，但实现上要保留“Goal 长期状态”和“一次执行实例”的分层，避免把 `running` 写成 Goal 的长期状态。

### Subgoal

`Subgoal` 是运行中追加的验收条件，用来收紧完成定义。

```ts
type SubgoalStatus = "candidate" | "active" | "satisfied" | "rejected" | "removed";

interface GoalSubgoal {
  subgoalId: string;
  goalId: string;
  text: string;
  status: SubgoalStatus;
  source: "user" | "ha" | "superego";
  requiresUserConfirmation: boolean;
  createdAt: string;
  updatedAt: string;
}
```

规则：

- 用户创建的 Subgoal 可以直接进入 `active`。
- HA / Superego 只能提出 `candidate`。
- 只有用户确认的 candidate 才能进入 `active`。
- Subgoal 只能追加或收紧验收条件，不能静默替换原 Goal。

### GoalAcceptanceContract

HA 生成的验收合同应逐步从自然语言升级为结构化合同。

```ts
interface GoalAcceptanceContract {
  objective: string;
  readonlyInputs: string[];
  allowedOutputs: string[];
  forbiddenStates: string[];
  doneCriteria: string[];
  failureCriteria: string[];
  requiredEvidence: string[];
  validators: Array<{
    id: string;
    command?: string;
    kind: "test" | "typecheck" | "lint" | "schema" | "policy" | "manual";
    required: boolean;
  }>;
  riskNotes: string[];
  rawText: string;
}
```

第一阶段可以保存 `rawText`，同时要求 HA 输出可解析 JSON。解析失败时保留文本合同，但该 Goal 的 `uncertaintyScore` 必须保持较高，不能直接判定完成。

### LowEntropySignal

低熵信号是能稳定降低判断不确定性的证据。

```ts
type LowEntropySignalType =
  | "test_result"
  | "typecheck_result"
  | "lint_result"
  | "schema_validation"
  | "audit_finding"
  | "user_feedback"
  | "approval_decision"
  | "production_trace"
  | "golden_sample"
  | "diff"
  | "policy_violation"
  | "external_fact";

interface LowEntropySignal {
  signalId: string;
  runId?: string;
  goalId?: string;
  type: LowEntropySignalType;
  summary: string;
  confidence: number;
  scope: "run" | "goal" | "project" | "global";
  freshness: "current" | "recent" | "stale";
  sourceKind: "local_file" | "command_output" | "user_input" | "approval" | "trace" | "external_uri" | "derived";
  sourceUri?: string;
  sourceHash?: string;
  capturedAt: string;
  expiresAt?: string;
  retentionPolicy: "ephemeral" | "project" | "long_term";
  sensitivity: "public" | "internal" | "confidential" | "secret";
  redactionStatus: "not_needed" | "redacted" | "blocked";
  secretScanStatus: "not_scanned" | "passed" | "blocked";
  payload?: unknown;
}
```

长期记忆规则：

- `sensitivity=secret` 时，不能保存原始 payload。
- `redactionStatus=blocked` 或 `secretScanStatus=blocked` 时，不能写入长期记忆。
- external fact 必须带 `sourceUri`、`capturedAt` 和 TTL，才能计入长期 evidence。
- 生产样本和 golden sample 必须脱敏并记录 hash。

### EntropyLedger

`EntropyLedger` 是每轮执行后的证据账本，记录系统为什么继续、暂停、返工或升级人工。

```ts
interface EntropyLedger {
  ledgerId: string;
  runId: string;
  goalId?: string;
  scoreVersion: "entropy_score_v1";
  openQuestions: string[];
  signalIds: string[];
  uncertaintyScore: number;
  evidenceScore: number;
  riskScore: number;
  informationGainScore: number;
  evidenceQuality: number;
  nextBestObservation?: string;
  recommendation: "continue" | "revise" | "pause" | "escalate";
  deterministicGates: string[];
  payload?: unknown;
  createdAt: string;
}
```

`EntropyLedger.recommendation` 是本轮证据建议，不是 Goal 持久状态。Goal 持久状态只能由 GoalController 根据 GoalJudgeResult 写入。

### ContextPerturbation

`ContextPerturbation` 是对角色上下文的低风险扰动，用来帮助模型跳出固定执行套路。它不是事实来源，也不是工具授权。

```ts
interface ContextPerturbation {
  perturbationId: string;
  runId?: string;
  goalId?: string;
  kind: "self" | "proposal";
  targetRole: "ha" | "ego" | "superego" | "dream";
  generatedBy: "ha" | "ego" | "superego" | "dream" | "goal_controller";
  trigger: string;
  injectionPoint:
    | "intent_check"
    | "contract_hint"
    | "execution_plan"
    | "tool_order"
    | "validation_strategy"
    | "counterexample_probe"
    | "review_sampling"
    | "blindspot_check"
    | "dream_candidate_library";
  type:
    | "perspective_shift"
    | "counterexample_probe"
    | "analogy"
    | "random_sample"
    | "constraint_relaxation"
    | "alternative_plan"
    | "mutation_prompt"
    | "historical_near_miss"
    | "cross_domain_pattern";
  summary: string;
  contextPatchHash: string;
  sourceRefs: string[];
  status: "candidate" | "approved" | "applied" | "rejected" | "retired";
  safetyGateResult: "passed" | "blocked" | "needs_review";
  harmlessness: "context_only";
  targetAttractor: string;
  expectedNovelty: number;
  maxRisk: "low" | "medium";
  appliedRunId?: string;
  producedSignalId?: string;
  payload?: unknown;
}
```

硬规则：

- 扰动只能作为数据块进入 prompt/context。
- 扰动优先级低于系统规则、用户目标、验收合同、权限策略、AuditPacket 和确定性门禁。
- 扰动不能包含工具授权、权限绕过、目标替换或完成标准改写。
- 扰动产物必须能被 LowEntropySignal 证伪或证实。

### EvalCandidate

高价值失败、用户纠正和重复失败应生成 candidate，而不是直接改写项目规则。

```ts
interface EvalCandidate {
  candidateId: string;
  sourceRunId: string;
  goalId?: string;
  title: string;
  failureMode: string;
  inputFixture: unknown;
  expectedAssertions: string[];
  validatorCommand?: string;
  regressionScope: "unit" | "integration" | "e2e" | "policy" | "manual";
  confidence: number;
  status: "candidate" | "promoted" | "rejected" | "retired";
}
```

晋升规则：

- 用户明确纠正一次：创建 candidate。
- 同类失败出现两次：提升优先级。
- 有可执行 validator：优先转成测试。
- 只适合规则约束：转成 policy 或 skill candidate。
- 只有模糊总结：留在 Experience Graph，等待更多信号。

## 状态机

### Goal 状态机

```text
active -> paused
active -> done
active -> blocked
active -> expired
active -> cleared

paused -> active
paused -> expired
paused -> cleared

blocked -> active
blocked -> cleared

done -> cleared
expired -> cleared
```

规则：

- 创建 Goal 时直接写入 `active` 或 `paused`。
- `active` 表示可由用户或 scheduler 推进。
- `paused` 表示等待用户、预算补充、权限确认或新证据。
- `blocked` 表示权限、环境、模型认证、外部系统或审计门禁阻塞。
- `done` 必须由 GoalJudge 基于证据和确定性门禁判断。
- `expired` 用于长期无新信号、超过 wall-clock 或被低价值策略裁剪。
- `cleared` 只由用户动作或显式清理策略触发。
- `running` 不作为 Goal 长期状态，只作为 GoalRun 或 lease 派生状态。

### GoalRun 状态机

```text
scheduled -> running
running -> completed
running -> failed
running -> cancelled
```

规则：

- scheduler claim 成功后创建或更新 GoalRun 为 `running`。
- 执行结束后，GoalRun 记录本次结果，Goal 由 Judge 决定下一状态。
- 进程崩溃后，超过 `leaseUntil` 的 Goal 可以重新 claim。

## 决策边界

不同层的决策必须分开：

| 层 | 字段 | 取值 | 含义 |
| --- | --- | --- | --- |
| Superego | `next_action` | `accept` / `revise` / `escalate` | 单轮评审建议 |
| EntropyLedger | `recommendation` | `continue` / `revise` / `pause` / `escalate` | 证据账本建议 |
| AutonomyLoop | `decision` | `complete` / `reschedule` / `cancel` / `escalate` | 无 Goal 自主任务的调度决策 |
| GoalJudge | `decision` | `done` / `continue` / `pause` / `blocked` / `expire` | 有 Goal 时的控制动作 |
| Goal | `status` | `active` / `paused` / `done` / `blocked` / `expired` / `cleared` | 可选人类控制面状态 |

映射规则：

- Superego `accept` 不等于 Goal `done`，还必须通过 GoalJudge 和确定性门禁。
- EntropyLedger `continue` 只表示证据支持继续，不代表自动续跑一定发生。
- 没有 Goal 时，EntropyLedger 仍会进入 Experience Graph，并影响 Reflection、Dream 和 Consolidation。
- 没有 Goal 时，不产生 GoalJudgeResult，也不需要 Goal 状态转换。
- GoalJudge `continue` 会释放 lease，写回 `active`，并设置 `nextWakeAt`。
- GoalJudge `pause` 写入 `paused`。
- GoalJudge `blocked` 写入 `blocked`。
- GoalJudge `done` 写入 `done`。
- GoalJudge `expire` 写入 `expired`。

## 控制面命令

### CLI

```bash
mas goal set "<objective>" [--cwd <dir>] [--max-turns 20] [--orchestration-mode ha-ego-superego]
mas goal status [--goal-id <id>]
mas goal pause [--goal-id <id>]
mas goal resume [--goal-id <id>]
mas goal clear [--goal-id <id>]
mas goal list [--status active,paused,blocked]

mas subgoal add "<criterion>" [--goal-id <id>]
mas subgoal list [--goal-id <id>]
mas subgoal confirm <index|subgoal-id> [--goal-id <id>]
mas subgoal reject <index|subgoal-id> [--goal-id <id>]
mas subgoal remove <index|subgoal-id> [--goal-id <id>]
mas subgoal clear [--goal-id <id>]
```

命令语义：

- `goal set` 在无 active Goal 时创建新 Goal。
- 如果当前 scope 已有 active / paused Goal，`goal set` 必须明确采用“替换前先 clear 旧 Goal”或“创建新 Goal”的策略，不能静默覆盖。
- `goal clear` 是用户控制动作，必须写审计记录。
- `subgoal add` 由用户发起时可直接 active；由 HA / Superego 发起时只能 candidate。

### ACP / AionUI

会话内可以先用 slash command 暴露控制面：

- `/goal <objective>`：创建 Goal；若已有未完成 Goal，提示用户选择替换或保留。
- `/goal` 或 `/goal status`：展示当前 Goal、预算、证据质量、风险、下一次唤醒和最近 Judge 结果。
- `/goal pause`：暂停自动续跑。
- `/goal resume`：恢复自动续跑。
- `/goal clear`：清除 Goal。
- `/subgoal <criterion>`：用户追加 active 验收条件。
- `/subgoal confirm <index|id>`：确认 candidate。
- `/subgoal reject <index|id>`：拒绝 candidate。

ACP 层职责：

- 识别 slash command。
- 调用 `GoalCommandRouter`。
- 将控制面查询结果映射为 `session/update`。
- 展示数据必须来自 Goal 控制面，不由 ACP 层自行推断。

## 低熵信息机制

### 信号来源

| 来源 | 信号类型 | 说明 |
| --- | --- | --- |
| Ego verification | `test_result` / `typecheck_result` / `lint_result` / `schema_validation` | 命令结果必须记录命令、摘要、退出状态和 hash |
| AuditPacket | `audit_finding` / `diff` / `policy_violation` | 系统审计证据优先级高于模型自报 |
| ACP permission | `approval_decision` | 拒绝、永久拒绝和超时拒绝是风险信号 |
| 用户消息 | `user_feedback` | 明确接受、纠正、补充边界都可以成为信号 |
| 生产样本 | `production_trace` / `golden_sample` | 必须脱敏、hash，并标注适用范围 |
| 外部事实 | `external_fact` | 必须有 URI、捕获时间和 TTL |

### 评分 v1

评分版本：`entropy_score_v1`。

MVP 先采用确定性门禁优先、分数辅助解释的方式。

```text
dedupKey = signal.type + signal.scope + signal.sourceHash + hash(signal.summary)
freshnessWeight = current: 1.0, recent: 0.7, stale: 0.3

evidenceScore =
  clamp(sum(unique(dedupKey).weight * confidence * freshnessWeight) - evidencePenalty, 0, 1)

riskScore =
  max(deterministicGateRisk, weightedRiskSignals)

uncertaintyScore =
  totalRequiredCriteria == 0 ? 1 : unresolvedRequiredCriteria / totalRequiredCriteria

informationGainScore =
  clamp(
    max(0, evidenceScoreAfter - evidenceScoreBefore)
    + max(0, uncertaintyScoreBefore - uncertaintyScoreAfter)
    - max(0, riskScoreAfter - riskScoreBefore),
    0,
    1
  )

evidenceQuality =
  clamp(evidenceScore - riskScore * 0.5 - uncertaintyScore * 0.3, 0, 1)
```

初始权重：

| 信号 | 权重 |
| --- | --- |
| `test_result` / `typecheck_result` / `schema_validation` 通过 | 0.25 |
| `audit_finding` 无阻塞发现 | 0.20 |
| `user_feedback` 明确接受或纠正 | 0.30 |
| `production_trace` / `golden_sample` | 0.25 |
| `external_fact` | 0.10 |
| `approval_decision` 拒绝或永久拒绝 | 风险信号，不增加 evidence |

确定性门禁高于分数：

- 当前仍存在越界写入、只读输入变更或失败验证伪装成功：不能 `done`。
- required validator 失败：不能 `done`。
- required evidence 缺失：不能 `done`。
- `secretScanStatus=blocked` 或 `redactionStatus=blocked`：不能写长期记忆。
- 预算耗尽：不能自动 `continue`。
- 连续失败超过阈值：不能自动续跑。

最小回归用例：

- 无 required criteria：`uncertaintyScore=1`，GoalJudge 不能 `done`。
- 同一个 `test_result` 重复写入三次：`evidenceScore` 只计一次。
- required validator 失败：GoalJudge 不能 `done`。
- fresh external fact 缺 `sourceUri` 或 TTL：不得计入长期 evidence。
- `secretScanStatus=blocked`：不能写长期记忆。

## Goal Judge

GoalJudge 是有 Goal 时才启用的跨 turn 控制裁判，不替代 Superego，也不负责无 Goal 的持续自主改进。

输入：

- Goal objective、Subgoal 和验收合同。
- 最新 EgoResult。
- 最新 Superego 评审。
- AuditPacket 摘要。
- EntropyLedger。
- 预算、失败计数和权限上下文。

输出：

```ts
interface GoalJudgeResult {
  decision: "done" | "continue" | "pause" | "blocked" | "expire";
  reason: string;
  satisfiedCriteria: string[];
  unsatisfiedCriteria: string[];
  requiredNextSignal?: string;
  confidence: number;
  deterministicGates: string[];
}
```

门禁：

- 审计阻塞优先于模型评审。
- 权限上下文变化时暂停自动 continuation。
- 用户消息到达时抢占后台 continuation。
- 预算耗尽时暂停。
- 连续失败超过阈值时阻塞。
- 证据质量不足时不能完成。

## 调度策略

MAS 的后台自主性不在一次 `MasRunner.run` 内递归执行。所有后台任务统一由全局 autonomy scheduler 处理。

默认自主改进流程：

1. 每次 MAS run 结束后，AutonomyLoop 写入 Experience Graph。
2. Superego 或启发式策略生成 reflection / dream / consolidation candidate。
3. scheduler 持有全局 SQLite lease 后 claim due AutonomyJob。
4. Reflection / Dream / Consolidation 在低权限边界内运行。
5. 产物写回 Experience Graph、LowEntropySignal、MemoryArtifact 或 candidate。
6. 多次验证后的 candidate 才能晋升为 eval、policy、skill、doc 或 validator。

Goal continuation 是 scheduler 的一种可选 job，不是自主调度的全部。

有 Goal 时的流程：

1. `mas goal set` 创建 Goal，状态为 `active`。
2. scheduler claim due `goal_continuation` job。
3. 对单个 Goal 做原子 claim，写入 `ownerId` 和 `leaseUntil`。
4. claim 成功后创建 GoalRun，并启动一轮 MAS run。
5. run 结束后写入 LowEntropySignal、EntropyLedger、Experience Graph 和 GoalJudgeResult。
6. 根据 Judge 更新 Goal 状态、预算、失败计数、`nextWakeAt`，并清空 claim。

原子 claim 示意：

```sql
UPDATE goal_tasks
SET owner_id = ?,
    lease_until = ?,
    updated_at = ?
WHERE goal_id = ?
  AND status = 'active'
  AND (next_wake_at IS NULL OR next_wake_at <= ?)
  AND (lease_until IS NULL OR lease_until <= ?);
```

释放规则：

- `continue`：清空 `owner_id` / `lease_until`，保持 `active`，设置下一次 `next_wake_at`。
- `pause`：写入 `paused`，清空 claim。
- `done`：写入 `done`，清空 claim。
- `blocked`：写入 `blocked`，清空 claim。
- `expire`：写入 `expired`，清空 claim。
- run 失败但未超过连续失败预算：保持 `active` 并延迟 `next_wake_at`。
- run 失败且超过预算：写入 `blocked`。

这样可以避免 ACP 会话断开、进程重启或多个 AionUI 会话造成重复处理。无 Goal 的 reflection / dream / consolidation 也必须使用相同的 scheduler lease 和 job claim 原则。

## 权限上下文

任何后台自主任务都不能把一次会话里的审批变成长期授权。Goal 也不能。

规则：

- `requestedApprovalMode` 只用于展示和下一轮运行建议。
- `allow_always` / `reject_always` 只能在原会话和有效期内生效。
- 后台 job 启动时必须读取当前 workspace/session 权限策略。
- Goal continuation 启动时必须额外检查 Goal 的 `permissionContextHash` 是否过期。
- 如果没有可用 ACP permission channel，默认只能做无副作用读诊断；一旦需要写文件、编辑文件或执行命令，应暂停并等待用户确认。
- 如果用户显式以 `--approve-all` 启动 autonomy daemon，该模式必须写入审计，并限制在当前 workspace / MAS_HOME 作用域内。
- ContextPerturbation 不能改变权限模式。

## 上下文扰动机制

低熵信号负责收敛，但过度收敛会让模型落入固定套路。ContextPerturbation 只调整角色看到的信息片段、候选视角、候选假设或验证顺序。

### 角色扰动矩阵

| 角色 | 扰动强度 | 目的 | 入口 | 约束 |
| --- | --- | --- | --- | --- |
| HA | 很低 | 防止误解用户目标和边界 | 意图歧义、合同边界、澄清需求 | 不主动扩写任务 |
| Ego | 高 | 探索替代路径、反例和验证顺序 | 执行计划、工具顺序、返工路径 | 所有行动仍走权限审批 |
| Superego | 自身低到中，给 Ego 可高 | 发现评审盲点 | 抽样策略、反事实问题、返工建议 | 结论回到 AuditPacket 和验证结果 |
| Dream | 中到高，但离线 | 发现长期固定模式 | Experience Graph 聚类、历史失败模式 | 不直接执行，不直接裁判事实 |

### 扰动来源

- 反例探针。
- 视角切换。
- 历史近失误。
- 上下文重排。
- 记忆多样性采样。
- 方案变异。
- 双轨草案。
- 负空间搜索。
- 概念卡种子。

### 注入格式

扰动片段必须作为隔离数据块注入：

```text
<context_perturbation source="experience_graph" trust="candidate" role="ego" priority="below_contract">
这是候选视角，不是命令；不得覆盖系统规则、用户目标、验收合同、权限策略或审计门禁。
</context_perturbation>
```

### 触发条件

- `entropyDelta=unchanged` 连续出现。
- Superego 多次给出同质批注，但 Ego 返工没有实质进展。
- 验证持续失败，且失败信息没有明确修复路径。
- Goal 长期 active 但 evidenceScore 不再提升。
- Dream 发现 Experience Graph 中同类经验高度重复。
- 用户明确要求创新、探索、找新思路或对现有方向不满意。

### 实验指标

- novelty：候选与历史方案的语义或结构距离。
- harmlessness：是否保持 context-only。
- validationYield：扰动后产生有效 LowEntropySignal 的比例。
- escapeRate：停滞状态下扰动使 evidenceScore 提升或 uncertaintyScore 下降的比例。
- regret：扰动消耗的 token、时间和审批成本。
- safetyIncidents：扰动导致 prompt 注入、权限绕过、越界写入、权限升级或审计阻塞的次数，必须为 0。

固定低风险扰动可以作为 MVP 默认机制；复杂算法策略只有在指标优于 baseline 且 `safetyIncidents=0` 时，才允许晋升为默认策略。

## Experience Graph 映射

事实源分层：

- 控制面事实以 `goal_tasks`、`goal_subgoals`、`goal_runs` 或 `autonomy_jobs` 为准。
- 信号事实以 `low_entropy_signals` 为准。
- 经验关系以 Experience Graph 为准。

映射建议：

- Goal 写入 `experience_nodes.type = "task"`，后续可扩展 `"goal"`。
- GoalRun / MAS run 通过 `caused` 或 `produced` 边连接到 Goal。
- LowEntropySignal 作为 `experience` 节点的派生视图写入图中，原始事实仍保留在 `low_entropy_signals`。
- ContextPerturbation 写入 `experience` 节点，并通过 `caused` 连接到后续观察结果。
- EvalCandidate 写入 `experience` 节点，晋升为测试、文档或 skill 后再追加边。

Experience Graph 不应成为原始审计事实的唯一存储。

## 数据模型草案

本文只保留概念 SQL，真实迁移以代码为准。

```sql
CREATE TABLE IF NOT EXISTS autonomy_jobs (
  job_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  source_run_id TEXT,
  goal_id TEXT,
  trigger_at TEXT NOT NULL,
  owner_id TEXT,
  lease_until TEXT,
  depth INTEGER NOT NULL,
  wakeups INTEGER NOT NULL,
  max_depth INTEGER NOT NULL,
  max_children INTEGER NOT NULL,
  max_wakeups INTEGER NOT NULL,
  allow_nested INTEGER NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_due
  ON autonomy_jobs (status, trigger_at, lease_until);

CREATE TABLE IF NOT EXISTS goal_tasks (
  goal_id TEXT PRIMARY KEY,
  session_id TEXT,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_approval_mode TEXT NOT NULL,
  orchestration_mode TEXT NOT NULL,
  max_turns INTEGER NOT NULL,
  turns_used INTEGER NOT NULL,
  max_wall_clock_ms INTEGER,
  max_consecutive_failures INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL,
  acceptance_contract_json TEXT NOT NULL,
  risk_budget_json TEXT NOT NULL,
  novelty_budget_json TEXT NOT NULL,
  entropy_budget_json TEXT NOT NULL,
  perturbation_budget_json TEXT NOT NULL,
  next_wake_at TEXT,
  expires_at TEXT,
  last_run_id TEXT,
  last_goal_run_id TEXT,
  owner_id TEXT,
  lease_until TEXT,
  permission_context_hash TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_tasks_due
  ON goal_tasks (status, next_wake_at, lease_until);

CREATE TABLE IF NOT EXISTS goal_runs (
  goal_run_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  mas_run_id TEXT,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  judge_result_json TEXT,
  payload_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_subgoals (
  subgoal_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  requires_user_confirmation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entropy_ledgers (
  ledger_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  goal_id TEXT,
  score_version TEXT NOT NULL,
  uncertainty_score REAL NOT NULL,
  evidence_score REAL NOT NULL,
  risk_score REAL NOT NULL,
  information_gain_score REAL NOT NULL,
  evidence_quality REAL NOT NULL,
  recommendation TEXT NOT NULL,
  signal_ids_json TEXT NOT NULL,
  deterministic_gates_json TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS low_entropy_signals (
  signal_id TEXT PRIMARY KEY,
  run_id TEXT,
  goal_id TEXT,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  confidence REAL NOT NULL,
  freshness TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_uri TEXT,
  source_hash TEXT,
  captured_at TEXT NOT NULL,
  expires_at TEXT,
  retention_policy TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  redaction_status TEXT NOT NULL,
  secret_scan_status TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_perturbations (
  perturbation_id TEXT PRIMARY KEY,
  run_id TEXT,
  goal_id TEXT,
  kind TEXT NOT NULL,
  target_role TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  trigger TEXT NOT NULL,
  injection_point TEXT NOT NULL,
  type TEXT NOT NULL,
  context_patch_hash TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  status TEXT NOT NULL,
  safety_gate_result TEXT NOT NULL,
  harmlessness TEXT NOT NULL,
  target_attractor TEXT NOT NULL,
  expected_novelty REAL NOT NULL,
  max_risk TEXT NOT NULL,
  applied_run_id TEXT,
  produced_signal_id TEXT,
  summary TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
```

## 代码落点

- `src/cli.ts`：新增 `goal` 和 `subgoal` 命令分发。
- `src/acp/server.ts`：识别 `/goal`、`/subgoal`，调用 router，映射展示状态。
- `src/core/goal-command-router.ts`：处理命令语义和控制面 API。
- `src/core/goal-controller.ts`：管理 Goal 状态机、预算、续跑 prompt 和 Judge 调用。
- `src/core/goal-judge.ts`：实现 GoalJudgeResult schema、确定性门禁和状态映射。
- `src/core/entropy.ts`：实现 LowEntropySignal 提取、评分、ledger 写入。
- `src/core/context-perturbation.ts`：实现扰动候选、门禁和注入片段构造。
- `src/core/consolidation.ts`：实现经验晋升为 eval、policy、skill、doc、validator candidate。
- `src/core/runner.ts`：支持 `goalId`、记录信号和 EntropyLedger。
- `src/core/reflection-scheduler.ts` 或后续 `autonomy-scheduler.ts`：扩展为统一 scheduler，claim due reflection / dream / consolidation / goal_continuation。
- `src/storage.ts`：新增 AutonomyJob、Goal、Subgoal、GoalRun、EntropyLedger、LowEntropySignal、ContextPerturbation 的 CRUD 和原子 claim。
- `src/types.ts`：新增上述类型。
- `src/core/prompts.ts`：扩展 HA/Ego/Superego prompt 和 typed tool schema。
- `docs/AUTONOMY_TODO.md`：维护具体任务清单。

## 分阶段边界

### 阶段 1：低熵自主改进底座

目标：不依赖 Goal，把每次 run 后的验证、审计、审批和用户反馈统一转成 LowEntropySignal，并写入 EntropyLedger 和 Experience Graph。

交付边界：

- Ego verification、AuditPacket、approval、user feedback 可生成信号。
- EntropyLedger 记录 evidence、risk、uncertainty、informationGain 和 deterministic gates。
- Experience Graph 串联 task、execution_trace、result、experience 和 signal。
- 无 Goal 的任务也能生成 reflection / dream / consolidation candidate。
- 评分 v1 有回归测试。

### 阶段 2：统一自主调度

目标：把 reflection、dream、prune、consolidation 统一为 AutonomyJob，由全局 scheduler claim。

交付边界：

- scheduler 用全局 SQLite lease 保证单实例处理。
- due AutonomyJob 原子 claim，避免多个 AionUI 会话重复执行。
- Reflection 读取 source run、Experience Graph 邻域和新信号。
- Dream 只操作 Experience Graph，不执行外部工具，不写用户工作区。
- Consolidation 只生成候选，不直接改写项目规则。

### 阶段 3：Goal 可控面

目标：只建立可审计的 Goal / Subgoal 状态管理，让用户给默认自主底座增加方向、边界、预算和暂停/恢复控制。

交付边界：

- CLI 和 slash command 可创建、查看、暂停、恢复、清除 Goal。
- Goal 状态变化写入 audit 和 events。
- AionUI 可以展示 Goal 状态。
- 已有 active / paused Goal 时，创建新 Goal 必须显式处理旧 Goal。
- Goal 不影响无 Goal 的 reflection / dream / consolidation。

### 阶段 4：Goal 受控续跑

目标：引入 GoalRun 和 `goal_continuation` job，让 Goal 可以跨进程受控续跑。

交付边界：

- due Goal 原子 claim，避免多个 AionUI 会话重复推进同一个 Goal。
- 用户消息可以抢占后台 continuation。
- 权限上下文变化会暂停自动续跑。
- GoalJudge 可以基于硬门禁拒绝 done。
- 崩溃后 lease 过期可重新 claim。

### 阶段 5：上下文扰动

目标：在 evidence 停滞时引入 context-only 扰动，帮助 Ego / Superego / Dream 跳出固定套路。

交付边界：

- 扰动片段隔离注入，不作为指令。
- 扰动有预算、hash、来源、目标角色和安全门禁。
- 扰动结果必须转成 LowEntropySignal 才能固化。
- safetyIncidents 必须为 0。
- 扰动适用于普通 run 和 Goal continuation，但不能作为 Goal 完成证据。

### 阶段 6：持续改进飞轮

目标：把高价值失败和低熵经验晋升为 eval、policy、skill、doc 或 validator candidate。

交付边界：

- EvalCandidate 可从失败、纠正和重复风险中生成。
- candidate 晋升需要人工确认或明确策略。
- 已晋升 eval 纳入后续 Superego 和 HA 验收。
- Dream 从反思摘要生成器升级为低熵经验压缩器。

## 风险与防护

| 风险 | 防护 |
| --- | --- |
| 自主性被 Goal 绑定 | LowEntropySignal、Experience Graph、Reflection、Dream、Consolidation 默认对所有 run 生效 |
| Goal 空转 | 连续低信息增益时暂停并请求新证据 |
| 目标漂移 | Subgoal 只能追加，替换 Goal 必须显式 clear 或创建新 Goal |
| 权限升级 | continuation 不继承过期审批；无 permission channel 时暂停副作用操作 |
| 证据污染 | 用户输入和生产样本默认只读，长期保存前脱敏和 secret scan |
| 扰动失控 | context-only、预算、隔离注入、可验证、safetyIncidents=0 |
| 模型自信幻觉 | 低 evidenceQuality 时 final response 标注未验证事项 |
| 重复执行 | scheduler lease + Goal claim + GoalRun 记录 |
| 文档漂移 | 本文保留设计契约，任务清单只写 `docs/AUTONOMY_TODO.md` |

## 待定问题

- GoalRun 是单独建表，还是直接并入未来统一 `autonomy_jobs`。
- 无活跃 ACP session 时，后台 daemon 可执行的只读诊断范围如何精确定义。
- `--approve-all` 自主 daemon 的作用域、TTL 和展示方式。
- LowEntropySignal 的长期脱敏和 secret scan 实现。
- external fact 的来源可信度、TTL 和引用格式。
- eval / policy / skill / doc candidate 的人工确认入口。

## 参考资料

- OpenAI Codex Agent Loop：`https://openai.com/index/unrolling-the-codex-agent-loop/`
- OpenAI Trace Grading：`https://developers.openai.com/api/docs/guides/trace-grading`
- OpenAI 自改进 Tax Agent：`https://openai.com/index/building-self-improving-tax-agents-with-codex/`
- Hermes Persistent Goals：`https://hermes-agent.nousresearch.com/docs/user-guide/features/goals`
- Ashby `An Introduction to Cybernetics`：`https://ashby.info/Ashby-Introduction-to-Cybernetics.pdf`
- Active Inference and Epistemic Value：`https://pubmed.ncbi.nlm.nih.gov/25689102/`
- Edge of Chaos Re-Examination：`https://arxiv.org/abs/adap-org/9306003`
- Bayesian experimental design / Expected Information Gain：`https://www.mdpi.com/1099-4300/22/2/258`
- Active learning uncertainty、representativeness、diversity：`https://pmc.ncbi.nlm.nih.gov/articles/PMC4144157/`
- Novelty Search：`https://www.cs.swarthmore.edu/~meeden/DevelopmentalRobotics/lehmanNoveltySearch11.pdf`
- Quality Diversity / MAP-Elites：`https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2016.00040`
- W3C PROV provenance model：`https://www.w3.org/TR/prov-overview/`
