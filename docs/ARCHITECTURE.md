# MAS 系统架构

本文是 MAS 当前架构的权威说明。运行配置见 [AIONUI.md](AIONUI.md)，提示词维护见 [AGENT_PROMPTS.md](AGENT_PROMPTS.md)，自主调度细节见 [AUTONOMY.md](AUTONOMY.md)，路线图见 [ROADMAP.md](ROADMAP.md)。

## 系统定位

MAS 是系统化多智能体执行与自主改进系统。它通过 ACP 接入 AionUI，以 Pi SDK 作为内部 agent runtime，目标是提供可审计、可验收、可持续改进的 coding agent 编排能力。

MAS 的核心不是多个模型轮流发言，而是让不同角色持有不同职责、权限、证据通道和验收门禁：

- 用户请求由 HA 接收和解释。
- 实际工作由 Ego 执行。
- 系统级风险由 Superego 审计。
- 用户代理终验仍由 HA 完成。
- 任务后的经验、反思、Dream 和候选晋升由自主性机制处理。

## 理论来源与设计转译

MAS 不是对任一理论的机械复刻，而是把心理结构、反馈控制、信息不确定性、组织协作和异质工具研究转译为可运行的软件架构。引用原文用于固定设计来源；真正约束实现的是原文之后列出的 MAS 设计含义。

### Freud：Id、Ego 与 Superego

Freud 在 *The Ego and the Id* 中写道：

> “The ego represents what may be called reason and common sense, in contrast to the id, which contains the passions.”

原始来源：Sigmund Freud，*The Ego and the Id*，1923，1927 年英译本，https://www.freudedition.net/en/werke/ego-and-id/druckschrift-1。

MAS 借用的是相互作用的心理结构，而不是临床心理学结论：

- Id 对应模型尚未被现实约束筛选的生成势能、联想、欲望和候选路径；它不是独立对外执行角色。
- Ego 是现实原则下的行动者，把候选路径放进当前任务、工具、权限、成本和外部世界中检验，并承担真实交付责任。
- Superego 是内化规范、长期价值和自我审查机制，对 Ego 的行动进行约束、证伪和反思，但不能脱离现实证据追求抽象完美。
- Dream 允许在低权限环境中重组经验、释放固定模式和生成新候选，但不能直接写用户工作区或向用户交付结论。

因此，Ego 和 Superego 不是两个轮流说话的模型，而是同一智能系统中现实行动与规范反思的两个运行面。任何一方失去另一方都会退化：只有 Ego 容易短视和合理化，只有 Superego 容易停滞、苛责和脱离交付。

### 控制论：反馈、稳定与调节

Ashby 转述 Wiener 对控制论的定义：

> “the science of control and communication, in the animal and the machine”

Ashby 进一步提出必要多样性定律：

> “variety can destroy variety.”

原始来源：W. Ross Ashby，*An Introduction to Cybernetics*，1956，第 1/1、11/7 节，https://ashby.info/Ashby-Introduction-to-Cybernetics.pdf；Norbert Wiener，*Cybernetics: Or Control and Communication in the Animal and the Machine*，1948，https://direct.mit.edu/books/oa-monograph/4581/Cybernetics-or-Control-and-Communication-in-the。

MAS 把一次任务视为闭环调节过程，而不是一次性文本生成：用户目标和验收合同定义期望状态，Ego 行动改变环境，工具结果、验证、AuditPacket 和用户反馈构成观测，Superego 与 HA 根据误差决定接受、返工、换路或升级。系统必须通过反馈修正行为，不能只依赖初始计划。

必要多样性意味着，复杂任务产生的扰动越多，调节器就越需要足够的模型、角色、工具、证据通道和策略多样性。异质性不是装饰，也不是无条件增加 agent 数量；它用于覆盖单一模型、单一工具和单一视角无法吸收的问题多样性。

### 信息论：熵、不确定性与信息增益

Shannon 用概率分布定义信息源的不确定性：

> “H = - K Σ pᵢ log pᵢ”

