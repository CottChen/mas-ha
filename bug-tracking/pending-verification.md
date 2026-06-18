# 待复测缺陷

本文件记录已有修复或处理结论、但尚未独立复测的问题。复测通过后移动到对应 `verified-*.md` 文件，复测失败则移回 [active-bugs.md](active-bugs.md) 并补充失败证据。

## BUG-20260605-001：`mas autonomy tick` stdout 返回 claim 快照，completed job 仍显示 `running`

- 严重级别：P2
- 状态：pending-verification
- 修复来源：本地修复
- 修复摘要：`runDueAutonomyJobs` 和兼容的 `runDueReflections` 在状态更新后重新读取最终快照，再写入 `completed`、`cancelled`、`blocked` 返回数组；`autonomy tick` stdout 不再返回 claim 时的 `running` 快照。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：构造 due reflection、consolidation、dream 和 goal_continuation job，执行 `mas autonomy tick --limit 20 --dream-limit 20`，对比 stdout 与 SQLite 最终状态。
- 通过标准：stdout 中 `due.completed[]` 的目标 job 状态为 `completed`，且与 `autonomy_jobs` 最终状态一致。
- 复测人：
- 复测日期：
- 复测结果：本地 `npm run e2e:smoke` 已覆盖目标断言，仍待独立复测。

## BUG-20260605-002：reflection job 完成后 Experience Graph 的 reflection 节点仍显示 `scheduled`

- 严重级别：P2
- 状态：pending-verification
- 修复来源：本地修复
- 修复摘要：新增 `MasStore.updateExperienceNode`，在 due reflection task/job 完成后同步更新对应 `experience_nodes` 中同 `nodeId` 的计划型 reflection 节点状态，并保留原 payload 后叠加执行决策。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：为目标 run 构造 scheduled reflection Experience Node 和 due reflection autonomy job，执行 `mas autonomy tick --run-id <runId>` 后查询 `reflection_tasks`、`autonomy_jobs` 和 `experience_nodes`。
- 通过标准：job、兼容 reflection task 和对应 Experience Graph reflection 节点均为 `completed`。
- 复测人：
- 复测日期：
- 复测结果：本地 `npm run e2e:smoke` 已覆盖目标断言，仍待独立复测。

## BUG-20260605-004：全局 autonomy tick 缺少按 runId/jobId 过滤，测试时会处理无关历史 due job

- 严重级别：P3
- 状态：pending-verification
- 修复来源：本地修复
- 修复摘要：`claimDueAutonomyJobs` 支持 `sourceRunId` 和 `jobId` 过滤；`AutonomyLoop.runDueAutonomyJobs`、`ReflectionScheduler` 和 CLI `mas autonomy tick` 暴露 `--run-id`、`--job-id` 过滤参数。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：构造多个 due job，其中至少一个属于目标 run、一个属于无关 run；执行 `mas autonomy tick --run-id <runId>`。
- 通过标准：只处理目标 run 的 due job，无关 run 的 due job 保持 `scheduled`；使用 `--job-id <jobId>` 时只 claim 指定 job。
- 复测人：
- 复测日期：
- 复测结果：本地 `npm run e2e:smoke` 已覆盖 CLI `--run-id` 过滤和核心 `jobId` 过滤，CLI `--job-id` 仍待独立复测。

## BUG-20260609-001：HA 终验 typed tool 被拒绝且解析错误误报为 Superego

- 严重级别：P1
- 状态：pending-verification
- 修复来源：AionUI 真实会话 `custom-temp-1780992492653`
- 修复摘要：`ha_final_review` 加入内部结构化工具集合，避免在 `deny-writes` 下被当作普通执行工具拒绝；`parseCritique` 支持调用方传入来源，HA 终验解析失败时不再误报为 `Superego 未输出可解析 JSON`。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：在 `ha-ego-superego` 模式运行一次会触发 HA 终验的任务，确认 HA 能成功提交 `ha_final_review` typed tool；构造 HA 终验非 JSON 输出，确认错误消息为 `HA 终验 未输出可解析 JSON`。
- 通过标准：HA 终验工具调用不被权限层拒绝；终验失败时错误归因准确；AionUI 不再显示 `HA 终验结构化输出解析失败且自修复失败：Superego 未输出可解析 JSON`。
- 复测人：
- 复测日期：
- 复测结果：本地 `npm run typecheck` 和 `npm.cmd run e2e:smoke` 已通过；仍待真实 AionUI 会话独立复测。

