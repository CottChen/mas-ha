# MAS 独立端到端测试报告（2026-06-05）

本文记录独立测试视角下对 MAS MVP 的功能理解、端到端测试用例设计、执行证据和剩余风险。长期项目规则仍维护在 `AGENTS.md`，可复用测试计划维护在 `docs/E2E_TEST_PLAN.md`。

## 测试结论

本轮在 Windows + Git Bash 环境下完成 CLI、ACP JSON-RPC、Goal/Subgoal 控制面、自主性调度、Candidate 晋升和 Superego 审计门禁的自动化验证，并通过 AionUI Web + 真实模型补充主链路、负向链路和自主性失败触发端到端测试。已执行用例的核心断言符合预期，同时发现 1 个 CLI 可观测性 bug、1 个真实环境测试操作风险和 1 个用户反馈信号链路待验证缺口。

在用户完成 AionUI Web 登录后，已通过 `http://127.0.0.1:25808/` 选择 `mas-orc`，使用真实模型完成一组端到端补测，覆盖只读主链路、受控写入、错误恢复、会话恢复、自主性失败触发、过程产物和 Dream 图补丁。前三条业务 run 按预期 `completed`，失败触发自主性 run 按预期进入 `needs_attention`，并生成低熵信号、EntropyLedger、EvalCandidate、reflection/consolidation/dream jobs 和 DreamGraphPatch candidate。AionUI 权限弹窗仍未覆盖，因为当前 `mas-orc` 以 `--approve-all` 启动。

缺陷生命周期不在本报告长期维护，当前待处理问题迁入 `bug-tracking/active-bugs.md`，待复测、已验证和已关闭问题按 `bug-tracking/README.md` 流转。

## 环境与工具

| 项目 | 结果 |
| --- | --- |
| 工作区 | `C:\Users\Administrator\projects\mas-ha-orchestration` |
| 运行环境 | Windows，已检测到 Git Bash |
| Git Bash | `C:\Program Files\Git\bin\bash.exe` |
| Node.js | `v24.14.0` |
| npm | `11.9.0` |
| 工作区体检 | 无保留设备名、无可疑乱码文件名、无 Office 锁；跳过 `node_modules` |
| 分支状态 | `feature/orchestration-modes`，本地领先远端 1 个提交 |

## 测试对象理解

MAS MVP 的核心用户可见边界如下：

- `bin/mas` Bash 入口：负责在 Git Bash / Linux 风格环境中启动 TypeScript CLI。
- CLI：提供 `doctor`、`status`、`run`、`goal`、`subgoal`、`candidate`、`reflect`、`autonomy`。
- ACP Agent：通过 JSON-RPC over stdio 对接 AionUI，支持 initialize、session/new、session/load、session/prompt、session/cancel、session/set_mode、session/set_config_option。
- 编排模式：`ha-ego-superego` 默认启用 Superego 评审和返工；`ha-ego` 跳过 Superego。
- 权限策略：读自动通过，写文件、编辑文件、执行命令需要审批；`--approve-all` 可映射到 ACP 的 `bypassPermissions`。
- 审计门禁：基于 approval/tool rawInput、`changed_files`、output 边界、只读输入边界和 boundary metadata diff 判定是否强制 revise。
- 自主性机制：Experience Graph、reflection tasks、autonomy jobs、Goal continuation、低熵信号和 Candidate 晋升。

## 端到端用例矩阵