原始来源：Claude E. Shannon，*A Mathematical Theory of Communication*，1948，https://doi.org/10.1002/j.1538-7305.1948.tb00917.x。

MAS 使用“熵”作为工程上的不确定性视角，而不是声称当前评分已经等同于严格的 Shannon entropy：

- Agent 应优先选择最可能降低关键不确定性的下一步观察或行动。
- 测试、复算、schema、权威来源、用户反馈和生产信号只有在改变可行解释集合时才产生信息增益。
- 重复同一推理、同一工具和同一失败路径而没有新增证据，不属于自主改进。
- `EntropyLedger`、evidence score 和 information gain 当前是可审计启发式量，应通过校准和回归数据逐步逼近可靠指标，不能把人为权重伪装成自然定律。

### 组织模型：把 Agent 当作人来组织

MAS 把 Agent 视为具有能力、性格、注意力、经验、工具、权限和责任边界的“人”，而不是无状态函数。系统能力来自组织，而不只来自最强的单个模型。

用户与 MAS 是上级和下属关系：HA 代表整个 MAS 对用户负责。好的下属应站在上级目标和整体利益上思考，在授权范围内自主判断、协调资源并完成结果；只有目标冲突、重大取舍、权限或凭据缺失、不可逆高风险等关键问题才向用户报告和确认。内部角色分歧、普通失败、工具选择和可自动解决的环境问题应由 MAS 内部消化，不能轻易转嫁给用户。

组织化设计要求：

- 责任与权力匹配：执行者有行动工具，审计者有独立证据，最终负责人有验收和升级权。
- 汇报面向上级价值：报告目标完成度、关键证据、风险和需要决策的事项，不倾倒内部流水账。
- 授权内自主：框架给出边界、预算和问责机制，不用僵硬 SOP 替代人的判断。
- 关键问题升级：只有超出授权或需要上级偏好取舍时才请求用户；“我遇到困难”本身不是升级理由。
- 组织学习：个人经验进入 Experience Graph，经反思、验证和晋升后成为组织能力，而不是停留在单次会话。

### 异质模型、异质工具与 Tool-MAD

Tool-MAD 指出传统多智能体辩论主要依赖模型内部知识或静态文档，并提出：

> “assigning each agent a distinct external tool”

原始来源：Seyeon Jeong、Yeonjun Choi、JongWook Kim、Beakcheol Jang，*Tool-MAD: A Multi-Agent Debate Framework for Fact Verification with Diverse Tool Augmentation and Adaptive Retrieval*，arXiv:2601.04742，2026-01-08，https://arxiv.org/abs/2601.04742。

论文名称是 Tool-MAD；MAS 在此基础上做组织化扩展：异质性可以来自不同模型、角色人格、上下文、工具、数据源、权限和评价标准。目标不是制造表面分歧，而是让不同角色拥有真实不同的观察能力和盲区，并由 HA/Superego 对证据相关性、忠实度和任务目标进行裁决。

### 外部知识：避免闭门造车

ReAct 强调行动让模型能够连接知识库或环境并获取新信息：

> “actions allow it to interface with external sources”

原始来源：Shunyu Yao 等，*ReAct: Synergizing Reasoning and Acting in Language Models*，ICLR 2023，https://arxiv.org/abs/2210.03629。

MAS 把互联网和外部知识视为组织的感知器官，而不是可选装饰。当任务依赖最新信息、第三方协议/版本/论文/标准、公开事实，或遇到很可能已有行业经验的通用难题时，应主动检索并阅读原始来源，复用外部世界已经验证的知识。闭门实现前，应先判断问题是否具有公共性和时效性。

外部信息仍需治理：搜索摘要只是线索，关键结论必须核对原文、记录来源和时间，并与当前工作区证据交叉验证。互联网用于扩大可观察世界和降低不确定性，不能覆盖用户目标、权限边界或确定性审计门禁。

### 工程边界

这些理论提供判断框架，不应退化为术语装饰或写死逻辑：

