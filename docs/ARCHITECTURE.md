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
| HA | 面向用户，负责路由、澄清、验收合同、最终用户验收和交叉验证 | `mas_query_memory`、`mas_query_recent_activity`、`mas_external_search`、`ha_decision`、`ha_final_review` |
| Ego | 执行者，负责读取、编辑、运行命令、产出结果和验证记录 | 工作区读写、命令执行、`ego_result`；不拥有外部检索工具 |
| Superego | 系统审计 Critic/Judge，负责基于 AuditPacket、只读检查和历史风险评审 Ego 输出 | AuditPacket、只读工作区检查、MAS 记忆/近期活动、`superego_review` |
| Id / Dream | 低权限经验重组和裁剪 | 只操作 Experience Graph，不写用户工作区，不执行外部工具 |

HA 和 Superego 都是 Critic，但视角不同：HA 代表用户验收交付价值和真实意图，Superego 代表系统审计边界和证据一致性。

## 执行链路

一次用户请求的主链路：

1. AionUI 通过 ACP 调用 MAS。
2. MAS 恢复 `sessionId` 对应的会话摘要、最近消息、技能摘要和运行配置。
3. HA 判断直接回答、澄清或进入执行；进入执行时生成验收合同。
4. MAS 生成边界 baseline snapshot。
5. Ego 按验收合同执行任务，提交 `ego_result`。
6. Superego 基于 Ego 结果和 AuditPacket 做系统审计评审。
7. HA 基于用户意图、Ego 结果、Superego 结论、只读抽样和必要外部检索做最终验收。
8. MAS 将 run、agent_run、approval、audit、events、Experience Graph 和低熵信号写入 SQLite。
9. Autonomy daemon 后续处理 reflection、dream、prune、consolidation 和 goal_continuation。

未启用 Superego 的 `ha-ego` 模式仍保留 HA 终验；只是跳过系统审计评审和返工环节。

## 异质工具与 Tool-MAD

MAS 当前采用角色异质工具分工：

- Ego 负责行动工具，拥有工作区读写和命令执行能力。
- Superego 负责系统审计工具，依赖 AuditPacket、只读工作区检查和 MAS 内部运行事实。
- HA 负责用户代理验收工具，拥有外部检索工具 `mas_external_search`，用于引入 MAS 当前会话、工作区、Experience Graph 和 AuditPacket 之外的公开证据候选。

这个设计借鉴 Tool-MAD 的异质外部工具思想。Tool-MAD 指出，传统 MAD 容易依赖模型内部知识或静态文档；通过为不同 agent 分配不同外部工具，例如 Search API 或 RAG 模块，可以引入多样化证据视角，并提升事实核验鲁棒性。

参考：Seyeon Jeong、Yeonjun Choi、JongWook Kim、Beakcheol Jang，*Tool-MAD: A Multi-Agent Debate Framework for Fact Verification with Diverse Tool Augmentation and Adaptive Retrieval*，arXiv:2601.04742，2026-01-08，https://arxiv.org/abs/2601.04742。

`mas_external_search` 的结果只是候选证据，不能覆盖用户目标、验收合同、当前仓库证据、AuditPacket 或确定性审计门禁。HA 采用外部结果时必须保留来源、检索时间和交叉验证依据。

## 模型选择策略

模型选择遵循角色隔离：

- AionUI 会话模型选择只作用于 HA，用于形成用户代理验收视角。
- `MAS_HA_MODEL` 优先级高于 AionUI 会话模型。
- Ego 未配置 `MAS_EGO_MODEL` 时直接使用 Pi 默认模型。
- Superego 未配置 `MAS_SUPEREGO_MODEL` 时直接使用 Pi 默认模型，不探测其他模型。
- 显式配置的角色模型不可用时，MAS 回退 Pi 默认模型，并在 ACP metadata 和 MAS event 中记录 warning。

## 记忆与外部证据

MAS 不默认把历史经验和近期活动注入所有 agent 上下文，而是提供只读查询工具：

- `mas_query_memory`：查询 Experience Graph 历史经验候选。
- `mas_query_recent_activity`：查询 `runs/agent_runs` 近期运行事实。
- `mas_external_search`：HA 专属外部检索工具。

所有检索结果都不是权威事实，采用前必须结合当前任务证据、AuditPacket、用户目标和验收合同交叉验证。

## 审计与门禁

Superego 不能只依赖 Ego 自报。MAS 在评审前构造 AuditPacket，包含：

- 审批记录和原始工具输入。
- 写入路径和命令摘要。
- Ego 自报 `changed_files`。
- 写入路径与 `changed_files` 对账。
- 输出边界和只读输入边界的当前状态与历史留痕。
- 边界目录轻量 metadata snapshot/diff。
- 面向 Superego 的只读抽样复核建议。

确定性审计门禁高于模型输出。当前仍存在输出边界违规、只读输入污染或失败验证伪装成功时，即使模型评审返回 `accept`，MAS 也会强制进入 `revise` 或 `escalate`。

## 存储与会话

MAS 是 AionUI 会话一致性的责任方。AionUI 的 `sessionId`、MAS 的 `runId`、Pi 的 role session 是不同概念：

- `sessionId`：用户对话身份，由 AionUI/MAS 共同维护。
- `runId`：一次用户请求对应的 MAS 执行身份。
- Pi session：HA、Ego 或 Superego 在某一轮中的执行实例。

SQLite 当前保存消息、摘要、运行记录、agent_run、approval、audit、events、Experience Graph、低熵信号、候选和自主调度任务。Pi session 使用内存型执行实例，长期会话语义由 MAS 持久化和显式上下文注入保证。

## 当前边界

当前本地系统化阶段暂未包含 Temporal、PostgreSQL、NATS、对象存储、远程控制面和生产级多租户。相关演进见 `docs/ROADMAP.md`。
