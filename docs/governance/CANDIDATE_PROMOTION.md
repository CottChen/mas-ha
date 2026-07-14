# 候选经验晋升路径

本文记录 eval、policy、skill、doc 和 validator candidate 的人工确认路径。后台自主任务只能创建 candidate；晋升必须由用户命令、PR 或明确策略触发。

## 状态

- `candidate`：系统从失败、审计发现、用户纠正或重复风险中生成候选。
- `promoted`：用户确认该候选应进入后续门禁或沉淀流程。
- `rejected`：用户确认该候选不适合沉淀。
- `retired`：候选曾有价值，但已被替代或过期。

## CLI 控制面

```bash
mas candidate list --status candidate
mas candidate promote <candidate-id>
mas candidate reject <candidate-id>
mas candidate retire <candidate-id>
```

这些命令只更新 MAS SQLite 事实和审计记录，不直接写用户工作区、项目规则、测试文件或技能目录。

## 晋升目标

| 目标 | 适用条件 | 后续动作 |
| --- | --- | --- |
| eval | 有明确输入 fixture 和 expected assertions | 新增或更新测试，运行验证后提交 |
| validator | 有稳定命令可验证 | 接入 HA 验收合同或 Superego 门禁 |
| policy | 失败属于长期安全/边界规则 | 先写入专门 docs，再评估是否进入 [AGENTS.md](../../AGENTS.md) |
| skill | 失败需要可复用操作流程 | 用 skill-creator 建立或更新技能 |
| doc | 经验主要是项目知识 | 按 [文档导航](../README.md) 写入对应专题文档 |

## 后续门禁

已 `promoted` 的 candidate 会进入 Experience Graph 检索结果，作为 HA/Ego/Superego 的低优先级历史经验候选。它不是事实来源；每次任务仍必须用当前验证、AuditPacket 和用户反馈确认。

## 回滚

误晋升的 candidate 使用：

```bash
mas candidate retire <candidate-id>
```

如果 candidate 已被人工写入测试、文档或技能，回滚应通过普通 Git 变更完成，并在 PR 描述中说明原因。