- 心理学隐喻不能替代明确的角色权限、上下文和状态机。
- 控制论不能退化为固定次数重试；反馈必须能够改变下一步策略。
- 信息熵不能退化为未经校准的单一分数；必须保留原始证据和不确定性来源。
- 异质性不能退化为给同一模型换角色名；应产生真实不同的能力、信息或评价视角。
- 外部检索不能退化为关键词正则触发；应基于信息时效性、知识缺口、问题公共性和预期信息增益判断。
- 正则、白名单和启发式只能作为风险信号或有限协议适配，不能承担开放语义理解和最终安全证明。

## 角色边界

| 角色 | 责任 | 工具与证据边界 |
| --- | --- | --- |
| HA | 面向用户，负责路由、澄清、只读 intake、验收合同、最终用户验收和交叉验证 | 路由阶段使用 MAS 记忆、近期活动、外部检索/读取、工作区只读工具、自动授权只读 `bash` 和 `ha_decision`；终验阶段继续拥有工作区只读工具和自动授权 `bash`，用于独立抽样复算和 `ha_final_review` |
| Ego | 执行者，负责读取、编辑、运行命令、产出结果和验证记录 | 工作区读写、命令执行、`mas_query_memory`、`ego_result`；不拥有 MAS 近期活动或外部检索工具 |
| Superego | 系统审计 Critic/Judge，负责基于 AuditPacket artifact、只读检查和历史风险评审 Ego 输出 | AuditPacket artifact 摘要和按需读取工具、只读工作区检查、MAS 记忆/近期活动、自动授权 `bash` 只读复算、`superego_review` |
| Id / Dream | 低权限经验重组和裁剪 | 只操作 Experience Graph，不写用户工作区，不执行外部工具 |

HA 和 Superego 都是 Critic，但视角不同：HA 代表用户验收交付价值和真实意图，Superego 代表系统审计边界和证据一致性。只有 HA 终验可以把 run 结束为真正需要用户人工介入；Ego 的 `needs_attention/blocked` 和 Superego 的 `escalate` 都只是内部未完成或升级信号。

AionUI 中会展示 HA、Ego、Superego 的流式文本、思考、工具调用和工具返回，工具标题带角色前缀，便于用户追踪组织协作过程。展示层不等于上下文层：MAS 只把用户消息和最终 MAS 结果写入会话记忆；HA、Ego、Superego 的 Pi session 彼此隔离，后续角色只能看到 MAS 框架显式注入给它的任务、验收合同、Ego 输出、Superego 评审、AuditPacket artifact 摘要、会话摘要或工具查询结果。

Ego 和 Superego 也对应单个 LLM agent 的两个运行面：Ego 是现实执行面，负责把候选想法落到当前证据和工具结果；Superego 是约束和反思面，负责证伪、审计和发现低确定性区域。基础 prompt 不在共享层同时注入心理学术语，避免角色名和隐喻互相污染。

## 执行链路

一次用户请求的主链路：

1. AionUI 通过 ACP 调用 MAS。
2. MAS 恢复 `sessionId` 对应的会话摘要、最近消息、技能摘要和运行配置。
3. MAS 为 HA 准备中性的 run 管理上下文，例如同一 session/工作目录下未收口的 running run、最后审计事件和最近角色摘要。该上下文只是事实证据，不是路由结论。
4. HA 先生成结构化路由意图 `intent_type`：`conversation`、`status_query`、`read_only_analysis` 或 `execution_task`。对话、状态查询和只读分析由 HA 直接处理；只有 `execution_task` 可以进入 Ego。
5. 对 `execution_task`，HA 进入执行前可做本地只读 intake，读取用户明确给出的任务说明、需求文档、目录结构、表头、配置或代码上下文，并生成验收合同，包含用户目标、边界、关键口径、证据和验收建议。HA 初始合同和后续 `continue` 合同都必须通过 AionUI 可见消息展示，不能只留在 `agent_runs` JSON 中。
6. MAS 生成边界 baseline snapshot。
7. Ego 按验收合同执行任务，提交 `ego_result`。
8. MAS 将完整 AuditPacket 持久化为 run artifact，并向 Superego 注入摘要、索引和关键风险。
9. Superego 基于 Ego 结果、AuditPacket artifact 摘要和按需读取的审计 section 做系统审计评审。
10. HA 基于用户意图、Ego 结果、Superego 结论、AuditPacket artifact、只读抽样和必要外部检索做最终验收。
    - `accept`：当前合同通过，run 可以结束。
    - `continue`：当前合同通过，但用户已授权连续推进且下一阶段足够明确；HA 在 `ha_final_review` 中产出下一轮 `next_acceptance_contract` 和边界数组，MAS 将合同显示到 AionUI 并继续启动 Ego 执行。
    - `revise`：仍可自动返工，继续交给 Ego。
    - `escalate`：只有 HA 判断确实需要用户介入时才面向用户结束。
