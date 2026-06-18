# 多智能体实现 AI 自主性

面向研发团队的项目分享文档。配套 HTML 幻灯片见 `docs/MAS_AI_AUTONOMY_SHARE_SLIDES.html`。

## 0. 分享目标

MAS 的核心问题不是“把多个大模型串起来”，而是：如何让 AI agent 在真实软件工程任务中更自主，同时仍然可追溯、可审计、可验收。

这个项目给出的答案是：

- 用确定性软件框架承载协议、状态机、权限、审计、结构化输出、上下文边界和生命周期。
- 用 prompt 塑造稳定的工作人格、判断倾向和证据品味。
- 用 HA / Ego / Superego 的组织分工，把“用户代理、执行、审计反思”拆成不同视角。
- 用合同、AuditPacket、typed tool、低熵信号、反思和 Dream，把一次任务变成可复用的经验资产。

当前项目规模：

| 指标 | 当前值 |
| --- | ---: |
| TypeScript 核心源码 | 约 9415 行 |
| Markdown 项目文档 | 12 个，约 1485 行 |
| SQLite 业务表 | 19 张 |
| SQLite 索引 | 21 个 |
| 核心角色 | HA、Ego、Superego |
| 编排模式 | `ha-ego-superego`、`ha-ego` |
| 关键验证脚本 | `typecheck`、`doctor`、`e2e:smoke`、`smoke:audit` |

这些数字的意义不是规模，而是系统性：自主性不是单条 prompt 能解决的问题，它需要协议、运行时、状态机、审计、记忆、工具和 prompt 一起设计。

## 0.1 分享路线

这次分享按“先总后分”的顺序展开：

1. 先讲目标：为什么多智能体自主性不是把多个模型串起来，而是让 AI 在真实工程任务中能持续降低不确定性。
2. 再讲框架：ACP、MAS Core、Pi SDK 分别承担什么责任，为什么必须把协议、编排和运行时拆开。
3. 讲一次请求：从用户输入、HA 合同、Ego 执行、Superego 审计到 HA 终验，看合同和审计证据如何流转。
4. 讲理论底座：控制论说明为什么需要反馈闭环，信息熵说明为什么下一步要选择高信息增益观察。
5. 讲 Tool-MAD：论文证明异质工具和动态检索比普通 debate 更能打破共享幻觉。
6. 讲 MAS 的异质性：角色、模型、工具、证据、上下文和终止权如何隔离，避免多个 agent 犯同一种错。
7. 讲角色和上下文：HA、Ego、Superego 如何像组织一样协作，以及每个角色上下文如何被压缩和审计。
8. 最后讲 prompt：代码负责确定性，prompt 负责塑造稳定工作人格，而不是堆补丁式规则。

## 1. 一句话架构

```text
AionUI(ACP Client/UI)
        |
        | ACP JSON-RPC over stdio
        v
MAS ACP Agent
        |
        | session / request / permission / update
        v
MAS Orchestration Core
        |
        | HA 路由与终验 -> Ego 执行 -> Superego 审计 -> HA 终验
        v
Pi SDK Agent Runtime
        |
        | role tools / typed tools / model registry / skill loader
        v
Workspace + SQLite + Experience Graph
```

项目的关键边界：

- `src/acp/`：只负责 ACP 协议、AionUI session/update 映射、权限请求映射、会话加载和关闭。
- `src/core/`：负责 HA / Ego / Superego 状态机、验收合同、审计包、上下文扰动、反思和自主调度。
- `src/pi/`：负责 Pi SDK 动态加载、角色 session 创建、工具隔离、typed tool 和 Pi event 映射。
- `src/storage.ts`：负责 SQLite 持久化，包括 runs、agent_runs、messages、session_context、events、audit、Experience Graph、low entropy signals、autonomy jobs 等。

## 2. ACP、Pi SDK 和 MAS 各自负责什么

### 2.1 ACP 的职责

ACP 是 MAS 和 AionUI 之间的 UI/协议边界。它不理解 HA / Ego / Superego 的业务逻辑，只做这些事：

