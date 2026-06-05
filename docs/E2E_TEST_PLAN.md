# MAS 端到端测试计划

本文记录 MAS MVP 的端到端测试范围、用例矩阵和当前自动化覆盖。长期有效的项目规则仍维护在 `AGENTS.md`，具体测试步骤和证据放在本文。

## 测试目标

- 验证 MAS 作为 CLI 和 ACP Agent 能启动、建会话、暴露能力并处理内置命令。
- 验证 Goal/Subgoal 控制面不会静默覆盖状态，且能写入 SQLite 事实记录。
- 验证 Superego 审计门禁能基于系统证据阻塞越界写入和只读输入污染。
- 验证自主性调度入口能获取租约、查询 due 任务并在无任务时稳定返回。
- 验证真实 HA/Ego/Superego 执行链路在具备 Pi 模型认证时能完成任务、审计、持久化和反思调度。

## 自动化入口

```bash
npm run typecheck
npm run doctor
npm run smoke:audit
npm run e2e:smoke
```

`e2e:smoke` 使用临时 `MAS_HOME` 和临时工作区，不依赖真实模型 API key，不写入用户长期 MAS 数据。

## 用例矩阵

| ID | 场景 | 前置条件 | 步骤 | 预期结果 | 自动化 |
| --- | --- | --- | --- | --- | --- |
| CLI-01 | 类型检查 | 已安装依赖 | 执行 `npm run typecheck` | TypeScript 无错误 | 是 |
| CLI-02 | Pi SDK 导入检查 | 已安装依赖 | 执行 `npm run doctor` | 输出 Pi SDK 导入 `OK`；SQLite experimental warning 不算失败 | 是 |
| CLI-03 | 状态查询 | 隔离 `MAS_HOME` | 执行 `mas status --limit 1` | 输出 JSON 数组 | 是 |
| GOAL-01 | 空工作区 Goal 状态 | 临时工作区无 Goal | 执行 `mas goal status --cwd <tmp>` | 返回非 0，提示没有 active / paused / blocked Goal | 是 |
| GOAL-02 | 创建 Goal | 临时工作区 | 执行 `mas goal set <objective>` | 创建 active Goal，记录 cwd、approval、orchestration、turn budget | 是 |
| GOAL-03 | 防静默覆盖 | 已存在 active Goal | 再次执行 `mas goal set <objective>` | 返回非 0，提示不能静默覆盖 | 是 |
| GOAL-04 | Subgoal 生命周期 | 已存在 active Goal | add、list、confirm、remove | 状态和提示符合预期 | 是 |
| GOAL-05 | Goal 暂停/恢复/清除 | 已存在 active Goal | pause、resume、clear | 状态依次为 paused、active、cleared | 是 |
| ACP-01 | ACP 初始化 | 启动 `mas --experimental-acp` | 发送 `initialize` | 返回 `serverInfo.name=mas` 和 prompt/cancel/close 能力 | 是 |
| ACP-02 | 新建会话 | ACP 已初始化 | 发送 `session/new` | 返回 sessionId、模式、模型、编排配置、skills metadata | 是 |
| ACP-03 | 命令公告 | `session/new` 后 | 监听 `session/update` | 收到 `/compact`、`/goal`、`/subgoal` 可用命令 | 是 |
| ACP-04 | 权限模式切换 | 以 `--approval-mode-policy mutable` 启动 | 发送 `session/set_mode default` | `currentModeId` 切为 `default` | 是 |
| ACP-05 | 编排模式切换 | 已建会话 | 发送 `session/set_config_option orchestrationMode` | 响应中的配置值更新 | 是 |
| ACP-06 | ACP 内置 Goal 命令 | 已建会话 | prompt `/goal set ...` | 不触发 Pi 模型，返回 `end_turn` 并发送创建消息 | 是 |
| ACP-07 | ACP 内置 Subgoal 命令 | 已建会话且有 Goal | prompt `/subgoal add ...` | 返回 `end_turn` 并发送追加消息 | 是 |
| ACP-08 | 会话压缩命令 | 已建会话 | prompt `/compact` | 返回 `end_turn`，发送压缩完成消息 | 是 |
| ACP-09 | 会话加载 | 已有 sessionId | `session/load` | 恢复指定 sessionId 并重放可用状态 | 是 |
| AUDIT-01 | output 内写入 | 构造审批记录和文件 | build + enforce audit gate | accept | 是 |
| AUDIT-02 | changed_files 漏报 | 构造未上报写入 | build + enforce audit gate | 留痕但不强制 revise | 是 |
| AUDIT-03 | 当前 output 外写入 | 构造根目录文件写入 | build + enforce audit gate | 强制 revise | 是 |
| AUDIT-04 | 历史越界已清理 | 构造历史写入但当前不存在 | build + enforce audit gate | 留痕但不强制 revise | 是 |
| AUDIT-05 | 当前只读输入写入 | 构造 data/template 写入 | build + enforce audit gate | 强制 revise | 是 |
| AUDIT-06 | 命令副作用污染只读输入 | baseline 后写入 data | build + enforce audit gate | 强制 revise，包含 boundary diff finding | 是 |
| AUTO-01 | 自主性状态查询 | 隔离 `MAS_HOME` | `mas autonomy status` | 输出 lease、scheduled、running | 是 |
| AUTO-02 | 自主性 tick 空跑 | 隔离 `MAS_HOME` | `mas autonomy tick` | 返回租约结果，无 due 任务时稳定完成 | 是 |
| RUN-01 | HA 直接回答 | Pi 模型认证可用 | `mas run "只回答 MAS_E2E_OK" --deny-writes` | 不请求写权限，run completed，messages/runs 有记录 | 待环境 |
| RUN-02 | HA/Ego 模式执行 | Pi 模型认证可用 | `mas run <只读总结任务> --orchestration-mode ha-ego --deny-writes` | HA 生成合同，Ego 完成，跳过 Superego，记录 Experience Graph | 待环境 |
| RUN-03 | HA/Ego/Superego 执行 | Pi 模型认证可用 | `mas run <只读总结任务> --orchestration-mode ha-ego-superego --deny-writes` | Superego 只读评审，最终 accept 或 needs_attention 有证据 | 待环境 |
| PERM-01 | CLI 默认拒绝写/命令 | Pi 模型认证可用且任务要求写文件 | `mas run <写 output>` 不加 `--approve-all` | 权限请求默认拒绝，审计记录 reject | 待环境 |
| PERM-02 | approve-all 审计 | Pi 模型认证可用且临时工作区可写 | `mas run <写 output>` 加 `--approve-all` | 工具调用允许，approval 和 event 表有记录 | 待环境 |
| AION-01 | AionUI 自定义 Agent smoke | AionUI 可启动 | 配置 `mas acp` 并新建会话 | AionUI 可完成 initialize/session/new，显示模型和命令 | 手工 |
| AION-02 | AionUI 权限弹窗 | AionUI 可启动且任务触发写/命令 | 默认模式执行写入任务 | AionUI 显示 `session/request_permission`，用户决策写入 approvals | 手工 |
| AION-03 | AionUI 会话恢复 | AionUI 可启动 | 发送消息、关闭、load session | 历史摘要和最近消息恢复 | 手工 |

## 测试数据策略

- 自动化测试使用 `mkdtemp` 创建临时 `MAS_HOME` 和临时工作区。
- 不读取或写入 `~/.mas/`、真实项目输出目录或用户长期 Pi 配置。
- 真实模型执行只允许在临时工作区运行；写入类任务必须限定 `output/`。

## 当前缺口

- `mas run` 真实模型链路需要本机 Pi 模型认证和可用 API key，不能在无认证环境中判定通过。
- AionUI UI 展示、权限弹窗和日志路径需要实际 AionUI 进程配合，当前自动化只验证 ACP JSON-RPC 后端行为。
- 现有项目没有测试框架断言 SQLite 表内容的专门集成测试；`e2e:smoke` 通过 CLI/ACP 用户可见结果间接验证。
