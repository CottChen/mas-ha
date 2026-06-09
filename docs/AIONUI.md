# AionUI 接入与模型配置

本文记录 MAS 接入 AionUI 自定义 ACP Agent 的配置方式，以及 Pi SDK 模型、角色模型和外部检索的本地配置方法。系统定位、角色职责和工具分工的权威说明见 `docs/ARCHITECTURE.md`。

## 前置检查

在 MAS 项目目录执行：

```bash
cd /home/admin/mas-impl
npm install
npm run typecheck
npm run doctor
```

`node:sqlite` 的 experimental warning 属于当前 Node.js 运行时预期现象，不代表失败。

## AionUI 自定义 ACP Agent

在 AionUI 的自定义 ACP Agent 页面添加 MAS，命令填写：

```bash
/home/admin/mas-impl/bin/mas acp
```

可选追加编排模式参数：

```bash
/home/admin/mas-impl/bin/mas acp --orchestration-mode ha-ego-superego
```

当前支持两种编排模式：

- `ha-ego-superego`：默认模式，HA 生成验收合同，Ego 执行，Superego 评审并按需返工，最后由 HA 终验。
- `ha-ego`：HA 生成验收合同，Ego 执行，跳过 Superego 评审和返工，但仍由 HA 终验。

如果 AionUI 使用 custom backend 启动方式，也可能传入 `--experimental-acp`。MAS 已支持以下等价入口：

```bash
/home/admin/mas-impl/bin/mas --experimental-acp
```

`--experimental-acp` 入口同样支持编排模式参数：

```bash
/home/admin/mas-impl/bin/mas --experimental-acp --orchestration-mode ha-ego
```

高自主模式会自动批准写文件、编辑文件和执行命令：

```bash
/home/admin/mas-impl/bin/mas acp --approve-all
```

`--approve-all` 默认采用固定权限策略：会话初始权限会作为该会话后续所有工具调用的权限，AionUI 后续发来的默认模式更新不会把会话降级。

如果需要允许用户在 AionUI 会话过程中切换“默认”/“免确认”，使用可变权限策略：

```bash
/home/admin/mas-impl/bin/mas acp --approve-all --approval-mode-policy mutable
```

在可变权限策略下，MAS 会通过 ACP `session/set_mode` 将“免确认”/`bypassPermissions` 映射为 `approve-all`；切回“默认”后，写文件、编辑文件和执行命令会重新请求审批。

默认模式下，读操作自动通过；写文件、编辑文件和执行命令会通过 ACP `session/request_permission` 请求 AionUI 审批。

### AionUI 会话能力

`session/new` 和 `session/load` 会返回编排模式配置项。AionUI 如果展示配置面板，可在“编排模式”中切换 `ha-ego-superego` 或 `ha-ego`；MAS 也兼容 `session/set_config_option` 更新该配置。

会话创建或加载后，MAS 会发送一条可见的 `MAS 角色模型配置` 思考消息，列出 Pi 默认模型、AionUI 当前选择，以及 HA / Ego / Superego 的 resolved model、requested model、配置来源、thinking level、异质性和 warning。这条消息只用于用户观察当前会话的模型分工，不写入 MAS 会话历史，也不会进入 HA / Ego / Superego 的 Pi session 上下文。

MAS 会向 AionUI 公告以下命令：

- `/compact`：压缩当前 MAS 会话上下文，后续请求会携带压缩摘要和最近对话。
- `/skill:<name>`：展示 Pi 当前可发现技能。当前版本主要用于发现和提示，强制加载技能参数仍在后续待做中。

MAS 会持久化同一 ACP session 下的 user / assistant 文本消息。`session/load` 时会恢复压缩摘要和最近对话；如果新表中没有消息，会从历史 `runs` 兼容恢复对话。

### 本地环境变量

MAS 启动时会自动读取项目根目录 `.env.local`。该文件只用于本地 worktree 差异配置，不提交仓库。

### 角色模型配置

MAS 通过 Pi SDK 创建 HA、Ego、Superego 三类内部会话。AionUI 的会话模型选择只作用于 HA，因为 HA 代表用户做路由、验收合同和最终交叉验证。Ego 和 Superego 未显式配置角色模型时直接使用 Pi 默认模型，不会被 AionUI 会话模型选择覆盖。

可选环境变量：

```bash
MAS_HA_MODEL=
MAS_EGO_MODEL=
MAS_SUPEREGO_MODEL=
MAS_SUPEREGO_THINKING_LEVEL=high
```

规则：