- `initialize`：声明协议版本、agent capabilities、session capabilities、server info。
- `session/new`：创建 MAS session，返回模式、模型列表、编排配置和 metadata。
- `session/load`：加载已有 MAS session，恢复压缩摘要和最近对话。
- `session/prompt`：接收用户输入，恢复上下文，创建本次 run，调用 MAS runner。
- `session/cancel`：中断当前 run。
- `session/close`：关闭 session，abort 运行中的任务并清理内存状态。
- `session/set_mode`：把 AionUI 的权限模式映射为 MAS 的 approval mode。
- `session/set_model`：接收 AionUI 会话模型选择，当前只影响 HA。
- `session/set_config_option`：切换 MAS 编排模式。
- `session/update`：把角色文本、思考、工具调用、权限请求、可用命令和模型配置展示给用户。
- `session/request_permission`：把写文件、编辑文件、执行命令等审批请求交给 AionUI。

ACP 层是“翻译官”和“会话外壳”，不做任务判断。

### 2.2 Pi SDK 的职责

Pi SDK 是 agent runtime。MAS 不依赖全局 `pi` 命令，而是通过 `@mariozechner/pi-coding-agent` 包创建内部 agent session。

Pi SDK 在这里负责：

- 创建 HA / Ego / Superego 的 role session。
- 加载模型注册表、settings、auth storage 和技能资源。
- 提供 read、grep、find、ls、write、edit、bash 等工具。
- 接收自定义 typed tools：`ha_decision`、`ego_result`、`superego_review`、`ha_final_review`。
- 订阅 Pi event，将文本、thinking、tool start/update/end 映射到 AionUI。
- 承接模型调用、工具执行和 skill loader。

Pi SDK 不负责：

- 不负责 MAS 状态机。
- 不决定 HA / Ego / Superego 的角色边界。
- 不判断最终验收。
- 不保存跨 run 的 MAS 会话语义。

### 2.3 MAS Core 的职责

MAS Core 是自主性和确定性的中心：

- 编排 HA -> Ego -> Superego -> HA 的请求生命周期。
- 管理最大返工轮次。
- 生成验收合同。
- 创建 baseline snapshot。
- 构造 AuditPacket。
- 解析 typed tool 输出并做 schema 校验。
- 在模型输出不合格时执行 repair prompt。
- 用确定性审计门禁覆盖模型误判。
- 记录 run、agent_run、approval、audit、event。
- 把结果沉淀到 Experience Graph。
- 调度 reflection、dream、prune、consolidation 和 goal continuation。

MAS Core 是“控制系统”，Pi SDK 是“执行内核”，ACP 是“外部协议接口”。

### 2.4 两个关键术语

**确定性门禁**指的是由代码执行的硬检查，而不是希望模型自觉遵守的提示词规则。

在 MAS 中，它包括：

- typed tool schema 校验：HA、Ego、Superego、HA 终验必须交出可解析、字段完整的结构化结果。
- repair prompt 兜底：模型输出结构不合格时，先尝试修复为合法结构，再进入状态机。
- AuditPacket 对账：把工具调用、审批、写入路径、`changed_files` 和文件快照进行交叉核对。
- 权限和边界检查：读、写、命令、外部检索、记忆查询分别由框架授予，不靠角色自称。
- HA 终验门禁：空摘要、零证据质量、失败验证伪装成功等情况不能为了流程闭环而 accept。

它解决的问题是：agent 可以有泛化能力，但系统不能把“是否完成”“是否越权”“证据是否为空”完全交给模型主观判断。

**本地只读 intake**指的是 HA 在生成验收合同前，对当前工作区做低风险、只读的任务理解。

它通常包括：

- 读取用户提供的任务说明、README、配置文件、模板说明和现有输出约定。
- 列出目标目录、数据目录、示例文件和已有脚本。
- 用 `rg`、`ls`、只读 `bash` 或等价工具确认项目结构和关键术语。
- 不写文件、不执行有副作用命令、不替 Ego 完成任务。

它解决的问题是：HA 不能只凭用户一句话或 Ego 自报生成合同。对本地项目、数据和模板类任务，合同必须先建立在当前文件事实上。

## 3. Session 生命周期

需要区分 3 个 session 概念：

