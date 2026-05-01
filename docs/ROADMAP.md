# MAS 未来规划与路线图

## 当前 MVP 状态

当前版本已经具备最小闭环：

- 通过 `mas acp` 作为 AionUI 自定义 ACP Agent 启动。
- 内部通过 Pi SDK 创建执行会话。
- HA 生成验收合同，Ego 执行，Superego 评审。
- 写文件、编辑文件、执行命令默认走 ACP 权限审批。
- SQLite 记录 run、agent_run、approval、audit。

当前实现更偏“可验证架构骨架”，还不是生产级长任务控制面。

## 近期目标

- 补齐 ACP 兼容性：
  - 完善 `session/cancel` 到 Pi 执行中的取消传播。
  - 补充 `session/set_mode`、`session/set_model`、`session/set_config_option` 的真实状态处理。
  - 建立 AionUI 端到端 smoke test。
- 强化权限系统：
  - 支持 allow_always / reject_always 的会话级缓存。
  - 为 bash、write、edit 生成更清晰的审批标题、路径和风险说明。
  - 增加超时拒绝和取消时清理 pending permission。
- 强化 Superego：
  - 引入结构化 JSON schema 校验。
  - 读取 git diff、工具结果、检查结果后再评分。
  - 对重复批注和低价值风格修改做抑制。
- 增加测试：
  - JSON-RPC 协议单元测试。
  - Pi 事件映射测试。
  - 权限决策测试。
  - HA / Ego / Superego 状态机测试。

## 中期目标

- 数据模型升级：
  - 完善 workflow_run、task_run、iteration_run、artifact、validation_result 等实体。
  - 为工件建立不可变版本、内容哈希和父子关系。
  - 增加审计导出命令。
- 工具和校验：
  - 增加 validator 接口，支持 test、lint、schema、policy。
  - 将验证结果纳入 Superego 评分和 HA 终验。
  - 支持 `mas artifacts`、`mas logs`、`mas replay`。
- Agent 能力：
  - 支持为 HA、Ego、Superego 分别配置模型、thinking level 和工具集。
  - 支持多 Ego 子任务串行或受控并行。
  - 引入失败模式记忆，但不让记忆层成为事实来源。
- AionUI 体验：
  - 优化 tool_call / tool_call_update 展示内容。
  - 支持计划、上下文用量、最终验收状态的专门展示。
  - 明确 AionUI 自定义 Agent 配置文档和诊断指引。

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
  - 每个决策节点记录 trace_id、model_version、prompt_version、policy_version。
- 安全：
  - 增加 OPA 风格策略层。
  - 引入 secret 隔离和敏感日志过滤。
  - 支持租户、工作区、项目级隔离和配额。
- 事件总线：
  - 必要时引入 NATS JetStream 作为派生事件总线。
  - 控制面事实仍以工作流和数据库为准，不把消息总线当唯一真相。

## 非目标

- 短期不实现公有 SaaS 多租户。
- 短期不直接操控 AionUI 界面，AionUI 只作为 ACP Client / UI。
- 短期不替换 Pi 的模型和工具执行内核。
- 短期不引入 Temporal、PostgreSQL、NATS，除非 MVP 验证完成。

## 风险清单

- Pi SDK 内部 API 变化可能影响 MAS 集成。
- ACP 具体字段在不同客户端/后端之间存在差异，需要持续做兼容测试。
- Superego 如果没有结构化校验和停止条件，容易出现反复返工。
- 高自主模式下写文件和执行命令风险较高，必须保留审计和显式开关。
- 长任务、断连恢复、并发任务在 SQLite MVP 中只能有限支持。