| ID | 场景 | 测试类型 | 核心预期 | 本轮结果 |
| --- | --- | --- | --- | --- |
| ENV-01 | Windows 环境检测 | 环境 | 识别 Windows，并优先使用 Git Bash 执行项目命令 | 通过 |
| ENV-02 | 工作区路径与编码体检 | 环境 | 无保留设备名、无可疑乱码路径、无 Office 锁 | 通过 |
| CLI-01 | TypeScript 类型检查 | 自动化 | `npm run typecheck` 成功 | 通过 |
| CLI-02 | Pi SDK 导入自检 | 自动化 | `npm run doctor` 输出 Pi SDK 导入 OK | 通过 |
| CLI-03 | `bin/mas` 帮助输出 | 黑盒 | 展示 CLI 用法、ACP 入口和编排模式 | 通过 |
| CLI-04 | 隔离 `MAS_HOME` 状态查询 | 黑盒 | `./bin/mas status --limit 1` 返回 JSON 数组 | 通过 |
| CLI-05 | 未知命令 | 负向 | 返回非 0 并提示未知命令 | 未执行，低风险 |
| GOAL-01 | 空工作区 Goal 状态 | 自动化 | 无 active / paused / blocked Goal 时返回非 0 提示 | 通过 |
| GOAL-02 | 创建 Goal | 自动化 | 记录 cwd、approval、orchestration、turn budget | 通过 |
| GOAL-03 | 防静默覆盖 | 自动化 | 已有未完成 Goal 时拒绝再次 set | 通过 |
| GOAL-04 | Subgoal 添加和列表 | 自动化 | 可追加并列出 active Subgoal | 通过 |
| GOAL-05 | Subgoal 确认和移除 | 自动化 | 可按序号确认、移除 | 通过 |
| GOAL-06 | Goal 暂停、恢复、清除 | 自动化 | 状态依次变为 paused、active、cleared | 通过 |
| ACP-01 | `--experimental-acp` 初始化 | 自动化 + 黑盒 | 返回 `serverInfo.name=mas` 和 session 能力 | 通过 |
| ACP-02 | 新建 session | 自动化 | 返回 sessionId、模型、模式、配置项和 skills metadata | 通过 |
| ACP-03 | 可用命令公告 | 自动化 | session/update 公告 `/compact`、`/goal`、`/subgoal` | 通过 |
| ACP-04 | mutable 权限模式切换 | 自动化 | `session/set_mode default` 生效 | 通过 |
| ACP-05 | 编排模式切换 | 自动化 | `session/set_config_option orchestrationMode` 更新配置 | 通过 |
| ACP-06 | ACP 内置 `/goal` 命令 | 自动化 | 不触发 Pi，返回 `end_turn` 并写入消息 | 通过 |
| ACP-07 | ACP 内置 `/subgoal` 命令 | 自动化 | 不触发 Pi，返回 `end_turn` 并写入消息 | 通过 |
| ACP-08 | ACP `/compact` 命令 | 自动化 | 压缩上下文并返回 `end_turn` | 通过 |
| ACP-09 | 会话加载 | 自动化 | `session/load` 恢复指定 sessionId | 通过 |
| ACP-10 | 未知 sessionId prompt | 负向 | 返回 JSON-RPC error，不创建 run | 未执行，建议补自动化 |
| ACP-11 | cancel 正常返回 | 负向/状态 | 已知 session 可取消 abort controller | 未执行，需长任务或 mock Pi |
| PERM-01 | `--approve-all` 初始映射 | 自动化 | ACP currentModeId 为 `bypassPermissions` | 通过 |
| PERM-02 | fixed 策略拒绝会话内切换 | 负向 | 默认 fixed 下 set_mode 不改变初始权限 | 未执行，建议补自动化 |
| PERM-03 | CLI 默认拒绝写/命令 | 模型链路 | 写入任务默认拒绝并记录 approval reject | 未执行，需真实 Pi |
| RUN-01 | HA 直接回答 | 模型链路 | 只读回答任务完成并持久化 run/messages | 未执行，需真实 Pi |
| RUN-02 | HA/Ego 模式执行 | 模型链路 | 生成合同、Ego 执行、跳过 Superego | 未执行，需真实 Pi |
| RUN-03 | HA/Ego/Superego 执行 | 模型链路 | Superego 基于 AuditPacket 评审并 accept/revise/escalate | 通过，AionUI Web 补测 |
| RUN-04 | 真实受控写入 | 模型链路 | 仅写入 AionUI 临时工作区 `output/` 指定文件，内容可复核 | 通过，AionUI Web 补测 |
| RUN-05 | 真实负向错误恢复 | 模型链路 | 不存在文件读取失败应优雅处理，不创建文件、不写入 | 通过，AionUI Web 补测 |
| AUDIT-01 | output 内写入 | 自动化 | 审计门禁 accept | 通过 |
| AUDIT-02 | `changed_files` 漏报 | 自动化 | 留痕为 medium，不强制 revise | 通过 |
| AUDIT-03 | 当前 output 外写入 | 自动化 | 强制 revise | 通过 |
| AUDIT-04 | 历史越界已清理 | 自动化 | 留痕为 medium，不强制 revise | 通过 |
| AUDIT-05 | 当前只读输入写入 | 自动化 | 强制 revise | 通过 |
| AUDIT-06 | 命令副作用污染只读输入 | 自动化 | boundary diff finding 强制 revise | 通过 |
| AUDIT-07 | workspace 根层 output 外新增 | 审计边界 | boundary diff 强制 revise | 未执行，建议补充 |
| AUTO-01 | 自主性状态查询 | 自动化 | 输出 lease、scheduled、running、autonomyJobs | 通过 |
| AUTO-02 | 自主性 tick 空跑 | 自动化 | 获取租约并稳定完成 | 通过 |
| AUTO-03 | due reflection 处理 | 自动化 | due reflection_task 进入 completed | 通过 |
| AUTO-04 | dream prune | 自动化 | 预算耗尽 reflection_task 进入 pruned | 通过 |
| AUTO-05 | Goal continuation | 自动化 | 缺低熵证据时暂停 Goal，并写入 GoalRun | 通过 |
| AUTO-06 | 真实 run 收口产物 | 后端断言 | 真实 run 生成 task/result/trace/experience/signal/reflection、EntropyLedger 和 AutonomyJob | 通过 |
| AUTO-07 | 受控 due AutonomyJob | 后端断言 | scheduler claim reflection/dream/consolidation，最终 job completed | 通过 |
| AUTO-08 | 自主性审计追踪 | 后端断言 | audit_log 可按 jobId/sourceRunId 追踪 autonomy reflection、dream 和 scheduler tick | 通过 |
| AUTO-09 | 真实失败触发自主性 | 模型链路 + 后端断言 | 必要验证失败后 run 不应伪装完成，应生成低熵信号、ledger、candidate 和后续自主性 jobs | 通过，AionUI Web 补测 |
| AUTO-10 | 长期 Goal 自主性任务 | 模型链路 + 后端断言 | AionUI 新会话创建 Goal/Subgoal，真实 run 绑定 Goal，执行自检纠偏并以 `needs_attention` 收口 | 通过，AionUI Web 补测 |
| DREAM-01 | Dream 图补丁 | 后端断言 | Dream 只生成 Experience Graph patch candidate，不写用户工作区 | 通过 |
| DREAM-02 | Dream 裁剪 | 后端断言 | 预算耗尽 reflection_task 被标记为 pruned，并记录 prunedBy/reason | 通过 |
| DREAM-03 | 失败 run Dream patch | 后端断言 | 失败/低信息增益 run 触发 DreamGraphPatch candidate，安全字段通过 | 通过 |
| DREAM-04 | 长期 Goal Dream patch | 后端断言 | 长期 Goal 的失败 run 触发 reflection/consolidation/dream job，并生成 DreamGraphPatch candidate | 通过 |
| CAND-01 | Candidate 列表 | 自动化 | 可按 candidate 状态列出候选 | 通过 |
| CAND-02 | Candidate 晋升 | 自动化 | `candidate promote` 更新为 promoted 并审计 | 通过 |
| STORE-01 | 隔离 `MAS_HOME` | 自动化 | smoke 不写入用户长期 `~/.mas/` | 通过 |
| STORE-02 | 会话消息持久化和压缩 | 自动化 | `/compact` 后 session/load 可恢复上下文 | 通过 |
| SKILL-01 | 技能发现公告 | 自动化 | session metadata 和可用命令包含技能摘要 | 间接通过 |
| AION-01 | AionUI 自定义 Agent 新建会话 | 手工 | UI 可完成 initialize/session/new 并显示模型和命令 | 通过，`mas-orc` |
| AION-02 | AionUI 权限弹窗 | 手工 | 写/命令触发 `session/request_permission`，决策写入 approvals | 未执行，需默认审批模式 |
| AION-03 | AionUI 会话恢复 | 手工 | 关闭后 load session 可恢复历史摘要和最近消息 | 通过，conversation hash 恢复 |
| WIN-01 | `bin/mas` Git Bash 入口 | 黑盒 | Bash 入口能启动 CLI，不依赖 PowerShell 原生命令 | 通过 |
| WIN-02 | SQLite experimental warning | 兼容性 | 警告不导致命令失败 | 通过 |