| 名称 | 含义 | 生命周期 | 是否长期持久化 |
| --- | --- | --- | --- |
| ACP / AionUI `sessionId` | 用户在 AionUI 中看到的同一个对话 | `session/new` 到 `session/close` | 是，MAS 用它关联 messages、runs、summary |
| MAS `runId` | 一次用户请求的执行实例 | 一次 `session/prompt` | 是，记录 run、agent_runs、audit、events |
| Pi role session | HA / Ego / Superego 某一阶段的一次模型会话 | 每次角色调用新建，用完 dispose | 否，使用 in-memory session |

当前实现的关键点：

1. `session/new`
   - 创建新的 `mas-<uuid>` session。
   - 初始化会话上下文为空。
   - 返回 AionUI 可显示的 mode、model、configOptions、metadata。
   - 发送角色模型配置和可用命令。

2. `session/load`
   - 使用传入的 `sessionId`。
   - 从 SQLite 读取 `session_context` 和最近 `messages`。
   - 向 AionUI 回放压缩摘要和最近历史。

3. `session/prompt`
   - 若内存中找不到 session，则从 SQLite 自动 rehydrate。
   - 读取并压缩会话上下文。
   - 把用户消息写入 `messages`。
   - 识别 `/compact`、`/goal`、`/subgoal` 等控制命令。
   - 创建本次 MAS run。
   - 把 `conversationHistory`、`conversationSummary`、skills 传给 runner。
   - runner 完成后，把最终 MAS 回复写入 `messages`。

4. `session/cancel`
   - abort 当前 run。
   - 返回 ACP `cancelled` 语义。

5. `session/close`
   - abort 当前 run。
   - 删除内存 session。
   - 写 `acp_session_closed` 审计记录。

### 上下文是否会无限膨胀

不会无限进入 prompt。

MAS 在 `getConversationContext(sessionId)` 时自动调用 `compactSessionContext()`：

- 默认阈值：总消息字符数超过 `18000` 才压缩。
- 默认保留：最近 `10` 条消息。
- 摘要方式：抽取式摘要，保留早期消息的压缩摘要。
- 摘要上限：最终摘要截取约 `12000` 字符。

但是审计存储会增长。原始 `runs`、`agent_runs`、`audit_log`、`events`、`messages` 会保留，用于追溯和经验沉淀。

## 4. Request 生命周期

一次执行类请求的主路径：

```text
用户输入
  |
  v
ACP session/prompt
  |
  v
恢复会话上下文 + 写入 user message + 发现 skills
  |
  v
HA 路由
  |-- answer / clarify -> 直接回复
  |
  |-- execute
       |
       v
   HA 验收合同
       |
       v
   MAS baseline snapshot
       |
       v
   Ego 执行
       |
       v
   ego_result typed tool
       |
       v
   AuditPacket
       |
       v
   Superego 审计
       |
       v
   superego_review typed tool
       |
       |-- revise -> 下一轮 Ego
       |-- escalate -> 交给 HA 终验裁决
       |-- accept -> HA 终验
       v
   HA 终验
       |
       |-- accept -> completed
       |-- revise -> 下一轮 Ego
       |-- escalate -> needs_attention
```

注意：Ego 的 `needs_attention/blocked` 和 Superego 的 `escalate` 都不是最终用户人工介入结论。它们只是内部信号。只有 HA 终验可以代表用户把 run 结束为真正需要人工介入。

## 5. 合同契约的定义和流转

HA 不是执行者，它的核心产物是验收合同。

推荐合同结构：

```text
objective: 用户真实目标
readonlyInputs: 只读输入边界
allowedOutputs: 允许输出边界
forbiddenStates: 禁止状态
keyCriteria: 关键口径和高风险规则
doneCriteria: 完成标准
failureCriteria: 失败标准
requiredEvidence: 必须提供的证据
validators: 建议验证器
riskNotes: 风险和不确定性
```

合同的流转：

1. HA 基于用户请求、同会话历史、只读 intake、技能摘要、必要外部检索生成合同。
2. Ego 用合同执行，但不能机械照抄。如果发现合同遗漏用户口径，Ego 应补充理解并写入 evidence/risks。
3. MAS 用合同推断边界，例如只读输入、允许输出、是否必须写入 `output/`。
4. Superego 用合同和 AuditPacket 检查 Ego 是否实现了真实目标，而不是只生成“看起来像结果”的文件。
5. HA 终验用合同代表用户做最终交叉验证。

