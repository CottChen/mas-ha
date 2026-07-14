# MAS 端到端测试计划

本文记录 MAS 系统的端到端测试范围、用例矩阵和当前自动化覆盖。长期有效的项目规则仍维护在 [../AGENTS.md](../AGENTS.md)，具体测试步骤和证据放在本文。

## 测试目标

- 验证 MAS 作为 CLI 和 ACP Agent 能启动、建会话、暴露能力并处理内置命令。
- 验证 Goal/Subgoal 控制面不会静默覆盖状态，且能写入 SQLite 事实记录。
- 验证 Superego 审计门禁能基于系统证据阻塞越界写入和只读输入污染。
- 验证自主性调度入口能获取租约、查询 due 任务、claim due job，并产出可审计的 Experience Graph / Reflection / Dream / Consolidation 过程产物。
- 验证真实失败、阻塞或低信息增益任务能触发自主性收口，而不是只在普通成功任务后生成表面产物。
- 验证真实 HA/Ego/Superego 执行链路在具备 Pi 模型认证时能完成任务、审计、持久化和反思调度。
- 验证 Dream 模式只操作 Experience Graph，不执行外部工具、不写用户工作区、不创建嵌套反思，并能产出图补丁候选和裁剪记录。

## 自动化入口

```bash
npm run typecheck
npm run doctor
npm run smoke:audit
npm run e2e:smoke
```

`e2e:smoke` 使用临时 `MAS_HOME` 和临时工作区，不依赖真实模型 API key，不写入用户长期 MAS 数据。

## 自主性输入设计原则

普通只读总结、固定回答、受控写入成功这类任务只能证明 MAS 的主链路和审计能转通，不能单独证明 MAS 有自主性。自主性测试必须故意制造一个需要系统在任务后继续处理的信息状态，例如失败验证、Superego 阻塞、缺少关键前置数据、用户纠正、重复失败、低信息增益或仍未关闭的 Goal。

有效输入应同时满足：

