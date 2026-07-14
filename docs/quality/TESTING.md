# MAS 测试与验证

本文维护当前验证入口、适用范围和证据要求。具体理念偏差及其真实任务集见 [理念对齐 TODO](DESIGN_ALIGNMENT_TODO.md)；缺陷复测状态见 [bug-tracking](../../bug-tracking/README.md)。

## 自动化门禁

| 命令 | 验证范围 | 适用变更 |
| --- | --- | --- |
| `npm run typecheck` | TypeScript 类型和公共接口 | 所有代码变更 |
| `npm run doctor` | Pi SDK、SQLite 和基础配置加载 | 依赖、模型、CLI、存储变更 |
| `npm run smoke:audit` | AuditPacket、边界和确定性门禁 | 审计、权限、合同、文件边界变更 |
| `npm run e2e:smoke` | CLI、ACP、Goal、自主任务和工具白名单接线 | 编排、ACP、自主性、Prompt 工具边界变更 |

合并前至少运行 `typecheck` 和 `doctor`。涉及审计时增加 `smoke:audit`；涉及编排、自主性、角色工具或 ACP 时增加 `e2e:smoke` 和相应 handshake 检查。

`e2e:smoke` 不应调用真实付费模型完成业务任务，但当前 ACP 模型 metadata 断言要求本机 Pi 模型注册表至少能发现一个可用模型。模型配置为空导致的失败必须和代码回归分开报告。

## 自动化测试边界

- Prompt 字符串包含断言只能验证规则被注入，不能证明 Agent 会遵守或任务效果提高。
- 分数大于零、job 进入 completed、节点被标记 pruned 只能验证机制接线，不能证明信息增益、Dream 重组或组织学习有效。
- 测试应优先锁定用户可见行为、架构不变量和确定性门禁，不锁死无关 Prompt 字面或临时权重。
- 测试数据使用隔离 `MAS_HOME` 和临时工作区，不读取用户长期运行数据、密钥或本机业务项目。

## 真实任务测试

以下变化不能只靠 smoke test 合并：

- HA、Ego、Superego 的人格、职责、收口和升级条件。
- 外部检索、Evidence Packet、异质模型或异质工具策略。
- uncertainty、evidence quality、information gain 或 Goal 完成判断。
- revise 调节器、上下文扰动、Reflection、Dream 和候选晋升。
- 高风险抽样、最终验收和用户可见产品体验。

真实任务必须按 [理念对齐 TODO](DESIGN_ALIGNMENT_TODO.md) 的最小任务集进行旧版/新版对照。修改只影响单一角色时可以裁剪无关场景，但必须覆盖该角色的成功、失败和边界条件。

## 证据记录

每次对照至少记录：

```text
task_id:
baseline_commit / candidate_commit:
prompt_version:
model / thinking_level:
toolset / approval_mode:
input_fixture / seed:
run_ids:
validator_results:
external_sources:
final_decision:
rework_rounds / escalations:
latency / token_or_call_cost:
human_or_user_judgment:
```

原始运行事实保存在 MAS SQLite、run artifact 或受版本控制的测试 fixture 中。汇总报告必须能追溯到原始 run 和 validator，不能只保存模型总结。

## 通过标准

- 新版必须守住全部确定性安全门禁。
- 目标指标改善不能以更高越权、更多无效升级或隐瞒失败为代价。
- 单次偶然成功不能证明 Prompt、扰动或异质性有效。
- 失败结果必须如实保留；不得删除不利样本后再计算完成率。
- 无法运行某项验证时，明确记录环境缺口和剩余风险，不把未运行写成通过。