合同的价值是把“用户意图”转成“可执行、可审计、可验收”的协作接口。

## 6. JSON 结构化输出、typed tool 和 fallback

多智能体系统不能只靠自然语言串联。MAS 要求关键角色通过 typed tool 提交结构化结果：

| 阶段 | typed tool | 关键字段 |
| --- | --- | --- |
| HA 路由 | `ha_decision` | `next_action`、`response`、`acceptance_contract`、`rationale` |
| Ego 执行 | `ego_result` | `status`、`summary`、`final_response`、`evidence`、`changed_files`、`verification`、`risks` |
| Superego 评审 | `superego_review` | `blocking_issues`、`quality_score`、`next_action`、`evidenceQuality`、`remainingUncertainty`、`critique_items` |
| HA 终验 | `ha_final_review` | 与评审同构，但代表用户最终验收 |

实现机制：

1. Pi SDK 注册自定义 typed tools。
2. prompt 要求角色最终必须调用对应 typed tool。
3. MAS 捕获 typed tool 参数。
4. 如果模型没有成功调用 typed tool，MAS 尝试从文本中抽 JSON。
5. MAS 执行业务 schema 校验。
6. 校验失败时，MAS 用 repair prompt 要求模型把原意改写成合法结构。
7. repair 仍失败时，MAS 生成受控失败结果，而不是把坏 JSON 原样当作结论。
8. 对 HA 终验和 Superego 还有额外 gate：空摘要、零质量分、零证据质量、阻塞问题 accept 等会被拦截。

这就是“模型负责判断，框架负责可解析和可追溯”的边界。

## 7. 控制论视角：MAS 是闭环控制系统

可以把 MAS 看成一个控制系统：

| 控制论概念 | MAS 对应物 |
| --- | --- |
| 目标值 / setpoint | 用户目标 + HA 验收合同 |
| 执行器 / actuator | Ego |
| 被控对象 / plant | 工作区、代码、文件、数据、外部系统 |
| 传感器 / sensor | 工具返回、测试、文件 diff、AuditPacket、只读复算 |
| 控制器 / controller | MAS runner 状态机 |
| 负反馈 / negative feedback | Superego / HA 返回 revise，驱动 Ego 返工 |
| 扰动 / disturbance | ContextPerturbation、随机样本、外部检索候选、反事实问题 |
| 饱和 / saturation | 最大迭代轮次、权限边界、时间/命令超时 |
| 稳定性约束 | 结构化输出、审计门禁、权限审批、上下文压缩 |

自主性的核心不是无限行动，而是在反馈闭环中持续降低误差。

## 8. 信息熵理论：降低不确定性，而不是追求更多文字

项目里的“信息熵”不是数学公式秀，而是工程启发：

- 高熵：目标不清、证据不足、多个解释都可能、模型自报和审计冲突。
- 低熵：关键假设被证据支持、验证能证伪主要风险、剩余不确定性可解释。

MAS 在多个位置显式记录不确定性：

- `entropyDelta`：本轮证据让不确定性升高、降低还是不变。
- `evidenceQuality`：证据质量。
- `remainingUncertainty`：剩余不确定性。
- `nextBestObservation`：下一步最能降低不确定性的观察。
- `LowEntropySignal`：测试结果、审计发现、用户反馈、外部事实等低熵信号。
- `EntropyLedger`：把 open questions、evidence score、risk score、information gain 结构化。

这带来一个重要原则：

> 最好的下一步不是“多想一会儿”，而是做一个低成本、高信息增益、能证伪关键假设的观察。

## 9. Tool-MAD 思想：异质工具让系统跳出固定吸引子

传统 Multi-Agent Debate 容易出现一个问题：多个 agent 使用相似模型、相似上下文、相似工具时，表面上在争论，实际上共享同一个错误吸引子。它会把“同一种错的重复确认”误当作“多个视角达成一致”。

Tool-MAD 的核心观点是：debate 本身不够，必须让不同 agent 使用不同外部工具和证据通道，并根据对方论点动态提出下一轮查询。论文中的两个 agent 分别使用 RAG 和 Search API，Judge 不只看谁说得像，还引入 faithfulness 和 answer relevance 作为稳定性信号。

