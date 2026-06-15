# MAS 系统架构

本文是 MAS 当前架构的权威说明。运行配置见 `docs/AIONUI.md`，提示词维护见 `docs/AGENT_PROMPTS.md`，自主调度细节见 `docs/AUTONOMY.md`，路线图见 `docs/ROADMAP.md`。

## 系统定位

MAS 是系统化多智能体执行与自主改进系统。它通过 ACP 接入 AionUI，以 Pi SDK 作为内部 agent runtime，目标是提供可审计、可验收、可持续改进的 coding agent 编排能力。

MAS 的核心不是多个模型轮流发言，而是让不同角色持有不同职责、权限、证据通道和验收门禁：

- 用户请求由 HA 接收和解释。
- 实际工作由 Ego 执行。
- 系统级风险由 Superego 审计。
- 用户代理终验仍由 HA 完成。
- 任务后的经验、反思、Dream 和候选晋升由自主性机制处理。

## 角色边界

| 角色 | 责任 | 工具与证据边界 |
| --- | --- | --- |
| HA | 面向用户，负责路由、澄清、只读 intake、验收合同、最终用户验收和交叉验证 | 路由阶段使用 MAS 记忆、近期活动、外部检索/读取、工作区只读工具、自动授权只读 `bash` 和 `ha_decision`；终验阶段继续拥有工作区只读工具和自动授权 `bash`，用于独立抽样复算和 `ha_final_review` |
| Ego | 执行者，负责读取、编辑、运行命令、产出结果和验证记录 | 工作区读写、命令执行、`mas_query_memory`、`ego_result`；不拥有 MAS 近期活动或外部检索工具 |
| Superego | 系统审计 Critic/Judge，负责基于 AuditPacket、只读检查和历史风险评审 Ego 输出 | AuditPacket、只读工作区检查、MAS 记忆/近期活动、自动授权 `bash` 只读复算、`superego_review` |
| Id / Dream | 低权限经验重组和裁剪 | 只操作 Experience Graph，不写用户工作区，不执行外部工具 |

HA 和 Superego 都是 Critic，但视角不同：HA 代表用户验收交付价值和真实意图，Superego 代表系统审计边界和证据一致性。只有 HA 终验可以把 run 结束为真正需要用户人工介入；Ego 的 `needs_attention/blocked` 和 Superego 的 `escalate` 都只是内部未完成或升级信号。

AionUI 中会展示 HA、Ego、Superego 的流式文本、思考、工具调用和工具返回，工具标题带角色前缀，便于用户追踪组织协作过程。展示层不等于上下文层：MAS 只把用户消息和最终 MAS 结果写入会话记忆；HA、Ego、Superego 的 Pi session 彼此隔离，后续角色只能看到 MAS 框架显式注入给它的任务、验收合同、Ego 输出、Superego 评审、AuditPacket、会话摘要或工具查询结果。

Ego 和 Superego 也对应单个 LLM agent 的两个运行面：Ego 是现实执行面，负责把候选想法落到当前证据和工具结果；Superego 是约束和反思面，负责证伪、审计和发现低确定性区域。基础 prompt 不在共享层同时注入心理学术语，避免角色名和隐喻互相污染。

## 执行链路

一次用户请求的主链路：

1. AionUI 通过 ACP 调用 MAS。
2. MAS 恢复 `sessionId` 对应的会话摘要、最近消息、技能摘要和运行配置。
3. HA 判断直接回答、澄清或进入执行；进入执行前可做本地只读 intake，读取用户明确给出的任务说明、需求文档、目录结构、表头、配置或代码上下文。
4. HA 生成验收合同，包含用户目标、边界、关键口径、证据和验收建议。
5. MAS 生成边界 baseline snapshot。
6. Ego 按验收合同执行任务，提交 `ego_result`。
7. Superego 基于 Ego 结果和 AuditPacket 做系统审计评审。
8. HA 基于用户意图、Ego 结果、Superego 结论、只读抽样和必要外部检索做最终验收。

