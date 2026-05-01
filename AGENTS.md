# Codex 项目指令

## 语言要求

- 所有文档、注释、说明和最终输出必须使用简体中文。
- 代码标识符可以使用英文，代码注释优先使用简体中文。
- 涉及外部协议、库名、命令名时保留原文，例如 ACP、AionUI、Pi、SQLite、Temporal。

## 项目定位

MAS 是一个多智能体执行系统 MVP，目标是通过 ACP 协议接入 AionUI，并在内部使用 Pi SDK 提供自主 coding agent 能力。

当前 MVP 的核心形态：

- AionUI 作为 ACP Client / UI。
- MAS 作为自定义 ACP Agent，对外提供 `mas acp`。
- Pi SDK 作为 MAS 内部执行内核，不依赖全局 `pi` 命令。
- HA / Ego / Superego 是 MAS 内部编排角色。
- 默认权限策略为读操作自动通过，写文件、编辑文件和执行命令需要审批。

## 技术栈

- 运行时：Node.js 24+。
- 语言：TypeScript，ESM。
- 入口执行：`tsx`。
- 存储：Node 内置 `node:sqlite` 的 `DatabaseSync`，当前会触发 experimental warning，属于预期现象。
- 外部 UI / 协议：AionUI + ACP JSON-RPC over stdio。
- Agent 内核：公共 npm 包 `@mariozechner/pi-coding-agent`。

## 目录结构

- `bin/mas`：MAS CLI 入口脚本。
- `src/cli.ts`：命令行分发，包含 `acp`、`run`、`doctor`、`status`。
- `src/acp/`：ACP JSON-RPC server、AionUI session update 映射、权限请求映射。
- `src/core/`：HA / Ego / Superego 编排和提示词构造。
- `src/pi/`：Pi SDK 动态加载和 Pi session 适配。
- `src/storage.ts`：SQLite 持久化。
- `src/types.ts`：MAS 内部共享类型。
- `docs/ROADMAP.md`：未来规划和路线图。

## 启动和验证命令

准备 MAS：

```bash
cd /home/admin/mas-impl
npm install
npm run typecheck
npm run doctor
```

作为 AionUI 自定义 ACP Agent：

```bash
/home/admin/mas-impl/bin/mas acp
```

高自主模式：

```bash
/home/admin/mas-impl/bin/mas acp --approve-all
```

本地直接运行任务：

```bash
./bin/mas run "阅读当前项目并总结结构"
```

查看最近任务：

```bash
./bin/mas status
```

## AionUI 配置

在 AionUI 的自定义 ACP Agent 中配置命令：

```bash
/home/admin/mas-impl/bin/mas acp
```

如果需要免审批自动执行：

```bash
/home/admin/mas-impl/bin/mas acp --approve-all
```

默认模式下，MAS 会通过 ACP `session/request_permission` 向 AionUI 请求写文件、编辑文件和执行命令审批。

## 关键约束

- 不要依赖全局 `pi` 命令；当前项目通过公共 npm 包 `@mariozechner/pi-coding-agent` 集成。
- 不要直接引用本机 Pi 源码目录；需要升级 Pi 时应调整 `package.json` 中的公共包版本并更新锁文件。
- 不要提交 `node_modules/`、运行数据、日志或本地密钥。
- 本地运行数据默认在 `~/.mas/`，不要把它迁移进仓库。
- `node:sqlite` 当前是实验特性，看到 experimental warning 不代表失败。
- 真实 prompt 执行依赖 Pi 的模型认证和 API key；测试时避免无意触发高权限工具调用。
- 推送 GitHub 需要本机凭据；当前远程是 `https://github.com/CottChen/mas-ha.git`。

## 编码原则