论文给出的关键数据：

| 实验结论 | 数据 | 对 MAS 的启发 |
| --- | --- | --- |
| Tool-MAD 在 4 个事实核验基准上超过 MAD 和 MADKE | 最高比 MADKE 提升 5.5%，比 MAD 提升约 35% | 只让 agent 互相说服不够，要让它们拿到不同证据 |
| GPT-4o-mini backbone 下，Tool-MAD 平均分高于 MADKE 和 MAD | Tool-MAD 平均 71.0，MADKE 平均 68.0，MAD 平均 52.9 | 小模型也能通过工具异质性提高可靠性 |
| Llama-3.3-70B backbone 下，Tool-MAD 继续领先 | Tool-MAD 平均 74.0，MADKE 平均 56.5，MAD 平均 45.9 | 不是单一模型能力导致，框架设计本身有效 |
| 异质工具组合优于同质组合 | RAG+Search 在 FEVER / FEVEROUS / FAVIQ / AVERITEC 上为 73.0 / 71.5 / 77.5 / 62.0 | MAS 不应让 HA、Ego、Superego 都使用同一套证据入口 |
| 动态 query formulation 带来增益 | FEVEROUS +2.5，FEVER +2.0，AVERITEC +1.0 | Superego 的批注应转化为下一轮可验证问题 |
| stability score feedback 有效 | FAVIQ 最大提升 +4.5 | evidenceQuality、remainingUncertainty 不应只是展示字段，应进入门禁 |

参考：Seyeon Jeong、Yeonjun Choi、JongWook Kim、Beakcheol Jang，*Tool-MAD: A Multi-Agent Debate Framework for Fact Verification with Diverse Tool Augmentation and Adaptive Retrieval*，arXiv:2601.04742，2026-01-08。

## 10. 异质性隔离

异质性不是“多几个 agent”，而是让错误不再强相关。一个系统如果所有角色使用同一模型、同一上下文、同一工具、同一证据优先级，那么它只是把同一个判断重复三遍；真正有价值的异质性，是让不同角色从不同约束、证据和责任出发，形成可交叉验证的视角。

MAS 的异质性体现在 6 层：

| 维度 | HA | Ego | Superego |
| --- | --- | --- | --- |
| 组织角色 | 用户代理、路由、合同、终验 | 执行者 | 系统审计 Critic |
| 模型策略 | AionUI 会话模型或 `MAS_HA_MODEL` | Pi 默认或 `MAS_EGO_MODEL` | Pi 默认或 `MAS_SUPEREGO_MODEL` |
| 工具边界 | 只读 intake、近期活动、记忆、外部检索/读取、终验复算 | 工作区读写、bash、记忆候选 | AuditPacket、只读检查、近期活动、记忆、只读 bash |
| 证据来源 | 用户请求、本地事实、外部来源、终验证据 | 工作区文件、命令结果、任务产物、历史经验候选 | Ego 输出、AuditPacket、只读复算、反事实样本 |
| 上下文边界 | 同会话历史、skills、合同输入、终验证据 | 同会话历史、合同、上一轮批注、Ego 自身摘要 | 同会话历史、合同、Ego 输出、AuditPacket |
| 终止权 | 能最终 answer / clarify / accept / escalate | 只能上报执行状态 | 只能评审，escalate 是内部信号 |

项目中的具体体现：

- HA 可以使用外部检索和外部 URL 读取，用于补充公开事实和论文来源；Ego 默认不能使用这些工具，避免执行层扩大任务边界。
- Ego 可以使用工作区写入、编辑和命令执行工具，负责真实交付；HA 和 Superego 不应该替它完成任务。
- Superego 只读审计和复算，优先寻找“看起来合理但实际错误”的口径风险。
- AuditPacket 高于 Ego 自报，避免执行者用总结覆盖实际工具行为。
- AionUI 会话模型选择只作用于 HA，让终验天然具备用户代理视角的异质 Critic 能力。
- 只有 HA 终验能把任务结束为真正需要人工介入，Ego 和 Superego 的未完成信号只是内部控制流。

这种隔离的目标可以概括为一句话：

> 跳出固定吸引子，但仍受合同、权限、审计和当前证据约束。