Ego 如果上报 `needs_attention` 或 `blocked`，MAS 不会直接向用户结束为人工介入，而是把它转成内部返工/验收信号。Superego 如果返回 `escalate`，MAS 也不会直接结束，而是先交给 HA 终验裁决；只有 HA 确认需要用户补充需求、确认取舍、提供外部凭据/权限，或系统轮次上限耗尽且无自动推进路径时，run 才进入用户可见的 `needs_attention`。
9. MAS 将 run、agent_run、approval、audit、events、Experience Graph 和低熵信号写入 SQLite。
10. Autonomy daemon 后续处理 reflection、dream、prune、consolidation 和 goal_continuation。

未启用 Superego 的 `ha-ego` 模式仍保留 HA 终验；只是跳过系统审计评审和返工环节。

## 异质工具与 Tool-MAD

MAS 当前采用角色异质工具分工：

- Ego 负责行动工具，拥有工作区读写和命令执行能力；不直接查询 MAS 记忆、近期活动或外部检索，避免执行层用历史状态扩大任务边界。
- Superego 负责系统审计工具，依赖 AuditPacket、只读工作区检查、MAS 内部运行事实和自动授权只读命令抽样复算。
- HA 负责用户代理 intake 和验收工具，拥有外部检索工具 `mas_external_search`、外部读取工具 `mas_external_read`、工作区只读工具和自动授权只读 `bash`。路由阶段的本地工具只用于理解用户任务和生成更可靠的合同，不用于提前完成交付。

这个设计借鉴 Tool-MAD 的异质外部工具思想。Tool-MAD 指出，传统 MAD 容易依赖模型内部知识或静态文档；通过为不同 agent 分配不同外部工具，例如 Search API 或 RAG 模块，可以引入多样化证据视角，并提升事实核验鲁棒性。

参考：Seyeon Jeong、Yeonjun Choi、JongWook Kim、Beakcheol Jang，*Tool-MAD: A Multi-Agent Debate Framework for Fact Verification with Diverse Tool Augmentation and Adaptive Retrieval*，arXiv:2601.04742，2026-01-08，https://arxiv.org/abs/2601.04742。

`mas_external_search` / `mas_external_read` 的结果只是候选证据，不能覆盖用户目标、验收合同、当前仓库证据、AuditPacket 或确定性审计门禁。HA 采用外部结果时必须保留来源、检索/读取时间和交叉验证依据。

## 模型选择策略

模型选择遵循角色隔离：

- AionUI 会话模型选择只作用于 HA，用于形成用户代理验收视角。
- `MAS_HA_MODEL` 优先级高于 AionUI 会话模型。
- Ego 未配置 `MAS_EGO_MODEL` 时直接使用 Pi 默认模型。
- Superego 未配置 `MAS_SUPEREGO_MODEL` 时直接使用 Pi 默认模型，不探测其他模型。
- 显式配置的角色模型不可用时，MAS 回退 Pi 默认模型，并在 ACP metadata 和 MAS event 中记录 warning。
- `session/new` 和 `session/load` 会向 AionUI 展示一次 `MAS 角色模型配置`，用于让用户看到 HA / Ego / Superego 的实际模型分工；该展示事件不写入会话历史，也不进入角色 Pi session 上下文。

## 记忆与外部证据

MAS 不默认把历史经验和近期活动注入所有 agent 上下文，而是按角色提供只读查询工具：

- `mas_query_memory`：查询 Experience Graph 历史经验候选。
- `mas_query_recent_activity`：查询 `runs/agent_runs` 近期运行事实。
- `mas_external_search`：HA 专属外部检索工具。
- `mas_external_read`：HA 专属外部 URL 读取工具，用于核对搜索候选或用户给定 URL 原文。