- ACP 层只处理协议转换、会话生命周期和 AionUI 可展示事件，不放业务编排逻辑。
- Pi 适配层只负责创建 Pi session、映射事件、拦截工具权限，不承担 HA / Ego / Superego 决策。
- 编排逻辑放在 `src/core/`，保持状态机显式、可测试。
- 权限策略必须默认保守：读自动，写和命令需审批。
- 对用户工作区的写入和命令执行必须能审计，至少记录 runId、toolCallId、toolName、decision 和 rawInput。
- 新增长期规划、架构演进、阶段目标时写入 `docs/ROADMAP.md`，不要塞进 `AGENTS.md`。

## 多人协作与 Git 约束

- 采用 GitHub 托管，远程仓库为 `git@github.com:CottChen/mas-ha.git`。
- 默认基线分支为 `main`，功能开发必须从 `main` 切出独立分支，不直接在 `main` 上开发。
- 每个方向使用独立 worktree，避免多人/多代理在同一目录互相覆盖。
- 每个 worktree 只能修改自己方向相关文件；跨方向公共接口变更必须先在 PR 或 issue 中说明影响面。
- 禁止提交 `node_modules/`、`.env*`、`~/.mas/`、日志、密钥和本地运行产物。
- 合并前必须至少运行 `npm run typecheck` 和 `npm run doctor`；涉及 ACP 的变更还要跑 ACP handshake smoke test。
- 提交信息使用简短英文祈使句，例如 `Improve ACP session lifecycle`。
- PR 描述必须包含：目标、主要改动、测试结果、风险和回滚方式。
- 多人并行时优先小步提交、小 PR；避免长时间分支漂移。
- 如出现冲突，保留用户或其他协作者已提交的改动，不使用破坏性命令回滚他人工作。

## Worktree 分工

当前约定的长期 worktree：

| 方向 | 人员 | 分支 | 目录 | 默认端口/别名 |
| --- | --- | --- | --- | --- |
| ACP 集成，接入 AionUI，通过AionUI直接调用HA | tao | `feature/acp-aionui` | `/home/admin/mas-impl-acp-aionui` | `MAS_DEV_PORT=4111`, `MAS_ALIAS=mas-acp` |
| Ego+Superego、HA+Ego 模式 |  | `feature/orchestration-modes` | `/home/admin/mas-impl-orchestration` | `MAS_DEV_PORT=4112`, `MAS_ALIAS=mas-orch` |
| 通信组件、版本追溯，让HA能够使用 | wen | `feature/comm-versioning` | `/home/admin/mas-impl-comm-versioning` | `MAS_DEV_PORT=4113`, `MAS_ALIAS=mas-comm` |
| 记忆组件 | `feature/memory` | jie | `/home/admin/mas-impl-memory` | `MAS_DEV_PORT=4114`, `MAS_ALIAS=mas-memory` |

每个 worktree 根目录应保留本地 `.env.local`，用于端口、别名和本地运行差异配置。`.env.local` 不入库。

`.env.local` 推荐字段：

```bash
MAS_WORKTREE=<方向标识>
MAS_ALIAS=<本地别名>
MAS_DEV_PORT=<唯一端口>
MAS_ACP_PORT=<唯一端口，如未来引入 HTTP/WebSocket ACP 调试服务>
MAS_HOME=<隔离的本地数据目录>
```

端口分配必须唯一。新增 worktree 时从 `4120` 以后递增，避免和既有四个方向冲突。

## 各方向边界

- `feature/acp-aionui`：只负责 ACP 协议兼容、AionUI 自定义 Agent 接入、权限事件、session/update 映射和端到端 smoke test。
- `feature/orchestration-modes`：只负责 HA/Ego/Superego 状态机、模式切换、返工策略、验收合同和编排测试。
- `feature/comm-versioning`：只负责内部事件、通信抽象、版本追溯、审计链路、工件版本和回放接口。
- `feature/memory`：只负责短期/长期记忆、失败模式沉淀、检索增强和记忆隔离策略。

公共类型、CLI 参数、存储 schema、权限模型属于共享边界；改动前必须考虑其他 worktree 的兼容性。