- 任务本身有明确验收合同，不能把“解释了失败”当作完成。
- 至少一个必要 validator 必须失败或未运行，并让 run 进入 `needs_attention`、`blocked` 或等价未完成状态。
- 禁止模型通过创建缺失输入、伪造证据或改写只读路径来绕过失败。
- 断言过程产物和最终产物分开成立：过程产物包括 failed verification、LowEntropySignal、EntropyLedger、EvalCandidate、reflection task、autonomy job、audit log；最终产物包括未完成 run 状态、due job 处理结果、DreamGraphPatch candidate、pruned 标记或后续 Goal 决策。
- Dream 只能操作 Experience Graph；任何用户工作区写入、外部工具调用或嵌套反思都应判失败。
- 长期任务必须包含 Goal/Subgoal、真实执行 run、至少一次自检纠偏、至少一个不可绕过的失败验证，以及后续 autonomy job 处理；只创建 Goal 或只做单轮输出都不能证明长期自主性。

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
| AUTO-06 | 真实 run 收口产物 | 真实或隔离 run 已 completed | 查询 SQLite：`experience_nodes`、`entropy_ledgers`、`low_entropy_signals`、`reflection_tasks`、`autonomy_jobs` | 过程产物包含 task/result/execution_trace/experience/signal/reflection；最终产物包含 scheduled reflection/consolidation jobs | 半自动 |
| AUTO-07 | due AutonomyJob claim | 种入 due reflection/dream/consolidation jobs | 执行 `mas autonomy tick --limit <n> --dream-limit <n>` 并查 SQLite 最终状态 | 获取 scheduler lease；due job 从 scheduled/running 进入 completed；wakeups 增加；payload 写入 decision/mode/patchNodeId | 半自动 |
| AUTO-08 | 自主性审计追踪 | AUTO-07 已执行 | 查询 `audit_log` | 记录 `autonomy_job_reflection_completed`、`dream_graph_patch_created`、`reflection_scheduler_tick`，能按 jobId/sourceRunId 追踪 | 半自动 |
| AUTO-09 | 真实失败触发自主性 | 真实模型可用，目标输入明确不存在 | AionUI 发送不可完成任务，要求读取缺失只读文件并提取字段，同时禁止创建、伪造或把错误包装成完成 | run 进入 `needs_attention`；Ego verification 至少一个 `failed`；EntropyLedger 包含 `validator_failed` 和 `run_not_completed`；生成 eval candidate、reflection/consolidation/dream jobs | 半自动 |
| AUTO-10 | 长期 Goal 自主性任务 | AionUI 新会话、真实模型可用 | `/goal set` 创建长期目标，追加 Subgoal，再发送包含错误初始假设和缺失 oracle 的执行任务 | run 绑定 active Goal；Goal turns/failures 更新；报告写入 output；Ego 自检纠正错误假设；最终 `needs_attention`；goal scoped signal/ledger/job 可追踪 | 半自动 |
| DREAM-01 | Dream 图补丁候选 | 种入 due dream job | tick 后查询 `experience_nodes.type=dream` | 生成 `DreamGraphPatch` candidate；`safety.graphOnly=true`、`touchesUserWorkspace=false`、`createsNestedReflection=false` | 半自动 |
| DREAM-02 | Dream 裁剪预算耗尽反思 | 种入 depth/maxDepth 或 wakeups/maxWakeups 耗尽的 `reflection_task` | tick 或 `mas reflect dream` 后查询 `reflection_tasks` | reflection task 进入 `pruned`，payload 包含 `prunedBy=dream` 和原因；用户工作区无新增文件 | 半自动 |
| DREAM-03 | 失败 run Dream patch | AUTO-09 已产生 due dream job | 将目标 run 的 dream job 置为 due 并执行 `mas autonomy tick`，再查 SQLite | 生成绑定失败 run 的 DreamGraphPatch candidate；reason 为 `low_information_gain_or_failure`；安全字段仍全部通过；不写用户工作区 | 半自动 |
| DREAM-04 | 长期 Goal Dream patch | AUTO-10 已产生 dream job | 将目标 run 的 reflection/consolidation/dream job 置为 due 并执行 `mas autonomy tick`，再查 SQLite | reflection/consolidation/dream job completed；DreamGraphPatch candidate 绑定目标 run；audit 可追踪；不得写用户工作区 | 半自动 |
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
- 真实模型执行只允许在临时工作区运行；写入类任务必须在验收合同中声明允许输出边界。只有报告、表格等单一产物任务默认建议限定 `output/`；greenfield 应用开发可以声明 workspace 根目录为源码产物边界。
- 失败触发自主性用例必须使用唯一缺失输入路径，并显式要求不得创建、写入、伪造或把失败当作完成。
- 自主性和 Dream 用例优先绑定到已完成的真实 run 或隔离 run，只写 MAS SQLite 自主性表；不得通过 Dream 写用户工作区。
- 过程产物必须和最终产物分开断言：过程产物包括 claim、lease、audit、signal、ledger、graph node、job payload；最终产物包括 run/job/reflection 的最终状态、DreamGraphPatch、pruned 标记和可追踪 evidence。

## 当前缺口

- 默认审批模式下的 AionUI 权限弹窗仍需要实际 AionUI 进程配合。
- `ha-ego` 真实模型模式、ACP cancel 长任务和多会话并发仍需要专门场景。
- 现有 `mas autonomy tick` stdout 返回的是 claim 快照，最终状态仍需查 SQLite；建议后续增加专门集成测试断言 CLI 输出与最终 DB 状态一致。
- 自然反思和 Dream 的触发时间较长，端到端测试需要可控 clock 或受控 `trigger_at` 注入，否则很难稳定验证 due job 行为。
- 当前 `goal_continuation` job 会在用户普通 prompt 到来时被取消，长期 Goal 的后续自主推进只保留控制面判断，不会自动递归启动新的 Pi run；需要专门用例确认这是预期设计还是实现缺口。
- `runDueAutonomyJobs` 处理 reflection job 后会更新 `reflection_tasks` 和 job 状态，但原 `experience_nodes.type=reflection` 节点可能仍保持 `scheduled`，建议补图节点状态同步断言。
- `LowEntropySignalType` 已声明 `user_feedback`，但当前 run 收口主要从 verification、approval、audit、diff 和 critique 收集信号；用户纠正是否能自动沉淀为低熵信号仍需补 AionUI 真实用例和代码级断言。