- `MAS_HA_MODEL` 优先级高于 AionUI 会话模型选择；未配置时 HA 使用 AionUI 当前选择模型，仍未选择时使用 Pi 默认模型。
- `MAS_EGO_MODEL` 和 `MAS_SUPEREGO_MODEL` 只在需要单独覆盖角色模型时使用；未配置时直接使用 Pi 默认模型。
- 如果显式配置的角色模型在 Pi 模型注册表中不可用，或当前没有认证，MAS 会回退到 Pi 默认模型并在 ACP `session/new` metadata 与 MAS event 中记录 warning。
- thinking level 可以直接写在模型后缀中，例如 `provider/model:xhigh`，也可以用 `MAS_<ROLE>_THINKING_LEVEL` 单独配置。

### 外部检索配置

HA 拥有 `mas_external_search` 只读外部检索工具和 `mas_external_read` 只读外部 URL 读取工具，用于在路由回答和最终验收时引入 MAS 内部证据之外的公开证据候选，并在需要时核对来源原文。Ego 不获得 MAS 记忆、近期活动、外部检索或外部读取工具，避免执行层用历史状态或外部搜索扩大任务边界；Superego 保留 MAS 记忆和近期活动查询能力，但继续偏系统审计证据。

HA 路由阶段拥有工作区只读工具和自动授权只读 `bash`，用于读取用户明确给出的任务说明、需求文档、目录结构、表头、配置或代码上下文，从而生成更可靠的验收合同；该阶段不得写文件、改文件或提前完成交付。HA 终验阶段继续拥有工作区只读工具和自动授权 `bash`，用于代表用户做独立抽样复算。Superego 也拥有工作区只读工具和自动授权 `bash`，用于系统审计和只读抽样验证。评审阶段 `bash` 不再向 AionUI 请求人工审批，但仍记录 approval/audit 事件；Ego 的 `bash` 仍按常规权限策略处理。

AionUI 会展示 HA、Ego、Superego 的流式文本、思考、工具调用和工具返回；工具标题带角色前缀，例如 `HA: bash`、`Ego: read`、`Superego: bash`。这些展示事件只用于用户观察，不会自动写入 MAS 会话上下文。MAS 持久化会话只保存用户消息、最终 MAS 回复、会话摘要和结构化运行记录；每个角色的 Pi session 独立创建，只能看到 MAS 框架显式传入的内容。

默认情况下，MAS 使用 DuckDuckGo Instant Answer API 作为无密钥外部检索后备。生产或稳定测试环境建议配置自己的 MCP 搜索服务或普通搜索/RAG HTTP endpoint。

### MCP 搜索服务

配置 `MAS_EXTERNAL_SEARCH_MCP_URL` 后，HA 的 `mas_external_search` 默认通过 HTTP MCP `tools/call` 调用搜索工具，`mas_external_read` 默认通过同一 MCP 服务读取 URL 原文；未配置 MCP 时才回退到普通 `MAS_EXTERNAL_SEARCH_ENDPOINT`、HTTP fetch 或 DuckDuckGo。

```bash
MAS_EXTERNAL_SEARCH_MCP_URL=https://metaso.cn/api/mcp
MAS_EXTERNAL_SEARCH_MCP_AUTHORIZATION=Bearer YOUR_LOCAL_TOKEN
MAS_EXTERNAL_SEARCH_MCP_TOOL=metaso_web_search
MAS_EXTERNAL_READ_MCP_TOOL=metaso_web_reader
MAS_EXTERNAL_SEARCH_MCP_SCOPE=webpage
```

当前 MCP 适配默认按 Metaso `metaso_web_search` 参数调用：

```json
{"q":"...","size":5,"scope":"webpage","includeSummary":true,"includeRawContent":false}
```

`mas_external_read` 默认按 Metaso `metaso_web_reader` 参数调用：

```json
{"url":"https://example.com","format":"markdown"}
```

如果服务需要其他 headers，可用本地变量补充；不要把真实 token 写入仓库或文档：

```bash
MAS_EXTERNAL_SEARCH_MCP_HEADERS_JSON={"X-Custom":"value"}
```

### 普通 HTTP 搜索 endpoint

未配置 MCP 时，可以继续使用普通搜索/RAG HTTP endpoint：

```bash
MAS_EXTERNAL_SEARCH_ENDPOINT=https://example.internal/search?q={query}&limit={limit}
```

端点返回 JSON，优先支持以下结构之一：

```json
{"results":[{"title":"...","url":"...","snippet":"...","source":"..."}]}
```

或：

```json
{"items":[{"name":"...","link":"...","summary":"...","source":"..."}]}
```

外部检索结果只是候选证据，不能覆盖用户目标、验收合同、当前仓库证据、AuditPacket 或确定性审计门禁。HA 采用外部结果时必须保留来源和检索时间，并与本地证据交叉验证。

常用字段：

