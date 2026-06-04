# AionUI、MAS、Pi 与大模型的会话链路

本文说明 AionUI 到 MAS，再到 Pi SDK 和大模型的一次对话链路，重点解释 MAS 如何维护“同一个会话”的语义，以及为什么当前实现没有直接复用 Pi 的持久会话 ID。

## 结论

当前 MAS MVP 中，AionUI 会话和 Pi 执行实例不是同一个概念。

- `sessionId` 是 AionUI / MAS 共同识别的用户对话身份。
- `runId` 是 MAS 在同一个会话中为每次用户请求创建的任务执行身份。
- Pi session 是 HA、Ego 或 Superego 在某一轮执行中创建的 agent 执行实例。

MAS 是会话一致性的责任方。它通过 SQLite 持久化会话消息、摘要、运行记录和事件审计；每次 AionUI 带着 `sessionId` 调用 `session/prompt` 时，MAS 先按 `sessionId` 恢复上下文，再把上下文显式拼入本轮交给 Pi 的任务。

## 总体链路

```text
AionUI
  -> ACP JSON-RPC over stdio
  -> mas acp
  -> src/acp/server.ts
  -> src/core/runner.ts
  -> src/pi/pi-sdk.ts
  -> @mariozechner/pi-coding-agent
  -> 模型 provider / 大模型
```

各组件职责如下：

| 组件 | 职责 |
| --- | --- |
| AionUI | 提供用户界面、展示对话、发起权限审批，是 ACP Client。 |
| ACP Server | 处理 `session/new`、`session/load`、`session/prompt`、`session/update` 和 `session/request_permission`。 |
| MAS Core | 负责 HA / Ego / Superego 编排、上下文构造、任务执行状态、验收和返工。 |
| MAS Storage | 用 SQLite 保存会话消息、摘要、运行记录、事件和审计信息。 |
| Pi Adapter | 创建 Pi agent session、映射 Pi 事件、拦截工具权限、把 MAS 身份传入事件记录。 |
| Pi SDK | 执行 coding agent 能力，包括工具调用、模型交互和消息事件产生。 |
| 大模型 | 生成推理、计划、代码、工具调用意图和结构化输出。 |

## 一次对话的阶段

1. AionUI 启动 `mas acp`。
2. MAS 作为 ACP Agent 与 AionUI 完成 JSON-RPC 握手。
3. AionUI 调用 `session/new` 或 `session/load`。
4. MAS 创建或加载 `sessionId`，并维护内存中的 `sessions` map。
5. 用户输入消息后，AionUI 调用 `session/prompt`，参数里带回 `sessionId`。
6. MAS 用 `sessionId` 查 `sessions` map，确认这是一个已知会话。
7. MAS 用 `sessionId` 从 SQLite 恢复会话摘要和最近消息。
8. MAS 把上下文、当前请求和技能摘要拼成本轮任务。
9. HA 判断是否直接回答、澄清，还是交给 Ego 执行。
10. Ego 通过 Pi SDK 创建本轮执行用的 Pi session，并与大模型和工具交互。
11. 如触发写文件、编辑文件或命令执行，Pi Adapter 拦截并通过 ACP 向 AionUI 请求权限。
12. Superego 根据执行结果和审计证据评审，必要时要求返工或升级人工。
13. MAS 把最终结果保存到 SQLite，并通过 ACP 返回给 AionUI。

## MAS 如何维护会话身份

### 创建或加载会话

新会话在 `src/acp/server.ts` 的 `session/new` 中创建：

```ts
peer.on("session/new", async (params) => {
  const sessionId = `mas-${randomUUID()}`;
  ...
  sessions.set(sessionId, { sessionId, cwd, approvalMode, orchestrationMode, context: { summary: "", turns: [] }, skills });
  ...
  return sessionResponse(sessionId, approvalMode, orchestrationMode, skills);
});
```

旧会话在 `session/load` 中加载：

```ts
peer.on("session/load", async (params) => {
  const sessionId = String(params?.sessionId ?? `mas-${randomUUID()}`);
  ...
  const context = store.getConversationContext(sessionId);
  sessions.set(sessionId, {
    sessionId,
    cwd,
    approvalMode,
    orchestrationMode,
    context,
    skills,
  });
  ...
});
```

这里的 `sessions` map 是当前 MAS ACP 进程内的活动会话表，保存运行时状态，例如 cwd、审批模式、编排模式、上下文和技能摘要。

### 接收下一次用户请求

AionUI 后续调用 `session/prompt` 时会带回同一个 `sessionId`：

```ts
peer.on("session/prompt", async (params) => {
  const sessionId = String(params?.sessionId ?? "");
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`未知 sessionId：${sessionId}`);
  ...
  session.context = store.getConversationContext(sessionId);
  store.addMessage({ sessionId, role: "user", content: prompt, metadata: { source: "acp" } });
  ...
});
```

这段代码完成三件事：

- 从 ACP 参数中取回 `sessionId`。
- 用 `sessions.get(sessionId)` 找到当前进程里的活动会话。
- 用 `store.getConversationContext(sessionId)` 从 SQLite 恢复会话上下文。

## SQLite 中存了什么

MAS 默认使用 `~/.mas/mas.sqlite`。核心表包括：

| 表 | 作用 |
| --- | --- |
| `messages` | 保存用户和助手消息，按 `session_id` 归属到同一会话。 |
| `session_context` | 保存压缩摘要和已摘要到哪条消息。 |
| `runs` | 保存每次用户请求对应的任务执行记录，包含 `run_id` 和 `session_id`。 |
| `events` | 保存 MAS 和 Pi 的事件流，包含 `run_id`、`session_id`、角色、工具调用等信息。 |
| `approvals` | 保存工具权限审批记录。 |
| `audit_log` | 保存 MAS 层审计记录。 |

