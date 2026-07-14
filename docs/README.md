# MAS 文档导航

本文是 [docs/](./) 的入口和文档边界说明。新增或修改文档时，先确认内容应落在哪个权威文档，避免同一规则在多个文件中重复维护。

## 权威文档

| 文档 | 维护内容 | 不应包含 |
| --- | --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 理论来源与设计转译、系统定位、组织和角色边界、执行链路、异质工具、模型策略、审计和会话语义 | 具体启动命令、长篇测试证据 |
| [AIONUI.md](AIONUI.md) | AionUI 接入、ACP 验证、本地模型和外部检索配置、日志排查 | 架构原则和角色哲学 |
| [AGENT_PROMPTS.md](AGENT_PROMPTS.md) | HA/Ego/Superego 基础 prompt、typed tool、上下文注入顺序 | 运行配置和路线图 |
| [AUTONOMY.md](AUTONOMY.md) | Experience Graph、自主调度、Reflection、Dream、AuditPacket 细节 | AionUI 接入步骤 |
| [ROADMAP.md](ROADMAP.md) | 当前系统状态、近期硬化、中期能力和生产化路线 | 已关闭 bug 和测试证据 |
| [E2E_TEST_PLAN.md](E2E_TEST_PLAN.md) | 可复用端到端测试范围、用例矩阵和自动化入口 | 某次测试执行证据 |
| [../bug-tracking/README.md](../bug-tracking/README.md) | 缺陷生命周期规则 | 架构方案 |

## 专题文档

| 文档 | 定位 |
| --- | --- |
| [DESIGN_ALIGNMENT_TODO.md](DESIGN_ALIGNMENT_TODO.md) | 当前实现、Prompt 与 MAS 核心理念之间尚未解决的设计偏差和真实任务测试要求。 |
| [COMM_VERSIONING.md](COMM_VERSIONING.md) | 通信、事件和版本追溯专题。 |
| [HIGH_RISK_SAMPLING.md](HIGH_RISK_SAMPLING.md) | 高风险抽样策略专题。 |
| [CANDIDATE_PROMOTION.md](CANDIDATE_PROMOTION.md) | 候选晋升策略专题。 |
| [WINDOWS_UTF8.md](WINDOWS_UTF8.md) | Windows 中文和 UTF-8 编码排查专题。 |

## 历史归档

已被吸收或替代的设计快照、演示材料和完成清单统一放在 [archive/](archive/)。归档内容只用于追溯，不继续同步代码，也不是当前权威来源；具体规则见 [archive/README.md](archive/README.md)。

## 维护规则

- 理论来源与设计转译、系统定位、组织关系、角色职责、模型策略和工具分工只在 [ARCHITECTURE.md](ARCHITECTURE.md) 定义；其他文档引用或简述，不重复扩写。
- AionUI 命令、环境变量、ACP handshake、模型和检索端点配置只在 [AIONUI.md](AIONUI.md) 维护。
- prompt 文本或 typed tool schema 变化必须同步 [AGENT_PROMPTS.md](AGENT_PROMPTS.md)。
- 自主调度、Experience Graph、Reflection、Dream、AuditPacket 细节变化必须同步 [AUTONOMY.md](AUTONOMY.md)。
- 阶段目标和生产化计划只写 [ROADMAP.md](ROADMAP.md)，不要塞进 [../AGENTS.md](../AGENTS.md)。
- 历史报告和已吸收的方案文档移入 [archive/](archive/)；必要证据迁入 [../bug-tracking/](../bug-tracking/)、测试计划或当前权威文档。
