# MAS 文档导航

`docs/` 只保存当前仍需维护的权威说明和专题规则。历史快照、分享材料、单次任务取证和被替代方案统一进入 [archive/](archive/)，不得作为当前实现依据。

## 架构

| 文档 | 唯一职责 |
| --- | --- |
| [系统架构](architecture/ARCHITECTURE.md) | 理论来源、目标设计、角色边界、执行链路、模型与工具策略。 |
| [自主性机制](architecture/AUTONOMY.md) | 当前 Experience Graph、Reflection、Dream 和调度机制。 |
| [Agent Prompt](architecture/AGENT_PROMPTS.md) | Prompt 方法、角色人格、上下文和 typed tool 边界。 |

## 运行

| 文档 | 唯一职责 |
| --- | --- |
| [AionUI 接入](operations/AIONUI.md) | ACP 接入、模型配置、外部检索和本地排障。 |
| [Windows UTF-8](operations/WINDOWS_UTF8.md) | Windows 中文路径、终端和文件编码规则。 |

## 质量

| 文档 | 唯一职责 |
| --- | --- |
| [理念对齐 TODO](quality/DESIGN_ALIGNMENT_TODO.md) | 代码、Prompt、文档与核心理念之间尚未解决的偏差。 |
| [测试与验证](quality/TESTING.md) | 自动化门禁、真实任务测试和验证证据要求。 |
| [高风险抽样](quality/HIGH_RISK_SAMPLING.md) | 数据、代码和文档任务的抽样复核原则。 |

## 治理与规划

| 文档 | 唯一职责 |
| --- | --- |
| [候选晋升](governance/CANDIDATE_PROMOTION.md) | eval、validator、policy、skill 和 doc candidate 的晋升规则。 |
| [路线图](planning/ROADMAP.md) | 阶段目标和生产化方向，不记录具体缺陷或待办。 |
| [缺陷跟踪](../bug-tracking/README.md) | 缺陷生命周期和复测状态。 |

## 维护规则

- 同一规则只在一个权威文档中完整定义，其他位置只链接，不复制。
- 目标设计写入架构文档；当前偏差写入理念 TODO；执行方法写入运行文档；阶段目标写入路线图。
- Prompt 或 typed tool 变化同步更新 [Agent Prompt](architecture/AGENT_PROMPTS.md)，并按 [测试与验证](quality/TESTING.md) 完成真实任务对照。
- 已关闭 TODO 由 Git 历史保留，不在当前文档长期堆积。
- 带静态代码行数、表数量、某次 run 数据或阶段性结论的材料默认属于归档。
