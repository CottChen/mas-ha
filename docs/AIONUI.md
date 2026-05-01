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

如果 AionUI 使用 custom backend 启动方式，也可能传入 `--experimental-acp`。MAS 已支持以下等价入口：

```bash
/home/admin/mas-impl/bin/mas --experimental-acp
```

高自主模式会自动批准写文件、编辑文件和执行命令：

```bash
/home/admin/mas-impl/bin/mas acp --approve-all
```

默认模式下，读操作自动通过；写文件、编辑文件和执行命令会通过 ACP `session/request_permission` 请求 AionUI 审批。

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
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/home/admin/mas-impl"}}' \
  | /home/admin/mas-impl/bin/mas --experimental-acp
```

成功时 `session/new` 结果中的 `models.currentModelId` 应为：

```text
dashscope-anthropic/qwen3.6-plus
```

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