11. MAS 将 run、agent_run、approval、audit、events、Experience Graph 和低熵信号写入 SQLite。
12. Autonomy daemon 后续处理 reflection、dream、prune、consolidation 和 goal_continuation。

Ego 如果上报 `needs_attention` 或 `blocked`，MAS 不会直接向用户结束为人工介入，而是把它转成内部返工/验收信号。Superego 如果返回 `escalate`，MAS 也不会直接结束，而是先交给 HA 终验裁决；只有 HA 确认需要用户补充需求、确认取舍、提供外部凭据/权限，或系统轮次上限耗尽且无自动推进路径时，run 才进入用户可见的 `needs_attention`。当 HA 终验返回 `continue` 时，当前合同被视为已通过，但 run 不结束；MAS 用 HA 提供的下一轮合同重建边界 snapshot 并继续执行。

Ego 未提交 `ego_result` 且没有可解析 JSON 时，MAS 将其识别为执行层结构化输出失败，而不是可供 Superego 审计的业务结果。该类失败默认直接打回 Ego；连续 3 轮仍失败时，MAS 跳过 Superego 并交给 HA 判断是否需要人工介入或恢复执行后端。

未启用 Superego 的 `ha-ego` 模式仍保留 HA 终验；只是跳过系统审计评审和返工环节。

## 异质工具与 Tool-MAD

MAS 当前采用角色异质工具分工：

- Ego 负责行动工具，拥有工作区读写、命令执行和按需查询 Experience Graph 历史经验的能力；不查询 MAS 近期活动或外部检索，避免执行层用跨 run 状态或外部信息扩大任务边界。
- Superego 负责系统审计工具，依赖 AuditPacket artifact、只读工作区检查、MAS 内部运行事实和自动授权只读命令抽样复算。
- HA 负责用户代理 intake 和验收工具，拥有外部检索工具 `mas_external_search`、外部读取工具 `mas_external_read`、工作区只读工具和自动授权只读 `bash`。路由阶段的本地工具只用于理解用户任务和生成更可靠的合同，不用于提前完成交付。

这个设计借鉴前述 Tool-MAD 的异质外部工具思想，并把异质性扩展到模型、组织角色、权限、上下文和评价视角。

`mas_external_search` / `mas_external_read` 的结果只是候选证据，不能覆盖用户目标、验收合同、当前仓库证据、AuditPacket 或确定性审计门禁。HA 采用外部结果时必须保留来源、检索/读取时间和交叉验证依据。

## 模型选择策略

模型选择遵循角色隔离：

- AionUI 会话模型选择只作用于 HA，用于形成用户代理验收视角。
- `MAS_HA_MODEL` 优先级高于 AionUI 会话模型。
- Ego 未配置 `MAS_EGO_MODEL` 时直接使用 Pi 默认模型。
- Superego 未配置 `MAS_SUPEREGO_MODEL` 时直接使用 Pi 默认模型，不探测其他模型。
- 显式配置的角色模型不可用时，MAS 回退 Pi 默认模型，并在 ACP metadata 和 MAS event 中记录 warning。
- `session/new` 和 `session/load` 会向 AionUI 以普通可见消息展示一次 `MAS 会话开始：角色模型配置`，用于让用户看到 HA / Ego / Superego 的实际模型分工；该展示事件不写入会话历史，也不进入角色 Pi session 上下文。

