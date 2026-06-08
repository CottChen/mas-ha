# MAS 文档导航

本文是 `docs/` 的入口和文档边界说明。新增或修改文档时，先确认内容应落在哪个权威文档，避免同一规则在多个文件中重复维护。

## 权威文档

| 文档 | 维护内容 | 不应包含 |
| --- | --- | --- |
| `docs/ARCHITECTURE.md` | 系统定位、角色边界、执行链路、异质工具、模型策略、审计和会话语义 | 具体启动命令、长篇测试证据 |
| `docs/AIONUI.md` | AionUI 接入、ACP 验证、本地模型和外部检索配置、日志排查 | 架构原则和角色哲学 |
| `docs/AGENT_PROMPTS.md` | HA/Ego/Superego 基础 prompt、typed tool、上下文注入顺序 | 运行配置和路线图 |
| `docs/AUTONOMY.md` | Experience Graph、自主调度、Reflection、Dream、AuditPacket 细节 | AionUI 接入步骤 |
| `docs/ROADMAP.md` | 当前系统状态、近期硬化、中期能力和生产化路线 | 已关闭 bug 和测试证据 |
| `docs/E2E_TEST_PLAN.md` | 可复用端到端测试范围、用例矩阵和自动化入口 | 某次测试执行证据 |
| `bug-tracking/README.md` | 缺陷生命周期规则 | 架构方案 |

## 专题文档

| 文档 | 定位 |
| --- | --- |
| `docs/AUTONOMY_TODO.md` | 自主性机制的实施清单和完成状态。 |
| `docs/COMM_VERSIONING.md` | 通信、事件和版本追溯专题。 |
| `docs/HIGH_RISK_SAMPLING.md` | 高风险抽样策略专题。 |
| `docs/CANDIDATE_PROMOTION.md` | 候选晋升策略专题。 |
| `docs/WINDOWS_UTF8.md` | Windows 中文和 UTF-8 编码排查专题。 |

## 维护规则

- 系统定位、角色职责、模型策略和工具分工只在 `docs/ARCHITECTURE.md` 定义；其他文档引用或简述，不重复扩写。
- AionUI 命令、环境变量、ACP handshake、模型和检索端点配置只在 `docs/AIONUI.md` 维护。
- prompt 文本或 typed tool schema 变化必须同步 `docs/AGENT_PROMPTS.md`。
- 自主调度、Experience Graph、Reflection、Dream、AuditPacket 细节变化必须同步 `docs/AUTONOMY.md`。
- 阶段目标和生产化计划只写 `docs/ROADMAP.md`，不要塞进 `AGENTS.md`。
- 历史报告和已吸收的方案文档不长期保留在 `docs/`；必要证据迁入 `bug-tracking/`、测试计划或当前权威文档。