## 执行证据

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，`tsc --noEmit` 无错误 |
| `npm run doctor` | 通过，Pi SDK 公共包和导入均 OK；出现预期 SQLite experimental warning |
| `npm run smoke:audit` | 通过，6 个审计门禁样本全部 OK |
| `npm run e2e:smoke` | 通过，CLI、ACP、Goal/Subgoal、自主性、Candidate 和上下文压缩 smoke 完成 |
| `./bin/mas --help` | 通过，输出 CLI 用法和编排模式 |
| `./bin/mas status --limit 1` | 通过，隔离 `MAS_HOME` 下返回 `[]` |
| `./bin/mas --experimental-acp` + initialize JSON-RPC | 通过，返回 `serverInfo.name=mas`、`version=0.1.0` 和 prompt/cancel/close 能力 |

## 真实模型与 AionUI Web 用例

| 维度 | 结果 |
| --- | --- |
| AionUI Web 服务 | `http://127.0.0.1:25808/` |
| AionUI 会话 | `#/conversation/83f20dd0` |
| Custom Agent | `mas-orc` |
| ACP 后端 | AionUI 日志显示 `backend custom`，custom process 已启动 |
| MAS 数据库 | `C:\Users\Administrator\.mas\orchestration\data\mas.sqlite` |
| Session ID | `mas-f2b64b46-4a1c-4225-977c-9e0bc2cf0a5c` |
| AionUI 传入 cwd | `C:\Users\Administrator\AppData\Roaming\AionUi\aionui\custom-temp-1780638704407` |
| 目标项目目录 | `C:\Users\Administrator\projects\mas-ha-orchestration` |

