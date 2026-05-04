# ACP 对标 opencode 改造记录

本文记录 MAS 对标 opencode 接入 AionUI 时需要具备的 ACP 能力。opencode 的核心经验是：ACP 层只负责协议事件转换，真实的会话历史、消息部件、工具状态、权限和上下文压缩由 agent 自己的 session 系统持久化和恢复。

## 已完成

### 会话和历史

- `session/new` 创建 MAS session，并返回模型、模式、编排配置。
- `session/load` 按 `session_id` 恢复 MAS 会话上下文。
- MAS 持久化 `messages`，记录 user / assistant 文本消息。
- 兼容旧数据：如果 `messages` 为空，会从历史 `runs` 恢复对话。
- `session/load` 会向 AionUI 回放：
  - `user_message_chunk`
  - `agent_message_chunk`
  - 有压缩摘要时发送 `agent_thought_chunk`

### 上下文组装和压缩

- HA / Ego / Superego 调用模型前会收到：
  - 压缩摘要
  - 最近对话
  - 当前用户请求
  - 当前可发现的 Pi 技能摘要
- 新增 `session_context`，保存压缩后的早期上下文摘要。
- 新增 `/compact` slash command，用户可手动触发当前 MAS 会话压缩。
- 自动压缩采用保守的抽取式摘要，避免在 ACP 基础链路中额外触发模型调用。

### 工具和权限

- Pi 工具事件映射为 ACP `tool_call` / `tool_call_update`。
- 工具状态使用 ACP 约定的 `pending`、`in_progress`、`completed`、`failed`。
- 工具内容按 ACP `ToolCallContent` 包装为文本 content block。
- `grep` / `find` 映射为 `search`，读文件映射为 `read`，写入映射为 `edit`，命令映射为 `execute`。
- 写文件、编辑和命令仍通过 `session/request_permission` 请求 AionUI 审批。

### 结构化输出

- HA / Ego / Superego 的内部结构化结果统一使用 Pi SDK typed tool 提交：
  - `ha_decision`：HA 路由决策。
  - `ego_result`：Ego 执行结果、证据、修改文件、验证结果和风险。
  - `superego_review`：Superego 评审结论、阻塞问题、评分和返工建议。
- MAS 对 typed tool 参数再做业务 schema 校验，避免只依赖模型或 provider 的工具参数校验。
- 如果 typed tool 缺失、参数不符合 MAS schema，或模型退回普通 JSON 文本，MAS 会进入对应 repair prompt，要求重新调用结构化工具。
- repair 仍失败时，Ego 返回 `needs_attention`，Superego 返回 `escalate`，不把结构化输出失败伪造成执行成功。
- 这些内部结构化工具不会作为普通 ACP tool stream 暴露给 AionUI；AionUI 只看到用户相关文本、真实工具调用、权限请求和最终结果。

### 技能

- MAS 通过 Pi `DefaultResourceLoader` 发现 Pi 技能。
- `session/new` / `session/load` 返回的 metadata 包含技能摘要。
- MAS 通过 `available_commands_update` 公告 `/compact` 和可发现的 `/skill:<name>` 命令。
- 可用 `MAS_SKILL_PATHS` 追加技能目录，多个路径按当前平台的 path delimiter 分隔。

### ACP 稳定性

- 修复 JSON-RPC stdin 关闭时异步 handler 还未写完响应的问题，保证 handshake smoke test 能稳定拿到 `initialize` 响应。

## 后续待做

- 将 `messages` 细化为 message parts，持久化工具调用、工具输出、文件资源、图片和 reasoning，而不是只保存文本。
- 将抽取式压缩升级为模型压缩，并保存压缩边界、涉及文件、工具调用和 token 估算。
- 接入 ACP `fs/*` 和 `terminal/*` client capability，让 MAS 能读取 AionUI 未保存编辑内容，并把命令执行映射到客户端终端。
- 为 `available_commands_update` 增加更完整的命令输入 schema，并支持 `/skill:name args` 的强制加载路径。
- 增加 ACP 端到端 smoke test，覆盖 initialize、session/new、session/load、session/prompt、权限请求、工具事件和上下文压缩。
