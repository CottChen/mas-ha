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

## 编排与自主性

MAS 当前把任务执行拆成四类内部责任：

- HA：面向用户的助理层，负责理解请求、澄清需求、生成验收合同和汇报结果。
- Ego：执行层，负责读取文件、运行命令、生成工件和提交结构化执行结果。
- Superego：评审层，负责基于验收合同、Ego 结果和系统审计证据判断是否接受、返工或升级人工介入。
- Id / Dream：低权限反思层，用于后续重组 Experience Graph、裁剪低价值反思和沉淀长期经验。

任务结束后，MAS 会把任务、结果、经验和未来反思意图写入 Experience Graph。反思任务写入 `reflection_tasks`，由全局 Node.js autonomy scheduler 跨会话唤醒。

推荐启动全局自主性调度器：

```bash
./bin/mas autonomy daemon --interval 60000
```

反思相关命令：

```bash
./bin/mas autonomy status
./bin/mas autonomy tick
./bin/mas reflect list
./bin/mas reflect due
./bin/mas reflect dream
```

Windows / AionUI 环境可以单独启动全局调度器：

```text
cd C:\Users\Administrator\projects\mas-ha-orchestration
C:\Users\Administrator\custom\mas-ha-orchestration-acp-gitbash.cmd autonomy daemon --interval 60000
```

完整设计见 [MAS 自主性设计记录](docs/AUTONOMY.md)，Goal 控制面与低熵自主性方案见 [Goal 控制面与低熵自主性改造方案](docs/GOAL_ENTROPY_CONTROL.md)，具体待办见 [MAS 自主性待办](docs/AUTONOMY_TODO.md)。

## Superego 审计门禁

Superego 不能只依赖 Ego 自报。MAS 在 Superego 评审前生成 `AuditPacket`，把系统级证据传给 Superego：

- 审批记录和原始工具输入。
- `write` / `edit` 工具写入路径。
- 执行命令摘要。
- Ego 自报的 `changed_files`。
- 写入路径与 `changed_files` 的对账结果。
- 是否存在历史 `output` 目录外写入，以及当前是否仍存在 `output` 目录外写入。
- 是否存在历史 `data` / `template` 只读输入路径写入，以及当前是否仍存在只读输入路径写入。

默认验收策略是“当前状态门禁 + 历史事实留痕”。当前仍存在 `output` 目录外写入、只读输入路径写入或失败验证伪装为成功时，即使模型评审返回 `accept`，MAS 也会通过确定性门禁把结论改为 `revise`。历史已清理的越界写入和 `changed_files` 漏报会保留在审计包中，要求 Superego 记录和评估修复是否充分，但不单独作为永久阻塞。

Superego 抽样复核采用“分层风险抽样 + 少量随机扰动”：必查样本覆盖用户强调点和验收硬约束，风险样本覆盖 Ego 风险项、审计发现和异常边界，少量随机样本用于抵抗只查高风险点带来的确认偏差。文件系统 snapshot/diff 不能默认做全量重审计，应采用边界目录轻量元数据 diff + 风险触发深查。

任务执行前，MAS 会在 HA 生成验收合同后由框架层创建轻量 baseline snapshot；Superego 评审前再创建 post snapshot 并生成 boundary diff。默认只比较文件清单、大小、修改时间和新增/修改/删除状态，不做 git diff 式逐行内容比较。该证据用于发现命令副作用，例如 bash 在只读输入目录中生成调试文件。

## 架构哲学

这次优化的核心目标是把 MAS 从“模型自评”推进到“证据闭环”：

- Ego 是行动器，负责产生结果，但不能单方面定义结果可信。
- Superego 是误差检测器，必须拿到独立证据，而不是只相信 Ego 摘要。
- Experience Graph 是长期记忆，记录任务、过程、结果、经验和反思之间的因果关系。
- Reflection 是延迟反馈，用外部低熵信息降低未来不确定性。
- Dream 是低权限图重组，用于裁剪、抽象和沉淀长期经验，而不是执行新任务。

借鉴的方法论：

- 控制论：通过执行、误差检测、反馈和再调度形成闭环。
- 信息论：反思只在能降低不确定性时保留，没有新信号时取消或裁剪。
- 软件工程审计：把工具调用、审批、写入和命令作为可追踪证据链。
- 代码审查：Superego 优先寻找缺陷、遗漏验证、越权和边界问题。
- 财务审计：不要求每次全量重算，而是基于风险做凭证核对、抽样复算和异常追踪。
- 生物学记忆巩固：Experience Graph 类似情景记忆，Dream 类似睡眠中的重组和突触修剪。

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

`--approve-all` 默认作为会话初始权限，并在会话内保持固定；如果需要允许 AionUI 会话过程中切换“默认”/“免确认”，追加：

```bash
/home/admin/mas-impl/bin/mas acp --approve-all --approval-mode-policy mutable
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
- 已实现 HA / Ego / Superego 的结构化输出基础能力：通过 Pi SDK typed tool 提交结果，再由 MAS 做业务校验和 repair 兜底。
- 已实现 Superego `AuditPacket` 和确定性审计门禁，覆盖工具写入路径、`changed_files` 对账、输出边界和只读输入边界。
- 已实现任务前 baseline snapshot、Superego 前 boundary metadata diff，可发现部分命令副作用造成的边界污染。
- 已实现 Experience Graph、`reflection_tasks`、`mas reflect list/due/dream` 和 ACP 进程内 Node.js timer 唤醒源。
- 已实现 Pi 工具事件到 ACP `session/update` 的映射。
- 已实现写、编辑、bash 的 ACP 权限请求。
- 已实现 SQLite run、agent_run、approval、audit、messages 和 session_context 记录。
- 已实现 AionUI 会话历史恢复、抽取式上下文压缩和 Pi 技能发现。
- 项目根目录的 `.env.local` 会在启动时自动加载，用于本地 worktree 差异配置。

生产阶段暂未包含 Temporal、PostgreSQL、NATS、对象存储和远程控制面。