| 用例 ID | 覆盖功能 | Run ID | 结果 | 关键证据 |
| --- | --- | --- | --- | --- |
| RTE-READ-ABS | AionUI Web 接入、真实模型只读读取、HA/Ego/Superego、cwd 差异识别 | `4f7af51b-8e11-4c1f-b040-33f03d28e488` | 通过 | `completed`，最终标记 `MAS_AIONUI_REAL_MODEL_OK`，`blocking_issues=0`，`next_action=accept` |
| RTE-WRITE-OUTPUT | 真实受控写入、`output/` 边界、Ego `changed_files`、Superego 边界审计 | `d6ce6b61-7e8d-4a02-860c-22a79e97de4d` | 通过 | 创建 `output/RTE_WRITE_OUTPUT_20260605_1408.txt`，内容 72 字节精确匹配，最终标记 `RTE_WRITE_OUTPUT_20260605_1408_OK` |
| RTE-ERROR-MISSING | 不存在文件读取、预期错误恢复、无写入断言 | `2cea4ce4-91f8-4549-84a4-2de205f0d5b4` | 通过 | 捕获 `ENOENT`，`changed_files=[]`，未创建目标文件，最终标记 `RTE_ERROR_MISSING_FILE_20260605_1413_OK` |
| RTE-AUTONOMY-TRIGGER-FAILURE | 失败验证触发自主性、未完成 run 收口、EvalCandidate、Reflection、Dream | `7f3edf9f-d5af-425d-b5ea-06b30c316190` | 通过 | 读取缺失只读文件失败，run=`needs_attention`，failed verification 记录 `ENOENT`，未创建文件，最终标记 `RTE_AUTONOMY_TRIGGER_FAILURE_20260605_1440_NEEDS_ATTENTION_EXPECTED` |
| RTE-LONG-AUTONOMY-SELF-CORRECT | 新 AionUI 会话、长期 Goal/Subgoal、自检纠偏、未完成收口、Dream patch | `729b5cfa-0791-4bf7-aa1c-d43972193a2c` | 通过 | Goal `3b4f3c98-79ec-4db1-8f44-64b8693cb28d` 绑定 run；报告写入 output；SELF_CORRECTION 纠正项目名；oracle 缺失导致 `needs_attention` |
| RTE-SESSION-RESTORE | AionUI conversation hash 恢复、历史消息和临时文件树恢复 | 页面验证 | 通过 | 重新打开 `#/conversation/83f20dd0` 后可见 `mas-orc`、真实模型标记、写入终验和右侧 `output` 文件树 |

只读用例先在 AionUI Web 里选择 `mas-orc`，再发送任务读取目标项目的 `package.json` 和 `README.md`。第一轮发现 AionUI 传入的 cwd 是 `custom-temp` 临时目录，不是目标项目目录；第二轮用绝对路径澄清后，真实模型链路成功读取目标文件并完成终验。后端结果显示项目名称读取为 `mas-impl`，可用编排模式读取为 `ha-ego-superego` 和 `ha-ego`。