## 记忆与外部证据

MAS 不默认把历史经验和近期活动注入所有 agent 上下文，而是按角色提供只读查询工具：

- `mas_query_memory`：查询 Experience Graph 历史经验候选。
- `mas_query_recent_activity`：查询 `runs/agent_runs` 近期运行事实。
- `mas_external_search`：HA 专属外部检索工具。
- `mas_external_read`：HA 专属外部 URL 读取工具，用于核对搜索候选或用户给定 URL 原文。
- `mas_read_run_artifact`：HA 终验和 Superego 评审可用的当前 run artifact 读取工具，用于按需读取 AuditPacket section。

HA 可以使用 `mas_query_memory`、`mas_query_recent_activity`、`mas_external_search`、`mas_external_read`、`mas_read_run_artifact`、工作区只读工具和自动授权只读 `bash` 完成路由、状态回答、合同前 intake 和最终用户验收。Superego 可以使用 `mas_query_memory`、`mas_query_recent_activity`、`mas_read_run_artifact`、工作区只读工具和自动授权 `bash` 辅助系统审计，但不能覆盖 AuditPacket artifact。Ego 可以使用 `mas_query_memory` 查询 Experience Graph 历史经验候选，用于吸取过往踩坑和相似失败模式；Ego 不拥有 `mas_query_recent_activity`、`mas_read_run_artifact`、外部检索或外部读取工具，避免执行层扩大任务边界。

Ego 的 Pi session 仍按 MAS 角色隔离创建，但 MAS 会在 Ego prompt 中注入同一 AionUI 会话内 Ego 之前的执行上下文摘要。该摘要只用于保持执行连续性和避免重复返工，不是新用户指令；若与当前用户目标、HA 验收合同、Superego/HA 批注或当前文件证据冲突，以后者为准。

所有检索结果都不是权威事实，采用前必须结合当前任务证据、AuditPacket artifact、用户目标和验收合同交叉验证。

## Bash 超时策略

MAS 覆盖 Pi SDK 的内置 `bash` 工具，在模型未显式传入 `timeout` 或传入无效值时应用默认超时。当前默认值是 `120` 秒，可通过 `MAS_BASH_DEFAULT_TIMEOUT_SECONDS` 调整。模型显式提供正数 `timeout` 时，MAS 尊重该值。

该策略属于框架确定性保障，不依赖 agent 自觉遵守。基础 prompt 会同步告知 HA、Ego、Superego 默认超时时间，并要求它们根据命令性质按需调大或调小 `timeout`：安装、构建、大型测试和只读复算可以显式加长；快速探测可以缩短；长期服务命令不应作为普通前台命令无限等待，应使用有限超时完成短探活并报告结果。

## 审计与门禁

Superego 不能只依赖 Ego 自报。MAS 在评审前构造完整 AuditPacket，并持久化为当前 run 的 artifact；prompt 只注入摘要、索引、计数和关键风险，Superego/HA 需要核对时通过 `mas_read_run_artifact` 读取具体 section。AuditPacket 包含：

- 审批记录和原始工具输入。
- 写入路径和命令摘要。
- Ego 自报 `changed_files`。
- 写入路径与 `changed_files` 对账。
- 用户/验收合同声明的允许输出边界和只读输入边界的当前状态与历史留痕。
- 边界目录轻量 metadata snapshot/diff。
- `agentHealth` 角色模型健康诊断，包括模型解析结果、空输出、auto retry、typed tool 是否提交和错误事件。
- 面向 Superego 的只读抽样复核建议。