`messages` 和 `session_context` 是恢复对话上下文的关键表：

```ts
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_context (
  session_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  summarized_message_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

上下文恢复逻辑：

```ts
getConversationContext(sessionId: string, limit = 12): ConversationContext {
  this.compactSessionContext(sessionId);
  const turns = this.getMessageTurns(sessionId, limit);
  return {
    summary: this.getSessionSummary(sessionId),
    turns: turns.length > 0 ? turns : this.getConversationHistory(sessionId, limit),
  };
}
```

它会先检查是否需要压缩，再取摘要和最近若干轮消息。

## 上下文如何交给 Pi

MAS 不要求 Pi 自己从某个持久会话里找上下文，而是在 `MasRunner.run` 开始时构造本轮任务：

```ts
const task = buildTaskWithConversation(
  prompt,
  options.conversationHistory,
  options.conversationSummary,
  options.availableSkills,
);
```

`buildTaskWithConversation` 会把同一 AionUI 会话的历史摘要、最近对话和当前请求拼成一个任务：

```ts
const parts = [
  "以下是同一 AionUI 会话的历史对话。回答和执行当前请求时必须结合历史，不要把用户的后续补充当成孤立任务。",
  "",
];
...
parts.push(`当前用户请求：${prompt}`);
```

因此，Pi 看到的是 MAS 显式构造后的上下文，而不是 Pi 自己恢复出来的上下文。

## Pi session 当前是什么

Pi session 在 `src/pi/pi-sdk.ts` 中创建：

```ts
const { session } = await pi.createAgentSession({
  cwd: options.cwd,
  tools:
    options.role === "ha"
      ? ["ha_decision"]
      : options.role === "ego"
      ? ["read", "grep", "find", "ls", "write", "edit", "bash", "ego_result"]
      : ["read", "grep", "find", "ls", "superego_review"],
  customTools,
  sessionManager: pi.SessionManager.inMemory(options.cwd),
  resourceLoader,
});
```

这里使用的是 `SessionManager.inMemory(options.cwd)`。当前实现没有把 Pi 返回的某个持久 session id 存入 MAS SQLite，也没有在下一次 AionUI 请求时用 Pi session id 让 Pi 自己恢复历史。

一次 MAS run 里可能创建多个 Pi session：

| 角色 | 创建位置 | 用途 |
| --- | --- | --- |
| HA | `decideWithHa` | 判断直接回答、澄清或进入执行。 |
| Ego | 主执行循环 | 执行任务、调用工具、产出结果。 |
| Superego | 评审循环 | 审核 Ego 结果和审计证据。 |

所以，对 Pi 来说，当前 Pi session 更像某个角色的一次执行实例，而不是 AionUI 会话的长期主记录。

## 为什么不直接复用 Pi 会话 ID

当前设计没有把 AionUI 会话直接映射为 Pi 会话，主要原因是：

1. **语义不同**

   AionUI 的一个会话表示用户视角的一段对话。MAS 内部的一次用户请求可能拆成 HA、Ego、Superego 多个角色执行，每个角色的工具、权限、prompt 和职责不同。

2. **MAS 需要掌握上下文解释权**

   MAS 要负责上下文压缩、技能摘要、权限审批、审计、验收和返工。如果上下文完全托管给 Pi 的会话存储，MAS 很难保证这些治理逻辑的一致性。

3. **审计需要统一身份**

   MAS 的事件、审批、运行记录都围绕 `sessionId` 和 `runId` 归档。这样 AionUI 会话、任务执行、工具审批和 Superego 评审可以被统一追踪。

4. **Pi session 当前是内存型执行实例**

   当前代码使用 `SessionManager.inMemory(options.cwd)`，没有接入持久 Pi session 管理，也没有保存可复用的 Pi session id。

5. **降低耦合**

   MAS 自己维护会话历史，可以降低对 Pi 内部会话格式、生命周期和版本演进的依赖。

## 当前设计的优点和代价

优点：

- MAS 对 AionUI 会话语义有最终解释权。
- 审计、审批、事件和上下文恢复都以统一的 `sessionId` 串联。
- HA / Ego / Superego 可以保持角色隔离。
- 对 Pi SDK 的内部会话存储依赖较低。

代价：

- Pi 自身的长会话能力没有被充分利用。
- 每轮执行需要 MAS 显式拼接上下文，prompt 可能变长。
- 如果未来需要更强的角色连续记忆，需要设计 MAS session 和 Pi session 的映射表。

## 未来可选演进

未来可以考虑引入一层显式映射：

```text
MAS sessionId
  -> HA Pi session id
  -> Ego Pi session id
  -> Superego Pi session id
```

但这需要配套设计：

- Pi session id 的持久化 schema。
- 不同角色的上下文隔离策略。
- Pi 会话历史和 MAS SQLite 历史的冲突处理。
- 压缩摘要由 MAS 生成还是由 Pi 生成。
- 审计事件如何与 Pi 原生历史对账。
- Pi SDK 升级或 provider 切换后的兼容策略。

在 MVP 阶段，更稳妥的设计是：MAS 自己持久化会话上下文，每轮把必要历史显式注入给 Pi，并把 Pi 作为角色级执行内核使用。

## 一句话总结

AionUI 负责“看见会话”，MAS 负责“定义并维护会话”，Pi 负责“执行本轮角色任务”，大模型负责“生成推理和工具意图”。当前同一个会话的连续性来自 MAS 的 SQLite 上下文恢复，而不是 Pi 的持久会话恢复。