## BUG-20260611-001：Web 项目根目录源码被误判为 `output/` 外写入

- 严重级别：P1
- 状态：pending-verification
- 修复来源：AionUI 真实会话 `custom-temp-df89d1ed`
- 修复摘要：AuditPacket 改为从用户任务和 HA 验收合同推断允许输出边界；未显式要求 `output/` 时，workspace 根目录内的 greenfield 项目源码、文档和配置不再被标记为当前输出边界违规。Superego `escalate` 现在只作为内部升级信号，真正人工介入必须由 HA 终验决定。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：复用或构造 web 应用开发任务，允许输出为项目源码和文档但不要求 `output/`。
- 通过标准：AuditPacket `outputBoundary.mode` 为 `workspace_root`，`currentWritesOutsideOutput` 为空；根目录源码、文档和配置不会触发 `output_boundary` 或 `workspace_boundary_diff` 阻塞。
- 复测人：
- 复测日期：
- 复测结果：本地回归断言已加入 `npm run e2e:smoke`，仍待真实 AionUI 会话复测。

## BUG-20260611-002：Ego prompt 缺少稳定工程工作人格，容易在大任务中铺骨架后自报完成

- 严重级别：P1
- 状态：pending-verification
- 修复来源：AionUI 真实会话 `custom-temp-df89d1ed`
- 修复摘要：Ego 基础 prompt 从清单式约束改为 Codex 风格的稳定工作人格：先读上下文、识别关键路径、优先打通可运行可验证的垂直闭环、用证据证明真实能力、不得主动把任务拆给未来轮次或用内部资源压力缩小范围。`needs_attention` 仅用于用户/外部条件阻塞；普通未完成不是停止理由。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：复用大型 greenfield web 应用任务，观察 Ego 是否先实现核心数据模型、持久化、核心业务流程、一个真实 UI/API 路径和可执行验证，而不是只生成目录、文档和未接线页面后自报完成。
- 通过标准：Ego 输出不再用内部资源压力解释缩小范围；`completed` 必须附带能证明关键路径真实运行的验证证据；若核心能力缺失，Superego 能基于业务能力缺口返回 `revise` 而不是被 output 边界误报带偏。
- 复测人：
- 复测日期：
- 复测结果：本地 prompt 回归断言已加入 `npm run e2e:smoke`，仍待真实 AionUI 会话复测。

## BUG-20260611-003：Ego/Superego 求助信号被框架直接当成用户人工介入

- 严重级别：P1
- 状态：pending-verification
- 修复来源：AionUI 真实会话 `custom-temp-1f8092c0`
- 修复摘要：Ego 的 `needs_attention/blocked` 不再直接结束 run，而是记录为内部未完成信号并进入 Superego/HA 复核；Superego 的 `escalate` 不再直接输出“需要人工介入”，而是先交给 HA 终验裁决。只有 HA 终验可以把 run 结束为用户可见 `needs_attention`。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：构造 Ego 上报 `needs_attention`、Superego 上报 `escalate` 的会话，观察 run 是否继续进入返工或 HA 终验，而不是立即显示“需要人工介入”。
- 通过标准：非 HA 角色的求助/升级信号不会直接触发 `sink.done`；Superego 升级信号必须先进入 HA 终验；最终用户可见人工介入消息必须包含 HA 终验结论或最大轮次后 HA 判断。
- 复测人：
- 复测日期：
- 复测结果：本地编排语义断言已加入 `npm run e2e:smoke`，仍待真实 AionUI 会话复测。

## BUG-20260617-001：Ego 可执行全局杀 `node.exe` 导致 MAS/ACP run 悬挂，后续 HA 重复生成 execute 合同