HA 可以使用 `mas_query_memory`、`mas_query_recent_activity`、`mas_external_search`、`mas_external_read`、工作区只读工具和自动授权只读 `bash` 完成路由、状态回答、合同前 intake 和最终用户验收。Superego 可以使用 `mas_query_memory`、`mas_query_recent_activity`、工作区只读工具和自动授权 `bash` 辅助系统审计，但不能覆盖 AuditPacket。Ego 可以使用 `mas_query_memory` 查询 Experience Graph 历史经验候选，用于吸取过往踩坑和相似失败模式；Ego 不拥有 `mas_query_recent_activity`、外部检索或外部读取工具，避免执行层扩大任务边界。

Ego 的 Pi session 仍按 MAS 角色隔离创建，但 MAS 会在 Ego prompt 中注入同一 AionUI 会话内 Ego 之前的执行上下文摘要。该摘要只用于保持执行连续性和避免重复返工，不是新用户指令；若与当前用户目标、HA 验收合同、Superego/HA 批注或当前文件证据冲突，以后者为准。

所有检索结果都不是权威事实，采用前必须结合当前任务证据、AuditPacket、用户目标和验收合同交叉验证。

## Bash 超时策略

MAS 覆盖 Pi SDK 的内置 `bash` 工具，在模型未显式传入 `timeout` 或传入无效值时应用默认超时。当前默认值是 `120` 秒，可通过 `MAS_BASH_DEFAULT_TIMEOUT_SECONDS` 调整。模型显式提供正数 `timeout` 时，MAS 尊重该值。

该策略属于框架确定性保障，不依赖 agent 自觉遵守。基础 prompt 会同步告知 HA、Ego、Superego 默认超时时间，并要求它们根据命令性质按需调大或调小 `timeout`：安装、构建、大型测试和只读复算可以显式加长；快速探测可以缩短；长期服务命令不应作为普通前台命令无限等待，应使用有限超时完成短探活并报告结果。

## 审计与门禁

Superego 不能只依赖 Ego 自报。MAS 在评审前构造 AuditPacket，包含：

- 审批记录和原始工具输入。
- 写入路径和命令摘要。
- Ego 自报 `changed_files`。
- 写入路径与 `changed_files` 对账。
- 用户/验收合同声明的允许输出边界和只读输入边界的当前状态与历史留痕。
- 边界目录轻量 metadata snapshot/diff。
- 面向 Superego 的只读抽样复核建议。

确定性审计门禁高于模型输出。当前仍存在违反允许输出边界、只读输入污染或失败验证伪装成功时，即使模型评审返回 `accept`，MAS 也会强制进入内部 `revise` 或升级信号；真正面向用户的人工介入必须由 HA 终验决定。允许输出边界来自用户任务和 HA 验收合同；未显式要求 `output/` 时，greenfield 项目源码、文档和配置可以写在 workspace 根目录内。

## 存储与会话

MAS 是 AionUI 会话一致性的责任方。AionUI 的 `sessionId`、MAS 的 `runId`、Pi 的 role session 是不同概念：

- `sessionId`：用户对话身份，由 AionUI/MAS 共同维护。
- `runId`：一次用户请求对应的 MAS 执行身份。
- Pi session：HA、Ego 或 Superego 在某一轮中的执行实例。

SQLite 当前保存消息、摘要、运行记录、agent_run、approval、audit、events、Experience Graph、低熵信号、候选和自主调度任务。Pi session 使用内存型执行实例，长期会话语义由 MAS 持久化和显式上下文注入保证。AionUI 可见的中间工具流和 agent 思考不会自动成为下一轮 MAS agent 的上下文；需要跨 run 使用的事实必须通过 MAS 存储、AuditPacket、agent_run 结构化输出、会话摘要或显式查询工具进入上下文。

## 当前边界

当前本地系统化阶段暂未包含 Temporal、PostgreSQL、NATS、对象存储、远程控制面和生产级多租户。相关演进见 `docs/ROADMAP.md`。