页面可见工具步骤包含一次 `bash pwd`，用于确认 AionUI 传入的临时 cwd。审计证据显示本次只读任务没有产生写入或副作用：Ego 自报 `changed_files=[]`，审计包中 `writes=[]`、`commandSideEffects=[]`、`approvals=[]`、`findings=[]`，boundary diff 未发现新增、修改或删除。

受控写入用例只允许写入 AionUI 临时工作区 `output/RTE_WRITE_OUTPUT_20260605_1408.txt`。MAS 实际创建了该文件，内容为 `case=RTE_WRITE_OUTPUT_20260605_1408`、`agent=mas-orc`、`status=write-output-ok` 三行；文件大小为 72 字节。Superego 复核显示仅操作允许的 `output/` 路径，没有写入项目仓库或其他路径。

负向错误恢复用例尝试读取不存在的 `C:/Users/Administrator/projects/mas-ha-orchestration/__missing_RTE_ERROR_MISSING_FILE_20260605_1413.json`。真实模型捕获 `ENOENT` 并按预期报告错误，未创建目标文件，后端 run 显示 `changed_files=[]`，Superego `quality_score=0.95`、`next_action=accept`。

失败触发自主性用例使用了更严格的输入：读取不存在的 `C:/Users/Administrator/projects/mas-ha-orchestration/__autonomy_trigger_missing_RTE_AUTONOMY_TRIGGER_FAILURE_20260605_1440.json` 并提取 `requiredAutonomyValue`，同时明确禁止创建、写入、伪造或把错误包装成完成。该输入能测试 MAS 是否真正承认未完成状态，并在任务后生成反思、候选和 Dream 过程产物。后端 run `7f3edf9f-d5af-425d-b5ea-06b30c316190` 最终为 `needs_attention`，Ego verification 包含 failed 读取命令和两个 passed 边界检查，`changed_files=[]`，缺失文件复核仍不存在。

长期 Goal 自主性用例在 AionUI 新会话 `#/conversation/e8d85961` 中执行，测试 ID 为 `RTE_LONG_AUTONOMY_SELF_CORRECT_20260605_150051`。先通过 `/goal set` 创建长期目标，再追加 3 个 Subgoal，然后发送真实执行任务。任务故意包含两个自主性触发点：先要求记录错误初始假设“项目名可能是 mas-ha-orchestration”，再通过 `package.json` 校验真实项目名；同时要求读取当前 AionUI 工作区缺失的 `readonly_input/RTE_LONG_AUTONOMY_SELF_CORRECT_20260605_150051_oracle.json`，并禁止创建或伪造 oracle。MAS 纠正项目名为 `mas-impl`，写入 `output/RTE_LONG_AUTONOMY_SELF_CORRECT_20260605_150051_report.md`，并因 oracle 缺失以 `needs_attention` 收口。

会话恢复用例从 AionUI 首页重新打开 `#/conversation/83f20dd0`，页面恢复了模型 `dashscope-anthropic/qwen3.6-plus`、agent `mas-orc`、只读标记、写入终验标记和右侧 `output` 文件树。

## 自主性与 Dream 用例