## 11. 弗洛伊德心理学模型：LLM + Ego + Superego

MAS 中的心理模型是隐喻，不是运行时术语硬注入。

可以这样理解：

- 原始 LLM 能力类似“本我”：会自然产生候选解释、直觉路径、捷径和欲望式完成冲动。它很有创造力，但也会幻觉、偷懒、套模板。
- Ego 是现实执行面：把候选想法放到当前文件、数据、工具、权限和用户目标中检验，做真实交付。
- Superego 是约束和反思面：发现“看起来完成但真实理解错了”的情况，提出反事实问题和审计约束。

组织角色 HA 不属于这个心理三面模型。HA 是面向用户的组织层角色：理解任务、生成合同、代表用户验收。

为什么 prompt 中不反复写“本我/自我/超我”？

因为角色名和心理术语容易互相污染。运行 prompt 更适合写成中性工作人格：

- 原始模型能力会产生候选解释，但候选不是事实。
- 执行者要把候选放进现实证据中检验。
- 评审者要优先找“合理但错误”的关键口径。

## 12. 各 agent 的职责分工

### HA：Human Assistant / 用户代理

HA 的核心不是“干活”，而是代表用户建立正确目标和最终验收。

HA 路由阶段：

- 判断直接回答、澄清还是执行。
- 简单问答直接 answer。
- 执行类任务生成合同。
- 对本地任务说明、README、数据目录、模板目录做只读 intake。
- 对外部事实、论文、版本、标准做外部检索/读取。

HA 终验阶段：

- 独立检查用户真实目标是否满足。
- 抽样核对 Ego 输出和 Superego 结论。
- 决定 accept、revise 或真正 escalate。

### Ego：执行者

Ego 的核心是交付真实结果。

它应该：

- 先读上下文，再行动。
- 抵抗轻率假设。
- 贴合当前项目和既有模式。
- 做垂直闭环，而不是铺空架子。
- 对高风险口径形成假设清单。
- 运行能证明真实能力的验证。
- 用 `ego_result` 报告证据、改动、验证和风险。

Ego 不应该：

- 主动把任务拆给未来轮次。
- 用“预算有限”缩小交付范围。
- 把文件存在、结构一致当成高风险业务任务的充分证据。
- 编造外部事实或历史运行状态。

### Superego：系统审计 Critic

Superego 的核心是证伪。

它应该优先问：

1. Ego 最可能在哪个地方被原始模型能力带偏？
2. 哪个用户口径如果错了，结果会看起来合理但实际错误？
3. Ego 的验证是在证明“文件像结果”，还是证明“口径被正确实现”？
4. 是否存在一个低成本样本可以证伪 Ego 的理解？

Superego 的证据优先级：

```text
用户真实目标
  > HA 验收合同
  > AuditPacket
  > 当前文件/工具证据
  > Ego 自报
```

Superego 不能修改文件，只能只读检查、审计、抽样和返回评审。

## 13. 软件代码和提示词的职责边界

这是项目最重要的工程经验之一。

### 13.1 软件框架负责确定性

这些事情必须由代码保证：

- ACP 协议兼容。
- session 生命周期。
- request 生命周期。
- 权限审批和默认策略。
- 角色工具白名单。
- typed tool schema。
- JSON parse 和 repair。
- 业务 schema 校验。
- run / agent_run / approval / audit / event 持久化。
- AuditPacket 构造。
- 审计门禁。
- 最大迭代轮次。
- bash 默认超时。
- context 压缩和恢复。
- Experience Graph 和 autonomy job 调度。

不能把这些交给模型“自觉遵守”。

### 13.2 Prompt 负责稳定工作人格

Prompt 应该负责：

- 身份和职责。
- 判断气质。
- 工具纪律。
- 证据标准。
- 工作品味。
- 默认倾向。
- 收口方式。

Prompt 不应该负责：

- 强行模拟状态机。
- 记住所有一次性 bug 补丁。
- 硬编码某个历史业务词。
- 替代权限系统。
- 替代 schema 校验。
- 替代审计门禁。

一句话：

> 框架负责“不能错”的边界，prompt 负责“默认怎么判断更像靠谱的人”。

## 14. 各 agent 的上下文管理

