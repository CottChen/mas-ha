# MAS

MAS 是基于 Pi SDK 的系统化多智能体执行与自主改进系统，对外通过 ACP 让 AionUI 作为客户端连接。系统目标是提供可审计、可验收、可持续改进的 coding agent 编排能力。

## 快速开始

```bash
npm install
npm run typecheck
npm run doctor
./bin/mas acp --orchestration-mode ha-ego-superego
```

本地直接执行任务：

```bash
./bin/mas run "阅读当前项目并总结结构" --orchestration-mode ha-ego
./bin/mas status
```

可用编排模式：

- `ha-ego-superego`：默认模式，HA 生成验收合同，Ego 执行，Superego 审计评审，HA 最终验收。
- `ha-ego`：HA 生成验收合同，Ego 执行，跳过 Superego，但仍保留 HA 最终验收。

## 文档入口

- [文档导航](docs/README.md)：所有文档的职责边界和维护规则。
- [系统架构](docs/ARCHITECTURE.md)：系统定位、角色边界、执行链路、异质工具、模型策略和审计语义。
- [AionUI 接入](docs/AIONUI.md)：AionUI 自定义 Agent、ACP handshake、模型配置、外部检索配置和日志排查。
- [自主性设计](docs/AUTONOMY.md)：Experience Graph、Reflection、Dream、AuditPacket 和 autonomy daemon。
- [Agent Prompt](docs/AGENT_PROMPTS.md)：HA / Ego / Superego 基础 prompt、typed tool 和上下文注入顺序。
- [路线图](docs/ROADMAP.md)：当前系统状态、近期硬化目标和生产化路线。
- [端到端测试计划](docs/E2E_TEST_PLAN.md)：测试范围、用例矩阵和自动化入口。
- [缺陷跟踪](bug-tracking/README.md)：bug 生命周期维护规则。

## 核心能力

- ACP 接入 AionUI，支持会话创建、加载、prompt、取消、模式切换、模型选择和配置项更新。
- HA / Ego / Superego 角色编排，支持验收合同、执行、系统审计、返工和 HA 终验。
- HA 专属 `mas_external_search` 外部检索工具，用于引入公开证据候选并支持异质工具交叉验证。
- Superego `AuditPacket`、确定性审计门禁、边界目录轻量 snapshot/diff 和 `changed_files` 对账。
- SQLite 持久化 run、agent_run、approval、audit、events、messages、Experience Graph、低熵信号、候选和自主调度任务。
- 全局 autonomy daemon / tick，支持 reflection、dream、prune、consolidation 和 goal_continuation。
- Pi SDK typed tool 结构化输出、MAS 业务 schema 校验和 repair prompt 兜底。

## AionUI 自定义 Agent

在 AionUI 的自定义 ACP Agent 中配置：

```bash
/home/admin/mas-impl/bin/mas acp
```

部分 AionUI 版本会追加 `--experimental-acp`，MAS 已兼容：

```bash
/home/admin/mas-impl/bin/mas --experimental-acp
```

高自主模式：

```bash
/home/admin/mas-impl/bin/mas acp --approve-all
```

完整接入和模型配置见 [docs/AIONUI.md](docs/AIONUI.md)。

## Pi 依赖

当前系统使用公共 npm 包：

```bash
npm install @mariozechner/pi-coding-agent
```

MAS 不依赖全局 `pi` 命令，也不依赖本机 Pi 源码目录。

## 当前边界

当前本地系统化阶段暂未包含 Temporal、PostgreSQL、NATS、对象存储和远程控制面；这些能力属于后续生产化路线，见 [docs/ROADMAP.md](docs/ROADMAP.md)。