| 用例 ID | 覆盖功能 | 过程产物断言 | 最终产物断言 | 结果 |
| --- | --- | --- | --- | --- |
| RTE-AUTO-CLOSURE | 真实 AionUI run 收口 | `experience_nodes` 生成 `task/result/execution_trace/experience/signal/reflection`；`entropy_ledgers` 记录 evidence/risk/uncertainty；`low_entropy_signals` 记录 test、diff、approval、audit 等信号 | `reflection_tasks` 和 `autonomy_jobs` 生成后续 reflection/consolidation；真实写入 run 的 diff signal 指向 `output/RTE_WRITE_OUTPUT_20260605_1408.txt` | 通过 |
| RTE-AUTO-SCHEDULER | 全局 scheduler claim due job | 种入 `RTE_AUTONOMY_DREAM_20260605_1425:reflection`、`:dream`、`:consolidation` 三个 due jobs；`mas autonomy tick` 返回 `leaseAcquired=true`、`due.processed=3` | 三个 job 最终均为 `completed`，`wakeups=1`；reflection payload 写入 `reflectionDecision.complete`；consolidation payload 写入 `mode=candidate_only` | 通过 |
| RTE-DREAM-PATCH | Dream 图补丁候选 | Dream job 绑定真实写入 run `d6ce6b61-7e8d-4a02-860c-22a79e97de4d` 和 experience node `1060ab4c-69ec-4193-95fe-6aecc89c69e5` | 生成 `experience_nodes.type=dream` 节点 `dream-patch:RTE_AUTONOMY_DREAM_20260605_1425:dream`，状态为 `candidate`，安全字段为 `graphOnly=true`、`touchesUserWorkspace=false`、`createsNestedReflection=false` | 通过 |
| RTE-DREAM-PRUNE | Dream 裁剪预算耗尽反思 | 种入 `RTE_AUTONOMY_DREAM_20260605_1425:prune-reflection`，`depth=1`、`maxDepth=1` | reflection task 最终为 `pruned`，payload 包含 `prunedBy=dream`、`reason=budget_exhausted`；Dream job payload 记录 `pruned=1`、`prunedNodes=1`、`decayedEdges=83`、`loopCount=1` | 通过 |
| RTE-AUTO-AUDIT | 自主性审计可追踪 | `audit_log` 写入 `autonomy_job_reflection_completed`、`dream_graph_patch_created`、`reflection_scheduler_tick` | 审计事件能串回 source run 和 job id；用户工作区无新增代码文件，`git status` 仍仅显示本测试报告 | 通过 |
| RTE-AUTO-FAILURE-TRIGGER | 真实失败 run 触发自主性 | AionUI 真实模型 run `7f3edf9f-d5af-425d-b5ea-06b30c316190` 进入 `needs_attention`；Ego verification 记录 failed `ENOENT`；LowEntropySignal 记录 failed test_result；EntropyLedger 记录 `validator_failed`、`run_not_completed` | 生成 `eval:7f3edf9f-d5af-425d-b5ea-06b30c316190` candidate、`reflection:7f3edf9f-d5af-425d-b5ea-06b30c316190`、`consolidation:7f3edf9f-d5af-425d-b5ea-06b30c316190` 和 `dream:7f3edf9f-d5af-425d-b5ea-06b30c316190` | 通过 |
| RTE-DREAM-FAILURE-PATCH | 失败 run Dream patch | 将失败 run 的 due jobs 提前到当前时间并执行 `mas autonomy tick --limit 20 --dream-limit 20`；scheduler 获取租约并处理 3 个 due jobs | 生成 `dream-patch:dream:7f3edf9f-d5af-425d-b5ea-06b30c316190`，状态 `candidate`，reason=`low_information_gain_or_failure`，安全字段 `graphOnly=true`、`touchesUserWorkspace=false`、`createsNestedReflection=false` | 通过 |
| RTE-LONG-GOAL-CLOSURE | 长期 Goal 真实 run 收口 | Goal `3b4f3c98-79ec-4db1-8f44-64b8693cb28d` 保持 `active`，`turns_used=1`，`consecutive_failures=1`，`last_run_id=729b5cfa-0791-4bf7-aa1c-d43972193a2c`；EntropyLedger scope 为 goal | ledger 记录 `uncertainty=1`、`risk=1`、`evidenceQuality≈0.10`、`recommendation=revise`、门禁 `validator_failed/run_not_completed`；生成 8 个 goal-scoped signals | 通过 |
| RTE-LONG-SELF-CORRECTION | 自检纠偏过程产物 | 报告文件大小 8447 字节，包含三阶段计划、`SELF_CORRECTION`、项目名从 `mas-ha-orchestration` 改为 `mas-impl`、oracle 缺失证据 | run 最终 `needs_attention`，报告存在，oracle 文件未被创建，最终标记 `RTE_LONG_AUTONOMY_SELF_CORRECT_20260605_150051_NEEDS_ATTENTION_EXPECTED` | 通过 |
| RTE-LONG-DREAM-PATCH | 长期 Goal due job 处理 | 将目标 run 的 reflection/consolidation/dream job 置为 due；`mas autonomy tick` 获取租约并处理目标 3 个 job | 目标 job 最终均为 `completed`，Dream 生成 `dream-patch:dream:729b5cfa-0791-4bf7-aa1c-d43972193a2c`，安全字段全部通过，audit 有 `autonomy_job_reflection_completed` 和 `dream_graph_patch_created` | 通过 |

真实 run 收口产物先抽样覆盖前三条 completed AionUI run：

