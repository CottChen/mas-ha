# MAS MVP

MAS 是一个基于 Pi SDK 的多智能体执行原型，对外通过 ACP 让 AionUI 作为客户端连接。

## 命令

```bash
npm install
npm run typecheck
npm run doctor
./bin/mas acp --orchestration-mode ha-ego-superego
./bin/mas run "阅读当前项目并总结结构" --orchestration-mode ha-ego
./bin/mas status
```

可用编排模式：

- `ha-ego-superego`：默认模式，HA 生成验收合同，Ego 执行，Superego 评审并触发返工。
- `ha-ego`：HA 生成验收合同，Ego 执行，跳过 Superego 评审。

## AionUI 自定义 Agent 配置

在 AionUI 的自定义 ACP Agent 中配置：

```bash
/home/admin/mas-impl/bin/mas acp
```

部分 AionUI 版本会给自定义 ACP Agent 追加 `--experimental-acp` 参数，MAS 已兼容以下启动形式：

```bash
/home/admin/mas-impl/bin/mas --experimental-acp
```

默认权限策略是读操作自动通过，写文件、编辑文件和执行命令会向 AionUI 发起 `session/request_permission`。

如需高自主模式：

```bash
/home/admin/mas-impl/bin/mas acp --approve-all
```

如需固定编排模式，可在命令中追加：

```bash
/home/admin/mas-impl/bin/mas acp --orchestration-mode ha-ego
```

AionUI 会话中 MAS 会公告 `/compact` 命令，用于压缩当前会话上下文；可发现的 Pi 技能会以 `/skill:<name>` 命令形式展示。需要追加技能目录时，设置 `MAS_SKILL_PATHS`，多个路径按当前平台的 path delimiter 分隔。

完整接入、验证、日志排查和模型配置见 [AionUI 接入与模型配置](docs/AIONUI.md)。

## Pi 依赖

当前 MVP 使用公共 npm 包：

```bash
npm install @mariozechner/pi-coding-agent
```

不依赖全局 `pi` 命令，也不依赖本机 Pi 源码目录。

## 当前范围

- 已实现 ACP 初始化、建会话、加载会话、发送 prompt、取消 prompt 的外壳。
- 已实现 HA / Ego / Superego 和 HA / Ego 两种编排模式。
- 已实现 HA 路由、验收合同生成、Ego 执行、Superego 评审和返工闭环。
- 已实现 Pi 工具事件到 ACP `session/update` 的映射。
- 已实现写、编辑、bash 的 ACP 权限请求。
- 已实现 SQLite run、agent_run、approval、audit、messages 和 session_context 记录。
- 已实现 AionUI 会话历史恢复、抽取式上下文压缩和 Pi 技能发现。
- 项目根目录的 `.env.local` 会在启动时自动加载，用于本地 worktree 差异配置。

生产阶段暂未包含 Temporal、PostgreSQL、NATS、对象存储和远程控制面。