```bash
MAS_WORKTREE=orchestration
MAS_ALIAS=mas-orch
MAS_DEV_PORT=4112
MAS_HOME=/home/admin/.mas-orchestration
MAS_SKILL_PATHS=/path/to/skills:/path/to/more-skills
```

`MAS_SKILL_PATHS` 用于追加 Pi 技能目录。Linux/macOS 使用 `:` 分隔多个路径，Windows 使用 `;` 分隔。

## ACP 握手验证

不经过 AionUI，可直接在本机验证 MAS ACP 入口：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | /home/admin/mas-impl/bin/mas --experimental-acp
```

成功时会返回 `serverInfo.name` 为 `mas` 的 JSON-RPC 响应。

验证 AionUI 可见的模型列表：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/home/admin/mas-impl","orchestrationMode":"ha-ego-superego"}}' \
  | /home/admin/mas-impl/bin/mas --experimental-acp
```

成功时 `session/new` 结果中应包含：

```text
models.currentModelId = <Pi SDK 当前实际模型，例如 zai-anthropic/GLM-5.1>
configOptions 中的 orchestrationMode
```

`models.currentModelId` 和 `models.availableModels` 由 MAS 读取 Pi SDK 后端配置生成，不再使用 ACP 层硬编码值。实际来源是本机 `~/.pi/agent/settings.json`、`~/.pi/agent/models.json` 和 Pi 模型注册表；`metadata.modelConfig.defaultThinkingLevel` 会返回当前默认 thinking level。

验证 `/compact` 命令公告、角色模型展示和技能 metadata，可查看 `session/new` 后 MAS 发送的 `session/update`，其中应包含 `available_commands_update` 和 `MAS 角色模型配置`；如果配置了 `MAS_SKILL_PATHS`，`session/new` 结果的 `metadata.skills` 应包含可发现技能摘要。

## AionUI 日志排查

AionUI 本地日志通常位于：

```bash
~/.config/AionUi/logs/
```

查看当天日志：

```bash
ls -lt ~/.config/AionUi/logs
tail -n 200 ~/.config/AionUi/logs/$(date +%F).log
```

常见错误：

- `CLI found but ACP initialization failed.`：AionUI 找到了命令，但 MAS ACP 初始化失败。先用上面的 ACP 握手命令验证。
- `未知命令：--experimental-acp`：说明 MAS 版本太旧，没有兼容 AionUI 追加的 `--experimental-acp` 参数。更新到包含该兼容逻辑的版本。
- 只有 `node:sqlite` experimental warning：这是预期警告，不是 ACP 失败原因。

## DashScope 模型配置

MAS 内部通过 Pi SDK 创建 agent session。Pi SDK 的自定义模型配置位于本机用户目录：

```text
~/.pi/agent/models.json
~/.pi/agent/settings.json
```

不要把 API key 写入仓库。推荐只写入本机用户目录，或使用环境变量、系统密钥管理器读取。

### models.json

示例配置：

```json
{
  "providers": {
    "dashscope-anthropic": {
      "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
      "api": "anthropic-messages",
      "apiKey": "DASHSCOPE_API_KEY_OR_LITERAL_LOCAL_ONLY",
      "authHeader": true,
      "compat": {
        "supportsEagerToolInputStreaming": false,
        "supportsLongCacheRetention": false
      },
      "models": [
        {
          "id": "qwen3.6-plus",
          "name": "DashScope qwen3.6-plus",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384
        },
        {
          "id": "kimi-k2.5",
          "name": "DashScope kimi-k2.5",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384
        },
        {
          "id": "qwen3.5-plus",
          "name": "DashScope qwen3.5-plus",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

如果 `apiKey` 使用环境变量名，例如 `DASHSCOPE_API_KEY`，需要确保启动 AionUI 的环境能读取到该变量。否则 AionUI 拉起 MAS 后，Pi SDK 可能无法解析密钥。

### settings.json

将默认模型设为 DashScope 的 `qwen3.6-plus`：

```json
{
  "defaultProvider": "dashscope-anthropic",
  "defaultModel": "qwen3.6-plus",
  "defaultThinkingLevel": "medium"
}
```

## 模型配置验证

列出 Pi SDK 可识别模型：

```bash
cd /home/admin/mas-impl
./node_modules/.bin/pi --list-models | rg 'dashscope|qwen3|kimi'
```

预期能看到：

```text
dashscope-anthropic  qwen3.6-plus
dashscope-anthropic  kimi-k2.5
dashscope-anthropic  qwen3.5-plus
```

验证 Pi SDK registry 能找到默认模型：

```bash
node --input-type=module <<'NODE'
import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find('dashscope-anthropic', 'qwen3.6-plus');

console.log(model ? `${model.provider}/${model.id}` : '未找到模型');
NODE
```

预期输出：

```text
dashscope-anthropic/qwen3.6-plus
```