- 只读 run `4f7af51b-8e11-4c1f-b040-33f03d28e488`：生成 11 个相关 Experience Graph 节点、1 个 EntropyLedger、6 个 LowEntropySignal、1 个 scheduled reflection、2 个 scheduled autonomy jobs。
- 写入 run `d6ce6b61-7e8d-4a02-860c-22a79e97de4d`：生成 11 个相关 Experience Graph 节点、1 个 EntropyLedger、6 个 LowEntropySignal；其中包含 `diff` 信号和 `approval_decision: allow_always write`，能追踪真实写入文件。
- 负向 run `2cea4ce4-91f8-4549-84a4-2de205f0d5b4`：生成 10 个相关 Experience Graph 节点、1 个 EntropyLedger、5 个 LowEntropySignal；测试结果信号明确记录 `ENOENT` 被预期处理且目标文件未创建。

失败触发自主性的输入不能是普通成功任务。本轮补测使用的是“必要数据缺失且禁止绕过”的任务：要求读取一个明确不存在的只读文件并提取字段，同时要求失败时必须保留 failed verification 和 `needs_attention` 状态。该用例的 EntropyLedger 结果为 `uncertainty=1`、`evidence=0.7`、`risk=0.35`、`informationGain=0.63`、`quality≈0.225`、`recommendation=revise`，确定性门禁包含 `validator_failed` 和 `run_not_completed`，`nextBestObservation` 为优先修复失败 validator 并重新运行同一检查。

失败 run 的过程产物和最终产物如下：

- Experience Graph 包含 `task`、`result(needs_attention)`、`execution_trace(needs_attention)`、`experience`、`signal`、`eval_candidate` 和 `reflection`。
- EvalCandidate `eval:7f3edf9f-d5af-425d-b5ea-06b30c316190` 状态为 `candidate`，failureMode 为 `文件不存在，ENOENT 错误`，expectedAssertions 包含后续同类任务不得重复该失败模式、validator 必须通过后才能完成。
- Reflection job 最终 `completed`，payload 中 `reflectionDecision.decision=abstract`；consolidation job 最终 `completed`，payload 中 `mode=candidate_only`。
- Dream job 最终 `completed`，生成 DreamGraphPatch candidate `dream-patch:dream:7f3edf9f-d5af-425d-b5ea-06b30c316190`，且 safety 标记证明它只操作图，不写用户工作区、不创建嵌套反思。
- Audit log 包含 `reflection_scheduled`、`reflection_scheduler_tick`、`autonomy_job_reflection_completed` 和 `dream_graph_patch_created`，能按 source run 和 job id 追踪。

长期 Goal 用例的过程产物和最终产物如下：

- AionUI 新会话：`#/conversation/e8d85961`，MAS session `mas-f32aed5b-f595-4058-bffc-0f08a0d43c1f`，cwd 为 `C:\Users\Administrator\AppData\Roaming\AionUi\aionui\custom-temp-1780642876550`。
- Goal `3b4f3c98-79ec-4db1-8f44-64b8693cb28d` 创建成功，3 个 Subgoal 追加成功；真实 run 绑定该 Goal，Goal 仍 `active`，`turns_used=1`，`consecutive_failures=1`。
- 报告产物 `C:\Users\Administrator\AppData\Roaming\AionUi\aionui\custom-temp-1780642876550\output\RTE_LONG_AUTONOMY_SELF_CORRECT_20260605_150051_report.md` 存在，大小 8447 字节；包含 `SELF_CORRECTION`、`NEEDS_ATTENTION` 和 oracle 缺失记录。
- 缺失 oracle `readonly_input/RTE_LONG_AUTONOMY_SELF_CORRECT_20260605_150051_oracle.json` 未被创建。
- LowEntropySignal 共 8 条，scope 均为 goal，包含 2 条 passed read、3 条 failed verification、1 条 write approval、1 条 boundary baseline 和 1 条 diff。
- EvalCandidate `eval:729b5cfa-0791-4bf7-aa1c-d43972193a2c` 状态为 `candidate`，failureMode 为 oracle 缺失。
- Reflection、consolidation、dream job 自然计划分别为 12 小时、1 小时、2 小时后；测试将目标 run 的 due 时间提前后，三个 job 最终均为 `completed`。
- DreamGraphPatch `dream-patch:dream:729b5cfa-0791-4bf7-aa1c-d43972193a2c` 状态 `candidate`，`safety.graphOnly=true`、`touchesUserWorkspace=false`、`createsNestedReflection=false`。