### 14.1 进入所有角色的共同上下文

MAS 会把同一 AionUI session 的历史摘要和最近对话合成进当前任务：

```text
以下是同一 AionUI 会话的历史对话……
已压缩的早期上下文摘要……
最近历史对话……
当前 Pi 可发现的技能摘要……
当前用户请求……
```

因此：如果任务进入 Ego / Superego，它们也能间接看到同一 AionUI 会话历史。

### 14.2 不会复用 Pi 自己的完整对话

每次角色调用都会新建 Pi in-memory session，用完 dispose。

这意味着：

- HA 不会自动拿到“上一次 HA Pi session 的完整消息”。
- Ego 不会自动拿到“上一次 Ego Pi session 的完整消息”。
- Superego 不会自动拿到“上一次 Superego Pi session 的完整消息”。

长期会话语义由 MAS 持久化和显式注入负责，而不是 Pi session 自己负责。

### 14.3 Ego 的额外上下文

Ego 额外会拿到同一 AionUI 会话中 Ego 之前的执行摘要：

- 取同 session 之前 Ego agent_run 最近 4 条。
- 加上当前 run 内 Ego 最近 6 条。
- 渲染后最多约 6000 字符。

这用于避免 Ego 重复返工，不是新用户指令。

### 14.4 Superego 和 HA 的角色历史

HA 和 Superego 当前没有“自己历史摘要”自动注入。

它们可以通过工具查询：

- HA：`mas_query_recent_activity`、`mas_query_memory`。
- Superego：`mas_query_recent_activity`、`mas_query_memory`。

但是工具结果是显式查询，不是自动上下文。

### 14.5 AionUI 可见展示不是上下文

AionUI 会显示：

- agent message
- thought
- tool call
- tool result
- 模型配置展示

这些展示事件不会自动成为下一轮 prompt 上下文。MAS 只把用户消息、最终 MAS 回复、会话摘要和结构化运行记录持久化为可复用上下文。

## 15. Prompt 最佳实践

### 15.1 学 Codex，不学补丁墙

Codex prompt 的核心不是列出无穷规则，而是塑造稳定工作人格：

- 先定义身份和判断气质。
- 再定义工程判断。
- 再定义工具使用。
- 再定义编辑约束。
- 再定义持续推进。
- 最后定义沟通方式。

对应到 MAS，prompt 应该让 agent 拥有稳定倾向：

- 先读上下文。
- 抵抗轻率假设。
- 贴合现有系统。
- 证据高于自报。
- 用户真实目标高于流程闭环。
- 关键口径高于输出结构。
- 能证伪的抽样高于自洽检查。
- 当前回合能推进就推进。

### 15.2 Prompt 结构模板

一个好的 agent prompt 通常包含：

1. 角色身份：你是谁，不是谁。
2. 工作人格：你默认如何判断。
3. 职责边界：你负责什么，不负责什么。
4. 工具纪律：什么时候用工具，什么时候不能用。
5. 证据标准：什么证据足以支持结论。
6. 动态上下文：当前任务、合同、批注、AuditPacket、扰动。
7. 最终动作：必须调用哪个 typed tool。
8. 输出约束：不要普通文本，不要手写 JSON，不要暴露不必要内部细节。

### 15.3 反例：补丁式 prompt

不推荐：

```text
如果是 Excel，必须兼容 Mac 和 Windows。
如果是奖金包，要注意全国值。
如果是分母，要特别检查。
如果看到 output 目录，就必须写 output。
如果 superego escalate，就继续跑。
```

问题：

- 这些规则来自具体事故，很容易过拟合。
- 会让模型在不相关场景误触发。
- 会污染基础 prompt。
- 会让真正的系统边界变得不清楚。

### 15.4 推荐：人格式 prompt

推荐：

```text
对高风险数据、表格、报表、配置迁移和接口兼容任务，
先形成实现假设清单，覆盖字段/格式约束、映射关系、
计算基准、时间范围、单位换算、缺失/异常处理、适用范围和 fallback 判断。

验证要优先证明真实能力，而不是证明文件像结果。
数据和报表任务优先做可证伪抽样和关键公式复算。
```

这个写法不是针对某个 Excel bug，而是泛化到所有结构化数据任务。

