# MAS 路线图

## 当前系统状态

MAS 当前定位为系统化多智能体执行与自主改进系统。当前版本具备：

- 通过 `mas acp` 作为 AionUI 自定义 ACP Agent 启动，兼容 `--experimental-acp`。
- ACP `initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel`、`session/set_mode`、`session/set_model`、`session/set_config_option` 的基础状态处理。
- HA / Ego / Superego 和 HA / Ego 两种编排模式。
- HA 路由、验收合同生成、HA 终验、Ego 执行、Superego 审计评审和返工闭环。
- HA 专属 `mas_external_search` 外部检索工具和 `mas_external_read` 外部 URL 读取工具，用于引入公开证据候选、核对来源原文并支持异质工具交叉验证。
- Ego 工作区读写和命令执行工具，写文件、编辑文件和执行命令默认走 ACP 权限审批。
- Superego `AuditPacket`、确定性审计门禁、边界目录轻量 metadata snapshot/diff、`changed_files` 对账和只读输入边界检查。
- Pi SDK typed tool 结构化输出、MAS 业务 schema 校验和 repair prompt 兜底。
- SQLite 记录 run、agent_run、approval、audit、message、session_context、append-only events、Experience Graph、LowEntropySignal、EntropyLedger、EvalCandidate、Goal 和 AutonomyJob。
- AionUI 会话历史恢复、抽取式上下文压缩、Pi 技能发现和 `/compact`、`/goal`、`/subgoal` 控制面。
- 全局 autonomy daemon / tick，通过 SQLite scheduler lease claim reflection、dream、prune、consolidation 和 goal_continuation。
- E2E smoke、doctor、typecheck 和核心自主性存储回归。

## 近期硬化目标

- 工具与证据治理：
  - 为 `mas_external_search` / `mas_external_read` 增加可插拔 provider 文档化测试，覆盖 MCP、DuckDuckGo 后备、自定义 RAG/search endpoint 和 HTTP 读取 fallback。
  - 记录外部检索结果的 URI、retrievedAt、provider、TTL 和 redaction 状态，并沉淀为 `external_fact` 低熵信号。
  - 让 HA 终验在采用外部检索结果时输出明确来源和交叉验证依据。
- 评审与验收：
  - 为 HA 终验增加专门回归测试，覆盖 Superego accept 但 HA revise/escalate 的路径。
  - 为 Superego AuditPacket 门禁增加更多命令副作用样例。
  - 将高风险抽样模板与任务类型绑定，降低抽样提示词漂移。
- ACP 与 AionUI：
  - 增强 session/model metadata 展示，突出 HA/Ego/Superego 的实际模型、工具异质性和回退 warning。
  - 扩展 AionUI 端到端 smoke，覆盖权限弹窗、工具流展示和会话恢复。
  - 增加 agent session trace 诊断命令或文档入口，便于定位重复思考、工具不可用和上下文缺失。
- 测试与质量：
  - 为 `mas_external_search`、`mas_external_read`、HA 终验、模型选择隔离和只读工具白名单增加单元测试。
  - 将 docs 中的关键架构断言纳入轻量文档一致性检查。
  - 保持 `npm run typecheck`、`npm run doctor`、`npm run e2e:smoke` 作为合并前最低验证。

## 中期能力目标

- 数据模型：
  - 完善 workflow_run、task_run、iteration_run、artifact、validation_result 等实体。
  - 基于 append-only events 增加事件查询、导出、回放和审计报告接口。
  - 为工件建立不可变版本、内容哈希和父子关系。
- 工具和校验：
  - 增加 validator 接口，支持 test、lint、schema、policy、golden sample 和外部事实复核。
  - 支持 `mas artifacts`、`mas logs`、`mas replay`、`mas audit export`。
  - 将外部检索、记忆检索和审计证据统一纳入 Evidence Packet，但保持不同来源的优先级和置信边界。
- Agent 能力：
  - 支持为 HA、Ego、Superego 分别配置模型、thinking level、工具集和外部证据策略。
  - 支持多 Ego 子任务串行或受控并行，并由 HA/Superego 统一验收。
  - 将失败模式记忆、候选 eval、policy 和 skill 晋升路径纳入持续改进飞轮。
- 自主改进：
  - 让 Dream 从经验压缩器进一步升级为低熵候选生成器，输出 eval、policy、skill、doc 和 validator candidate。
  - 按信息增益、风险、预算和安全事故指标调度 Reflection、Dream、Consolidation 和 Goal continuation。

## 生产化路线

- 外层工作流：
  - 引入 Temporal 管理长生命周期任务、重试、恢复、版本化和确定性回放。
  - 保留 Pi SDK 作为内层 agent runtime。
- 存储：
  - 从 SQLite 演进到 PostgreSQL。
  - 工件从本地目录演进到对象存储。
  - 引入 JSONB / GIN 索引用于事件和元数据查询。
- 观测：
  - 增加 OpenTelemetry traces、metrics、logs。
  - 每个决策节点记录 trace_id、model_version、prompt_version、policy_version、toolset_version 和 evidence_packet_version。
- 安全：
  - 增加 OPA 风格策略层。
  - 引入 secret 隔离、敏感日志过滤和外部检索结果脱敏。
  - 支持租户、工作区、项目级隔离和配额。
- 事件总线：
  - 必要时引入 NATS JetStream 作为派生事件总线。
  - 控制面事实仍以工作流和数据库为准，不把消息总线当唯一真相。

## 非目标

- 短期不实现公有 SaaS 多租户。
- 短期不直接操控 AionUI 界面，AionUI 只作为 ACP Client / UI。
- 短期不替换 Pi 的模型和工具执行内核。
- 当前 SQLite 系统化阶段不承诺生产级长事务、租户隔离、跨机器工作流回放或高并发任务调度。

## 风险清单

- Pi SDK 内部 API 变化可能影响 MAS 集成。
- ACP 具体字段在不同客户端/后端之间存在差异，需要持续做兼容测试。
- 外部检索结果存在时效性、召回不足、来源质量和不可用风险，必须作为候选证据而非权威事实。
- HA 终验如果缺少可观测证据，可能退化为模型自评；需要持续加强 evidence packet 和测试覆盖。
- 高自主模式下写文件和执行命令风险较高，必须保留审计、权限策略和显式开关。
- SQLite 阶段的长任务控制面、断连恢复和并发任务支持仍有边界，需要在生产化阶段迁移到工作流和数据库支撑。
