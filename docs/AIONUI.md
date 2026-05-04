# AionUI 接入与模型配置

本文记录 MAS 接入 AionUI 自定义 ACP Agent 的配置方式，以及 Pi SDK 使用 DashScope 兼容模型的本地配置方法。

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

- `ha-ego-superego`：默认模式，HA 生成验收合同，Ego 执行，Superego 评审并按需返工。
- `ha-ego`：HA 生成验收合同，Ego 执行，跳过 Superego 评审和返工。

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

也可以在 AionUI 会话模式中切换到“免确认”/`bypassPermissions`；MAS 会通过 ACP `session/set_mode` 将该会话切换为等价的 `approve-all`。切回“默认”后，写文件、编辑文件和执行命令会重新请求审批。

默认模式下，读操作自动通过；写文件、编辑文件和执行命令会通过 ACP `session/request_permission` 请求 AionUI 审批。

### AionUI 会话能力

`session/new` 和 `session/load` 会返回编排模式配置项。AionUI 如果展示配置面板，可在“编排模式”中切换 `ha-ego-superego` 或 `ha-ego`；MAS 也兼容 `session/set_config_option` 更新该配置。

MAS 会向 AionUI 公告以下命令：

- `/compact`：压缩当前 MAS 会话上下文，后续请求会携带压缩摘要和最近对话。
- `/skill:<name>`：展示 Pi 当前可发现技能。当前版本主要用于发现和提示，强制加载技能参数仍在后续待做中。

MAS 会持久化同一 ACP session 下的 user / assistant 文本消息。`session/load` 时会恢复压缩摘要和最近对话；如果新表中没有消息，会从历史 `runs` 兼容恢复对话。

### 本地环境变量

MAS 启动时会自动读取项目根目录 `.env.local`。该文件只用于本地 worktree 差异配置，不提交仓库。

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
models.currentModelId = dashscope-anthropic/qwen3.6-plus
configOptions 中的 orchestrationMode
```

验证 `/compact` 命令公告和技能 metadata，可查看 `session/new` 后 MAS 发送的 `session/update`，其中应包含 `available_commands_update`；如果配置了 `MAS_SKILL_PATHS`，`session/new` 结果的 `metadata.skills` 应包含可发现技能摘要。

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