### 15.5 反事实扰动也要泛化

不推荐把历史案例写死：

```text
检查全国值不能直接用。
检查分母是否错误。
```

推荐写成问题形态：

```text
字段/格式约束是否错读？
映射关系是否错配？
计算基准是否错用？
时间范围或单位是否错换？
缺失/异常是否被静默替代？
适用范围是否被扩大或缩小？
```

Superego 再把这些泛化问题改写成当前领域的反事实问题。

### 15.6 Prompt 和技能的边界

基础 prompt 不应该塞领域细节。例如：

- Excel / Office 兼容性。
- Mac / Windows 文件格式细节。
- 某类业务报表公式。
- 某个第三方平台 API 特例。

这些更适合通过 skill、任务上下文、只读 intake 或外部检索按需注入。

基础 prompt 只保留长期稳定原则：

- 先读上下文。
- 保持边界克制。
- 做真实闭环。
- 证据优先。
- 高风险任务做可证伪验证。

## 16. 经验总结

### 16.1 多 agent 的关键不是“多”

如果 3 个 agent：

- 看同样上下文；
- 用同样工具；
- 采用同样模型；
- 没有审计证据；
- 只互相复述；

那它们不是多智能体，只是重复调用。

真正有效的多 agent 需要：

- 不同角色目标。
- 不同工具集合。
- 不同证据通道。
- 不同终止权。
- 不同上下文。
- 框架级审计和门禁。

### 16.2 自主性来自闭环，不来自放权

AI 自主性不是“给模型更多权限”，而是：

```text
目标 -> 行动 -> 观察 -> 评审 -> 返工 -> 验收 -> 经验沉淀
```

每一环都要可追溯。

### 16.3 用户真实目标高于流程完成

系统最容易犯的错是“流程闭环了，但目标错了”。

所以评审标准必须始终是：

- 用户真实目标高于 Ego 自报。
- AuditPacket 高于 Ego 自报。
- 关键业务口径高于输出结构。
- 能证伪的抽样高于自洽检查。
- 证据不足时不能为了流程闭环而 accept。

### 16.4 软件框架和 prompt 要相互克制

框架不要把所有判断写死成规则，否则系统无法泛化。

Prompt 不要承担确定性职责，否则系统不可审计。

最好的边界是：

- 代码保证生命周期、权限、schema、审计、门禁、存储。
- Prompt 塑造人格、判断品味、工具纪律和证据标准。
- Skill 承载领域知识和可复用工作流。
- Experience Graph 承载长期经验。

## 17. 可以带走的设计原则

1. 把 agent 看成组织，而不是函数调用。
2. 先设计证据流，再设计对话流。
3. 合同是用户意图到可执行任务的接口。
4. Critic 必须有不同证据，不然只是复述。
5. Prompt 要塑造人格，不要堆补丁。
6. 上下文要显式、可压缩、可追溯。
7. 结构化输出必须有 schema、repair 和 gate。
8. 审计证据必须能覆盖模型自报。
9. 外部检索是异质视角，不是权威结论。
10. 自主性要有能量预算和熵下降目标。

## 18. 代码阅读地图

| 主题 | 文件 |
| --- | --- |
| ACP server 和 session 生命周期 | `src/acp/server.ts` |
| AionUI 流式展示和权限请求 | `src/acp/acp-sink.ts` |
| HA / Ego / Superego 状态机 | `src/core/runner.ts` |
| 基础 prompt 和 repair prompt | `src/core/prompts.ts` |
| AuditPacket 和审计门禁 | `src/core/audit.ts` |
| 上下文扰动 | `src/core/context-perturbation.ts` |
| Experience Graph 和自主闭环 | `src/core/autonomy.ts` |
| 信息熵 ledger 和低熵信号 | `src/core/entropy.ts` |
| Pi SDK 角色 session 和工具隔离 | `src/pi/pi-sdk.ts` |
| SQLite schema 和上下文压缩 | `src/storage.ts` |
| 架构权威文档 | `docs/ARCHITECTURE.md` |
| Prompt 权威文档 | `docs/AGENT_PROMPTS.md` |
| AionUI 接入和模型配置 | `docs/AIONUI.md` |
| 自主性设计 | `docs/AUTONOMY.md` |