确定性审计门禁高于模型输出。当前仍存在违反允许输出边界、只读输入污染或失败验证伪装成功时，即使模型评审返回 `accept`，MAS 也会强制进入内部 `revise` 或升级信号；真正面向用户的人工介入必须由 HA 终验决定。允许输出边界来自用户任务和 HA 验收合同；未显式要求 `output/` 时，greenfield 项目源码、文档和配置可以写在 workspace 根目录内。

角色模型健康不是技能职责。模型不可用、provider 配置错误、Pi auto retry 后空输出或 typed tool 链路失败时，Ego 本身可能无法调用任何健康检查技能；MAS 框架必须从 Pi/MAS 事件中生成确定性 `agentHealth` 证据，并让 Superego/HA 基于该证据判断是自动恢复、换模型、返工，还是由 HA 代表用户提示人工介入。

HA 路由阶段必须在 `ha_decision` 中给出 `readonly_input_paths` 和 `allowed_output_paths`。MAS 框架负责把这些路径规范化为绝对路径、去重并写入 AuditPacket；后续写入和只读输入检查按规范化路径集合做精确匹配。HA 的文本验收合同用于解释边界意图，但不再作为主要门禁来源。

审计门禁必须按责任归属路由，而不是按 `high` 一刀切打回 Ego。每个高风险 finding 需要能归到 `gateOwner=ego | ha | none`：Ego 可修复的当前产物违规才打回 Ego；合同边界歧义、框架审计矛盾、模型/后端健康问题等不属于 Ego 产物返工责任的问题，在 Superego 原始结论为 accept 时升级给 HA 判断。同一路径同时被声明为只读输入和允许输出只是其中一个实例，MAS 记录 `boundary_declaration_conflict`，但不会要求 Ego 反复修改无关产物。如果只读根目录下显式声明了允许输出子目录，允许输出子目录是只读检查的例外；如果允许输出根目录内另有更具体的只读子目录，该只读子目录仍受保护。

输出边界文本推断只作为旧合同兼容兜底，必须识别明确约束，而不是做宽泛子串匹配。只有独立路径段 `output/`、`./output/`、工作区下的 `output/`，或明确“只能/必须写入输出目录”的语义才会触发 `output_dir` 门禁；`playwright-output/`、`test-output/` 这类工具产物目录名不能被当作 workspace `output/` 硬约束。

## 存储与会话

MAS 是 AionUI 会话一致性的责任方。AionUI 的 `sessionId`、MAS 的 `runId`、Pi 的 role session 是不同概念：

- `sessionId`：用户对话身份，由 AionUI/MAS 共同维护。
- `runId`：一次用户请求对应的 MAS 执行身份。
- Pi session：HA、Ego 或 Superego 在某一轮中的执行实例。

SQLite 当前保存消息、摘要、运行记录、agent_run、approval、audit、events、Experience Graph、低熵信号、候选和自主调度任务。Pi session 使用内存型执行实例，长期会话语义由 MAS 持久化和显式上下文注入保证。AionUI 可见的中间工具流和 agent 思考不会自动成为下一轮 MAS agent 的上下文；需要跨 run 使用的事实必须通过 MAS 存储、AuditPacket artifact、agent_run 结构化输出、会话摘要或显式查询工具进入上下文。

run 管理属于 HA 语义判断和 ACP 生命周期审计的交界面。框架负责记录 `session/prompt` 绑定的 active `runId`、`session/cancel`、`session/close` 和 run 取消结果，并向 HA 注入中性的 `<run_management_context>`；框架不应通过宽泛正则在 HA 之前判断用户是在询问运行事实还是要求继续交付。HA 需要形成 run 连续性判断：当前请求是在了解 MAS/角色/run 的运行事实，延续或纠偏上一项任务，提出新的交付目标，还是讨论系统设计。运行证据只改变 HA 的判断依据和风险模型，不能单独决定路由。

## 当前边界

当前本地系统化阶段暂未包含 Temporal、PostgreSQL、NATS、对象存储、远程控制面和生产级多租户。相关演进见 [ROADMAP.md](ROADMAP.md)。