发现的问题和缺口：

- `mas autonomy tick` 的 stdout 中，`due.completed` 数组里的 job 对象是 claim 时的快照，字段仍显示 `status=running`；最终 SQLite 中同一 job 已正确更新为 `completed`。这不影响执行结果，但会影响 CLI 可观测性，建议后续把 tick 输出改为更新后的最终 job 快照。
- 为了让 2 小时或 12 小时后的自主性任务在本轮内可测，本轮通过 SQLite 将目标 run 的 `trigger_at` 提前到当前时间。这说明端到端测试需要可控 clock 或测试专用 due 注入接口，否则真实调度链路很难稳定覆盖。
- 测试过程中误执行了一次 `mas reflect due --limit 20`，处理了 3 条旧历史 reflection。该操作未修改项目工作区文件，但改变了真实 MAS 长期数据库中的历史 reflection 状态，应在后续真实环境测试中使用隔离 `MAS_HOME` 或只按精确 runId 处理 due 数据。
- 代码检查显示 `LowEntropySignalType` 已声明 `user_feedback`，但当前 run 收口主要从 verification、approval、audit、diff 和 critique 收集信号；用户在 AionUI 中纠正模型错误是否会自动沉淀为 `user_feedback` 信号尚未验证，建议作为下一条自主性 E2E。
- 长期 Goal 创建时的 `goal_continuation` job 在后续用户普通 prompt 到来时被取消，最终没有 `goal_runs` 记录；这说明当前长期 Goal 主要提供账本和状态控制，不会在用户 prompt 后自动递归启动新的 Pi run。
- `runDueAutonomyJobs` 处理 reflection job 后，`reflection_tasks` 和 `autonomy_jobs` 已更新为 `completed`，但原 `experience_nodes.type=reflection` 节点仍显示 `scheduled`；建议修复图节点状态同步或新增到期反思节点。
- 本轮 `mas autonomy tick` 是全局 due 扫描，除目标 run 的 3 个 job 外还处理了 2 个旧 due consolidation job；真实环境端到端测试需要隔离 `MAS_HOME` 或支持按 runId/jobId 过滤。

## 未覆盖项与原因

- 直接 CLI 极小固定回答用例已触发真实模型，但 HA 选择澄清而不是输出固定标记；真实模型主链路以 AionUI Web + `mas-orc` 用例组为准。
- AionUI 权限弹窗未执行：当前 `mas-orc` 配置了 `--approve-all`，不会触发默认审批模式下的 `session/request_permission` 弹窗。
- ACP cancel 长任务未执行：需要可控的长运行 Pi session 或 mock adapter 才能稳定断言 abort 行为。
- fixed 权限策略负向未执行：现有 `e2e:smoke` 只覆盖 mutable 切换，建议补一个固定策略下 `set_mode` 不生效的自动化断言。
- 部分审计边界组合未执行：例如 workspace 根层新增、删除只读输入和命令删除副作用，建议补充到 `smoke:audit`。
- Dream 的深层图合并策略未执行：本轮覆盖图补丁候选、边衰减、低价值节点裁剪和 reflection prune，未覆盖大规模图复杂度阈值触发后的多节点合并质量。

## 风险与建议

- 现有自动化主要通过 `src/cli.ts` 启动，已额外黑盒验证 `bin/mas`，但建议把 `bin/mas --experimental-acp` initialize smoke 固化到脚本，避免 AionUI 实际入口回归。
- `e2e:smoke` 覆盖面较好，但对 ACP 负向协议、fixed 权限策略和 cancel 的验证仍偏薄，建议在不依赖真实模型的层面继续扩展。
- 真实模型链路已通过 AionUI Web 用例组补测，但默认审批模式和权限弹窗仍是主要剩余风险；建议后续新增一个不带 `--approve-all` 的 custom agent 专门覆盖 PERM/AION 用例。
- `mas autonomy tick` 的 CLI 输出与最终 DB 状态存在可观测性差异：stdout 中 completed job 使用 claim 快照，可能误导排查；最终状态应以 SQLite 为准，建议修复输出。
- SQLite experimental warning 在本轮所有相关命令中均未导致失败，符合项目预期，但 CI 日志中应继续明确标记为允许警告。
