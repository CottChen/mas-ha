# MAS 路线图

本文只维护阶段目标和生产化方向。当前目标设计见 [系统架构](../architecture/ARCHITECTURE.md)，具体理念偏差见 [理念对齐 TODO](../quality/DESIGN_ALIGNMENT_TODO.md)，缺陷状态见 [bug-tracking](../../bug-tracking/README.md)。

## 当前阶段

MAS 当前处于本地系统化和理念校准阶段，已有能力包括：

- ACP 接入 AionUI，支持会话、模式、模型、取消和权限事件。
- HA 路由与终验、Ego 执行、Superego 审计，以及 `ha-ego` / `ha-ego-superego` 两种模式。
- Pi SDK typed tool、角色工具隔离、模型选择和结构化输出 repair。
- AuditPacket、审批与写入审计、边界 snapshot/diff 和确定性门禁。
- SQLite 持久化 run、角色运行、事件、审计、Experience Graph、Goal 和自主任务。
- autonomy daemon / tick、scheduler lease、Reflection、Dream、Prune 和 Consolidation 骨架。
- typecheck、doctor、audit smoke 和 E2E smoke 等基础门禁。

这些能力证明主要链路已经接通，不证明信息评分、Dream、扰动、异质性或 Prompt 效果已经通过真实任务验证。

## 阶段一：理念校准

目标是让系统名称、文档、代码和可观察行为一致。

- 完成结构化验收合同和证据来源建模。
- 建立真实的反馈调节动作，不把 revise 限制为重复 Prompt。
- 建立 Evidence Packet、异质取证和自适应查询闭环。
- 校准启发式不确定性指标，修正熵、吸引子和 Dream 等过度命名。
- 完成 Prompt 去领域 SOP 和角色人格分离。
- 使用真实任务旧版/新版对照验证上述变化。

具体任务和完成标准只在 [理念对齐 TODO](../quality/DESIGN_ALIGNMENT_TODO.md) 维护。

## 阶段二：工程硬化

- 完善 workflow、task、iteration、artifact 和 validation result 等实体关系。
- 增加事件查询、工件版本、审计导出和确定性回放。
- 建立可插拔 validator、外部检索 provider 和证据治理接口。
- 加强 ACP 断连恢复、取消、多会话并发和角色健康诊断。
- 把文档链接、schema 兼容和真实任务回归纳入持续集成。

## 阶段三：组织能力

- 支持多 Ego 子任务的受控串行或并行，并由 HA/Superego 统一验收。
- 让 Experience Graph 使用有来源、可过期、可证伪的检索和晋升机制。
- 让 Reflection、Dream 和 Consolidation 基于新证据及效果反馈选择动作。
- 将 eval、validator、policy、skill 和 doc candidate 纳入人工可控的持续改进流程。
- Goal / Subgoal 继续作为低优先级控制面，不升级为系统自主性的前置依赖。

## 阶段四：生产化

- 用 Temporal 或等价工作流系统承载长生命周期、重试、恢复和版本化。
- 从 SQLite 演进到 PostgreSQL，从本地 artifact 演进到对象存储。
- 增加 OpenTelemetry traces、metrics、logs 和跨组件 correlation id。
- 引入策略引擎、secret 隔离、敏感信息过滤、租户边界和配额。
- 在确有吞吐和解耦需求时引入事件总线；数据库和工作流仍是控制面事实来源。

## 非目标

- 当前阶段不承诺公有 SaaS、多租户、高并发或跨机器确定性回放。
- 不替换 Pi 的模型和工具执行内核。
- 不通过扩大权限、取消审计或增加无边界 Agent 数量换取表面自主性。
- 不在真实任务证据不足时宣称实现严格信息熵、混沌系统或完整 Tool-MAD。