- 严重级别：P1
- 状态：pending-verification
- 修复来源：AionUI 会话 `custom-temp-4e0694e6` 排查 + 本地修复
- 修复摘要：新增 `evaluateBashCommandPolicy`，在权限审批阶段和 bash 工具执行阶段双重拒绝 `taskkill /IM node.exe`、`Stop-Process -Name node`、`pkill/killall node` 等全局杀 Node 命令；HA 路由前新增状态追问短路诊断，发现同 session/cwd 有未收口 running run 时直接返回本地 audit/approval/agent_run 诊断，不再重复生成 execute 合同。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：在 approve-all 模式下让 Ego 尝试执行 `taskkill /F /IM node.exe`；再构造或保留一个同 session/cwd 的 running run，向 AionUI 询问“怎么卡住了 / ego 为什么卡住了”。
- 通过标准：全局杀 `node.exe` 命令被 `reject_policy` 或 bash 执行层拒绝；PID 定点清理仍可按权限策略执行；状态追问返回悬挂 run 的最后审计/审批事件，而不是创建新的执行合同。
- 复测人：
- 复测日期：
- 复测结果：本地 `npm run typecheck` 通过；针对性验证确认 `taskkill //F //IM node.exe` 被拒绝、`taskkill /PID 1234 /F` 允许，且 `buildStalledRunDiagnosis` 能识别 `custom-temp-4e0694e6` 同会话 running run。仍待真实 AionUI 会话复测。

## BUG-20260618-001：Superego 评审空输出导致 `superego_review` 结构化解析失败

- 严重级别：P1
- 状态：pending-verification
- 修复来源：AionUI 会话 `custom-temp-4e0694e6` 及 MAS SQLite 排查
- 修复摘要：Superego 评审前将完整 AuditPacket 持久化为 MAS run artifact，prompt 只注入 artifact 摘要、索引和关键风险；Superego/HA 可通过 `mas_read_run_artifact` 按需读取具体 section，避免把大 JSON 压缩塞进上下文。Superego 首次未提交 `superego_review` 且无可解析 JSON 时，repair 改为新建干净 Superego session 执行，避免沿用已经失败的大上下文。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：复用会触发 Superego 的 `ha-ego-superego` 任务，尤其是合同、Ego 输出和 AuditPacket 较大的任务；观察 Superego 是否能提交 `superego_review` 或至少在 fresh repair 中成功提交结构化结果。
- 通过标准：`events` 中 Superego 不再出现连续 `outputChars=0` 后 `review_repair_failed`；`agent_runs` 中 Superego 有 completed 记录；AionUI 不再显示 `Superego 评审结构化输出解析失败且自修复失败：Superego 未提交 superego_review 工具调用，也未输出可解析 JSON`。
- 复测人：
- 复测日期：
- 复测结果：本地 `npm run typecheck` 通过；数据库诊断确认原失败 run 的 Superego prompt 约 48385 字符且无 tool/text 输出。仍待真实 AionUI 会话复测。

## BUG-20260618-002：HA 将 Ego/Superego 健康测试误判为历史状态回答

- 严重级别：P1
- 状态：pending-verification
- 修复来源：AionUI 会话 `custom-temp-e8e5514e` 排查 + 本地修复
- 修复摘要：新增角色健康检查识别逻辑；用户明确要求“测试/验证/检查 Ego 和 Superego 是否正常”时，HA 路由直接生成最小 dry-run 执行合同，强制真实进入 Ego 和 Superego，不再用历史 recent activity 代替本次测试。同时 `mas_query_recent_activity` 支持排除当前 run，避免 HA 把“正在生成本回答”的当前 run `running` 状态写进最终答复。
- 待复测版本或提交：当前工作区未提交改动
- 复测步骤：在新的 AionUI 会话中发送 `测试一下ego和superego正常吗`。
- 通过标准：HA 不应直接回答旧 run 中 Superego 失败；本次 run 应进入 Ego 第 1 轮和 Superego 第 1 轮；最终答复基于本 run 的 `ego_result` 和 `superego_review` 或新的 Superego 失败证据。
- 复测人：
- 复测日期：
- 复测结果：本地 `npm run typecheck` 和 `npm run doctor` 通过；仍待重启 AionUI 自定义 ACP Agent 后真实会话复测。

## 记录模板

```md
## BUG-YYYYMMDD-NNN：标题

- 严重级别：
- 状态：pending-verification
- 修复来源：
- 修复摘要：
- 待复测版本或提交：
- 复测步骤：
- 通过标准：
- 复测人：
- 复测日期：
- 复测结果：
```
