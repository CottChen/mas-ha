import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "mas-e2e-smoke-"));
const masHome = join(tempRoot, "mas-home");
const workspace = join(tempRoot, "workspace");
mkdirSync(workspace, { recursive: true });

function smokeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MAS_HOME: masHome,
    MAS_HA_MODEL: "",
    MAS_EGO_MODEL: "",
    MAS_SUPEREGO_MODEL: "",
    MAS_HA_THINKING_LEVEL: "",
    MAS_EGO_THINKING_LEVEL: "",
    MAS_SUPEREGO_THINKING_LEVEL: "",
  };
}

function cliSmoke(): void {
  const doctor = runCli(["doctor"]);
  assert(doctor.stdout.includes("OK  Pi SDK 导入: ok"), "doctor 应能导入 Pi SDK");

  const status = runCli(["status", "--limit", "1"]);
  assert(Array.isArray(JSON.parse(status.stdout)), "status 应输出 JSON 数组");

  const noGoal = runCli(["goal", "status", "--cwd", workspace], 1);
  assert(noGoal.stdout.includes("当前工作区没有"), "空工作区应没有活跃 Goal");

  const goal = runCli(["goal", "set", "完成 MAS E2E smoke 验证", "--cwd", workspace, "--max-turns", "3", "--orchestration-mode", "ha-ego"]);
  const goalId = extract(goal.stdout, /id:\s*([^\s]+)/, "应输出 goal id");
  assert(goal.stdout.includes("orchestration: ha-ego"), "Goal 应记录编排模式");

  const duplicate = runCli(["goal", "set", "不应覆盖现有 Goal", "--cwd", workspace], 1);
  assert(duplicate.stdout.includes("不能静默覆盖"), "重复 Goal 应被拒绝");

  const subgoal = runCli(["subgoal", "add", "验证 ACP session/new 返回模型和配置", "--cwd", workspace]);
  assert(subgoal.stdout.includes("已追加 Subgoal"), "应能追加 Subgoal");

  const subgoalList = runCli(["subgoal", "list", "--cwd", workspace]);
  assert(subgoalList.stdout.includes("[active] 验证 ACP"), "应能列出 Subgoal");

  const confirmed = runCli(["subgoal", "confirm", "1", "--cwd", workspace]);
  assert(confirmed.stdout.includes("已确认 Subgoal"), "应能按序号确认 Subgoal");

  const paused = runCli(["goal", "pause", "--goal-id", goalId, "--cwd", workspace]);
  assert(paused.stdout.includes("status: paused"), "Goal 应能暂停");

  const resumed = runCli(["goal", "resume", "--goal-id", goalId, "--cwd", workspace]);
  assert(resumed.stdout.includes("status: active"), "Goal 应能恢复");

  const removed = runCli(["subgoal", "remove", "1", "--cwd", workspace]);
  assert(removed.stdout.includes("已移除 Subgoal"), "应能移除 Subgoal");

  const cleared = runCli(["goal", "clear", "--goal-id", goalId, "--cwd", workspace]);
  assert(cleared.stdout.includes("status: cleared"), "Goal 应能清除");

  const autonomyStatus = runCli(["autonomy", "status", "--limit", "2"]);
  const autonomyStatusJson = JSON.parse(autonomyStatus.stdout);
  assert(Array.isArray(autonomyStatusJson.scheduled), "autonomy status 应输出 scheduled 列表");

  const autonomyTick = runCli(["autonomy", "tick", "--limit", "2", "--dream-limit", "2"]);
  const autonomyTickJson = JSON.parse(autonomyTick.stdout);
  assert(typeof autonomyTickJson.leaseAcquired === "boolean", "autonomy tick 应输出租约结果");
}

async function acpSmoke(): Promise<void> {
  let sessionId = "";
  const client = startAcp(["--experimental-acp", "--approve-all", "--approval-mode-policy", "mutable", "--orchestration-mode", "ha-ego-superego"]);
  try {
    const initialized = await client.request("initialize", {});
    assert(initialized.serverInfo?.name === "mas", "initialize 应返回 mas serverInfo");
    assert(initialized.capabilities?.sessionCapabilities?.prompt === true, "initialize 应声明 prompt 能力");

    const session = await client.request("session/new", { cwd: workspace, orchestrationMode: "ha-ego" });
    sessionId = String(session.sessionId);
    assert(session.currentModeId === "bypassPermissions", "approve-all 初始模式应映射为 bypassPermissions");
    assert(session.modes?.currentModeId === "bypassPermissions", "session/new 应返回标准 ACP modes 状态");
    assert(session.configOptions?.[0]?.currentValue === "ha-ego", "session/new 应采用请求的编排模式");
    assert(typeof session.models?.currentModelId === "string" && session.models.currentModelId.length > 0, "session/new 应返回 Pi 当前模型");
    assert(Array.isArray(session.models?.availableModels), "session/new 应返回 Pi 可用模型列表");
    assert(
      session.models.availableModels.some((model: { id?: string }) => model.id === session.models.currentModelId),
      "Pi 当前模型应包含在可用模型列表中",
    );
    assert(
      session.metadata?.modelConfig?.roleModels?.superego?.source === "pi_default" &&
        session.metadata.modelConfig.roleModels.superego.requestedModelId === undefined,
      "Superego 未配置时应直接使用 Pi 默认模型",
    );
    const selectedModel = await client.request("session/set_model", { sessionId, modelId: session.models.currentModelId });
    assert(selectedModel.models?.currentModelId === session.models.currentModelId, "session/set_model 应保存用户选择的模型");
    assert(
      selectedModel.metadata?.modelConfig?.roleModels?.ha?.requestedModelId === session.models.currentModelId &&
        selectedModel.metadata.modelConfig.roleModels.ha.source === "session_selection",
      "AionUI 模型选择应只作为 HA 用户代理验收模型",
    );
    assert(
      selectedModel.metadata?.modelConfig?.roleModels?.ego?.requestedModelId === undefined &&
        selectedModel.metadata?.modelConfig?.roleModels?.superego?.requestedModelId === undefined,
      "AionUI 模型选择不应覆盖 Ego 或 Superego 模型",
    );

    await client.waitForNotification((msg) => hasSessionUpdate(msg, sessionId, "available_commands_update"), "available_commands_update");
    await client.waitForNotification((msg) => JSON.stringify(msg).includes("MAS 角色模型配置"), "角色模型配置展示");
    assert(
      client.notifications.some(
        (msg) =>
          JSON.stringify(msg).includes("MAS 角色模型配置") &&
          JSON.stringify(msg).includes("HA") &&
          JSON.stringify(msg).includes("Ego") &&
          JSON.stringify(msg).includes("Superego"),
      ),
      "session/new 应在会话开始展示 HA/Ego/Superego 模型配置",
    );
    assert(
      client.notifications.some((msg) => JSON.stringify(msg).includes("\"compact\"") && JSON.stringify(msg).includes("\"goal\"")),
      "session/new 应公告 /compact 和 /goal 命令",
    );

    const mode = await client.request("session/set_mode", { sessionId, modeId: "default" });
    assert(mode.currentModeId === "default", "mutable 策略下 set_mode default 应生效");

    const config = await client.request("session/set_config_option", { sessionId, configId: "orchestrationMode", value: "ha-ego-superego" });
    assert(config.configOptions?.[0]?.currentValue === "ha-ego-superego", "set_config_option 应切换编排模式");

    const goalPrompt = await client.request("session/prompt", { sessionId, prompt: "/goal set ACP smoke 目标" });
    assert(goalPrompt.stopReason === "end_turn", "/goal 命令应直接结束回合");
    await client.waitForNotification((msg) => JSON.stringify(msg).includes("已创建 Goal"), "goal 创建消息");

    const subgoalPrompt = await client.request("session/prompt", { sessionId, prompt: "/subgoal add ACP smoke 子目标" });
    assert(subgoalPrompt.stopReason === "end_turn", "/subgoal 命令应直接结束回合");
    await client.waitForNotification((msg) => JSON.stringify(msg).includes("已追加 Subgoal"), "subgoal 创建消息");

    const compact = await client.request("session/prompt", { sessionId, prompt: "/compact" });
    assert(compact.stopReason === "end_turn", "/compact 命令应直接结束回合");
    await client.waitForNotification((msg) => JSON.stringify(msg).includes("已压缩当前 MAS 会话上下文"), "compact 消息");

    const loaded = await client.request("session/load", { sessionId, cwd: workspace });
    assert(loaded.sessionId === sessionId, "session/load 应恢复指定 sessionId");
  } finally {
    await client.close();
  }

  const rehydratedClient = startAcp(["--experimental-acp", "--approve-all", "--approval-mode-policy", "mutable", "--orchestration-mode", "ha-ego-superego"]);
  try {
    await rehydratedClient.request("initialize", {});
    const compact = await rehydratedClient.request("session/prompt", { sessionId, prompt: "/compact" });
    assert(compact.stopReason === "end_turn", "新 ACP 进程应能用旧 sessionId 自愈恢复并处理 prompt");
    await rehydratedClient.waitForNotification((msg) => JSON.stringify(msg).includes("已压缩当前 MAS 会话上下文"), "rehydrated compact 消息");
  } finally {
    await rehydratedClient.close();
  }
}

function runCli(args: string[], expectedStatus = 0): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, "src/cli.ts"), ...args], {
    cwd: repoRoot,
    env: smokeEnv(),
    encoding: "utf8",
  });
  if (result.status !== expectedStatus) {
    throw new Error(
      `CLI 退出码不符合预期：${args.join(" ")}\nexpected=${expectedStatus} actual=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function startAcp(args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "src/cli.ts"), ...args], {
    cwd: repoRoot,
    env: smokeEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new JsonRpcTestClient(child);
}

class JsonRpcTestClient {
  readonly notifications: unknown[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly stderr: string[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => this.stderr.push(String(chunk)));
    child.on("exit", (code) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`ACP 进程已退出：${code}\n${this.stderr.join("")}`));
      this.pending.clear();
    });
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`等待 ACP 响应超时：${method}\n${this.stderr.join("")}`));
      }, 5000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async waitForNotification(predicate: (message: unknown) => boolean, label: string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 3000) {
      if (this.notifications.some(predicate)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`未收到通知：${label}\nnotifications=${JSON.stringify(this.notifications, null, 2)}\nstderr=${this.stderr.join("")}`);
  }

  async close(): Promise<void> {
    const exited = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) {
        resolve();
        return;
      }
      this.child.once("exit", () => resolve());
    });
    this.child.stdin.end();
    this.child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }

  private handleLine(line: string): void {
    const message = JSON.parse(line);
    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    this.notifications.push(message);
  }
}

function hasSessionUpdate(message: unknown, sessionId: string, updateType: string): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as any;
  return record.method === "session/update" && record.params?.sessionId === sessionId && record.params?.update?.sessionUpdate === updateType;
}

function extract(text: string, pattern: RegExp, message: string): string {
  const match = text.match(pattern);
  assert(Boolean(match?.[1]), message);
  return match![1];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function autonomyStorageSmoke(): Promise<void> {
  process.env.MAS_HOME = masHome;
  const { MasStore } = await import("../src/storage.js");
  const { recordRunEntropy } = await import("../src/core/entropy.js");
  const { buildAuditPacket, createBoundarySnapshot } = await import("../src/core/audit.js");
  const { AutonomyLoop } = await import("../src/core/autonomy.js");
  const { ContextPerturbationController } = await import("../src/core/context-perturbation.js");
  const { buildRecentActivitySummary, buildRunManagementContext } = await import("../src/core/activity.js");
  const { buildEgoPrompt, buildHaDecisionPrompt, buildHaFinalReviewPrompt, buildSuperegoPrompt } = await import("../src/core/prompts.js");
  const { enforceHaFinalReviewGate, formatNeedsAttentionResult, routeEgoAttentionToCritique, routeSuperegoReviewForOrchestration } = await import("../src/core/runner.js");
  const { parseCritique } = await import("../src/core/prompts.js");
  const { isAutoApprovedReviewTool, isInternalTool, isReadOnlyTool, roleToolNames, routeLiteralThinkTextDeltasForTest } = await import("../src/pi/pi-sdk.js");
  const store = new MasStore();
  const perturbations = new ContextPerturbationController(store);
  const autonomyWorkspace = join(tempRoot, "autonomy-workspace");
  mkdirSync(autonomyWorkspace, { recursive: true });
  try {
    const defaultPerturbation = perturbations.createCandidate({
      runId: "e2e-perturb-ha",
      targetRole: "ha",
      trigger: "intent_check",
      sourceRefs: ["e2e:user_task"],
    });
    const egoPerturbation = perturbations.createCandidate({
      runId: "e2e-perturb-ego",
      targetRole: "ego",
      trigger: "stalled_execution_plan",
      sourceRefs: ["e2e:contract"],
    });
    const superegoPerturbation = perturbations.createCandidate({
      runId: "e2e-perturb-superego",
      targetRole: "superego",
      trigger: "review_sampling",
      critique: {
        blocking_issues: 1,
        quality_score: 0.4,
        summary: "存在阻塞性证据缺口",
        next_action: "revise",
        critique_items: [],
      },
      sourceRefs: ["e2e:audit_packet"],
    });
    assert(defaultPerturbation === undefined, "普通路由不应无证据地默认增加上下文扰动");
    assert(egoPerturbation?.payload && typeof egoPerturbation.payload === "object", "显式执行停滞应生成低风险上下文扰动");
    assert(superegoPerturbation?.payload && typeof superegoPerturbation.payload === "object", "阻塞性返工应生成低风险上下文扰动");
    assert(typeof (egoPerturbation.payload as { seed?: unknown }).seed === "string", "扰动 payload 应记录可复现 seed");
    assert(perturbations.render(egoPerturbation).includes("<context_perturbation"), "扰动应渲染为隔离 context_perturbation 数据块");

    store.createRun({ runId: "e2e-recent-activity-run", sessionId: "e2e-session", cwd: autonomyWorkspace, prompt: "E2E Ego recent activity" });
    store.addAgentRun({
      runId: "e2e-recent-activity-run",
      role: "ego",
      iteration: 1,
      status: "completed",
      input: { e2e: true },
      output: { result: { summary: "Ego 最近完成了 E2E 近期活动摘要验证" } },
    });
    store.updateRun("e2e-recent-activity-run", "completed", { result: "ok" });
    const recentActivity = buildRecentActivitySummary(store, { sessionId: "e2e-session", limit: 5 });
    assert(recentActivity.rendered.includes("Ego 最近完成了 E2E"), "近期活动摘要应包含 Ego 最近执行事实");
    assert(recentActivity.recentRoles.includes("ego"), "近期活动摘要应记录最近出现过 Ego");
    store.createRun({ runId: "e2e-open-run", sessionId: "e2e-session", cwd: autonomyWorkspace, prompt: "E2E historical running run" });
    const runManagementContext = buildRunManagementContext(store, { currentRunId: "e2e-current-run", sessionId: "e2e-session", cwd: autonomyWorkspace });
    assert(runManagementContext.hasOpenRuns, "run 管理上下文应识别同会话未收口 running run");
    assert(runManagementContext.rendered.includes("不是路由结论"), "run 管理上下文必须声明自己不是路由结论");
    assert(
      buildHaDecisionPrompt("继续完成刚才任务，不要停", "", autonomyWorkspace, runManagementContext.rendered).includes("<run_management_context>"),
      "HA prompt 应支持注入 run 管理上下文，而不是框架正则抢跑",
    );
    store.createRun({ runId: "e2e-current-run", sessionId: "e2e-session", cwd: autonomyWorkspace, prompt: "E2E current run" });
    const previousEgoRuns = store.listSessionAgentRuns({ sessionId: "e2e-session", role: "ego", beforeRunId: "e2e-current-run", limit: 3 });
    assert(previousEgoRuns.some((run) => run.runId === "e2e-recent-activity-run"), "应能按 AionUI session 查询 Ego 之前的执行上下文");
    assert(
      buildEgoPrompt("E2E", "验收合同", undefined, "", "Ego 历史摘要").includes("同一 AionUI 会话中 Ego 之前的执行上下文"),
      "Ego prompt 应支持注入同会话 Ego 历史上下文",
    );
    assert(buildHaDecisionPrompt("E2E").includes("不是交付执行者"), "HA 路由 prompt 应明确 HA 不是交付执行者");
    assert(buildHaDecisionPrompt("E2E").includes("不是替 Ego 写文件"), "HA 路由 prompt 应禁止替 Ego 提前完成交付");
    assert(!buildHaDecisionPrompt("E2E").includes("不要停在建议、计划或半成品"), "HA 路由 prompt 不应继承执行者式持续交付倾向");
    assert(buildHaDecisionPrompt("E2E 最近在做什么").includes("mas_query_recent_activity"), "HA prompt 应要求状态问题使用近期活动查询工具");
    assert(buildHaDecisionPrompt("查询第三方库当前版本").includes("mas_external_search"), "HA prompt 应说明外部检索工具");
    assert(buildHaDecisionPrompt("读取外部 URL 原文").includes("mas_external_read"), "HA prompt 应说明外部读取工具");
    assert(buildHaDecisionPrompt("严格按照 user-prompt.md 完成").includes("本地只读 intake"), "HA prompt 应说明路由阶段本地只读 intake");
    assert(buildHaDecisionPrompt("严格按照 user-prompt.md 完成").includes("keyCriteria"), "HA prompt 应要求抽取关键口径清单");
    assert(
      buildHaFinalReviewPrompt("E2E", "验收合同", "{}", undefined).includes("ha_final_review"),
      "HA 终验 prompt 应要求调用 ha_final_review 工具",
    );
    assert(
      buildHaFinalReviewPrompt("E2E", "验收合同", "{}", undefined).includes("mas_external_search"),
      "HA 终验 prompt 应允许使用外部检索工具做交叉验证",
    );
    assert(
      buildHaFinalReviewPrompt("E2E", "验收合同", "{}", undefined).includes("mas_external_read"),
      "HA 终验 prompt 应允许使用外部读取工具核对来源原文",
    );
    assert(
      buildHaFinalReviewPrompt("E2E", "验收合同包含 keyCriteria", "{}", undefined).includes("keyCriteria"),
      "HA 终验 prompt 应要求按关键口径验收",
    );
    assert(
      buildHaFinalReviewPrompt("E2E", "验收合同", '{"status":"needs_attention"}', undefined).includes("只有 HA 可以代表用户决定真正需要人工介入"),
      "HA 终验 prompt 应明确只有 HA 能决定用户人工介入",
    );
    assert(buildEgoPrompt("E2E", "验收合同").includes("现实执行面"), "Ego prompt 应体现心理模型中的现实执行面");
    assert(buildEgoPrompt("E2E", "验收合同").includes("实现假设清单"), "Ego prompt 应要求实现假设清单");
    assert(buildEgoPrompt("E2E", "验收合同").includes("让当前系统的形状决定实现方式"), "Ego prompt 应体现先读上下文和按现有系统推进");
    assert(buildEgoPrompt("E2E", "验收合同").includes("不要把任务主动拆给未来轮次"), "Ego prompt 应要求本轮尽力完整交付，而不是自我安排未来轮次");
    assert(buildEgoPrompt("E2E", "验收合同").includes("关键路径"), "Ego prompt 应要求先识别关键路径");
    assert(buildEgoPrompt("E2E", "验收合同").includes("垂直闭环"), "Ego prompt 应要求优先打通可验证垂直闭环");
    assert(buildEgoPrompt("E2E", "验收合同").includes("不能替代闭环"), "Ego prompt 应防止目录/文档/示例替代真实能力");
    assert(buildEgoPrompt("E2E", "验收合同").includes("mas_query_memory"), "Ego prompt 应暴露历史经验候选查询工具");
    assert(!buildEgoPrompt("E2E", "验收合同").includes("mas_query_recent_activity"), "Ego prompt 不应暴露近期活动查询工具");
    assert(buildEgoPrompt("E2E", "验收合同").includes("不拥有 MAS 近期活动"), "Ego prompt 应明确近期活动工具边界");
    assert(buildEgoPrompt("E2E", "验收合同").includes("普通“还有文件没写完"), "Ego prompt 应禁止把普通未完成当作 needs_attention");
    assert(buildEgoPrompt("E2E", "验收合同").includes("内部资源压力不是用户可见理由"), "Ego prompt 应禁止用内部资源压力缩小交付范围");
    assert(!buildEgoPrompt("E2E", "验收合同").includes("工具预算或迭代预算耗尽"), "Ego prompt 不应诱导模型猜测工具/迭代预算");
    assert(roleToolNames("ego").includes("mas_query_memory"), "Ego 工具白名单应包含历史经验候选查询工具");
    assert(!roleToolNames("ego").includes("mas_query_recent_activity"), "Ego 工具白名单不应包含近期活动查询工具");
    assert(!roleToolNames("ego").includes("mas_external_read"), "Ego 工具白名单不应包含外部读取工具");
    assert(roleToolNames("ha").includes("mas_query_recent_activity"), "HA 工具白名单应包含近期活动查询工具");
    assert(roleToolNames("ha").includes("mas_external_read"), "HA 工具白名单应包含外部读取工具");
    assert(roleToolNames("ha").includes("read"), "HA 路由阶段应包含本地只读文件工具");
    assert(roleToolNames("ha").includes("bash"), "HA 路由阶段应包含自动授权 bash 用于只读 intake");
    assert(roleToolNames("ha", "final_review").includes("read"), "HA 终验阶段应包含只读文件工具");
    assert(roleToolNames("ha", "final_review").includes("bash"), "HA 终验阶段应包含自动授权 bash 用于只读复算");
    assert(roleToolNames("superego").includes("mas_query_recent_activity"), "Superego 工具白名单应包含近期活动查询工具");
    assert(roleToolNames("superego").includes("bash"), "Superego 工具白名单应包含自动授权 bash 用于只读复算");
    assert(!roleToolNames("superego").includes("mas_external_read"), "Superego 工具白名单不应包含外部读取工具");
    assert(isAutoApprovedReviewTool({ role: "ha", phase: "route" }, "bash"), "HA 路由 bash 应自动授权");
    assert(isAutoApprovedReviewTool({ role: "ha", phase: "final_review" }, "bash"), "HA 终验 bash 应自动授权");
    assert(isAutoApprovedReviewTool({ role: "superego", phase: "review" }, "bash"), "Superego 评审 bash 应自动授权");
    assert(!isAutoApprovedReviewTool({ role: "ego", phase: "execute" }, "bash"), "Ego bash 不应自动授权");
    const routedThink = routeLiteralThinkTextDeltasForTest(["外部文本 <thi", "nk>内部思考</th", "ink> 后续文本"]);
    assert(routedThink.text === "外部文本  后续文本", "文本通道中的显式 <think> 块不应泄漏到普通对话");
    assert(routedThink.thought === "内部思考", "文本通道中的显式 <think> 块应归入思考流");
    assert(isInternalTool("ha_final_review"), "HA 终验 typed tool 应作为内部结构化工具捕获，不能被 deny-writes 拒绝");
    let haParseError = "";
    try {
      parseCritique("not json", "HA 终验");
    } catch (error) {
      haParseError = error instanceof Error ? error.message : String(error);
    }
    assert(haParseError.includes("HA 终验 未输出可解析 JSON"), "HA 终验解析错误不应误报为 Superego");
    assert(
      buildSuperegoPrompt("E2E", "验收合同包含 keyCriteria", "{}", {} as any).includes("约束和反思面"),
      "Superego prompt 应体现心理模型中的约束和反思面",
    );
    assert(
      buildSuperegoPrompt("E2E", "验收合同包含 keyCriteria", "{}", {} as any).includes("关键业务口径高于输出结构"),
      "Superego prompt 应内化证据层级",
    );
    assert(
      buildSuperegoPrompt("E2E", "验收合同包含 keyCriteria", "{}", {} as any).includes("文件像结果"),
      "Superego prompt 应包含评审前证伪问题",
    );
    assert(
      buildSuperegoPrompt("E2E", "验收合同包含 keyCriteria", "{}", {} as any).includes("扰动不是随机提醒"),
      "Superego prompt 应把扰动定义为反事实问题",
    );
    assert(
      buildSuperegoPrompt("E2E", "验收合同", "{}", {} as any).includes("escalate 对 Superego 只表示提交给 HA 判断的升级信号"),
      "Superego prompt 应说明 escalate 不是直接用户人工介入",
    );
    assert(
      buildSuperegoPrompt("E2E", "验收合同", "{}", {} as any).includes("mas_query_recent_activity"),
      "Superego prompt 应说明近期活动查询工具",
    );
    assert(
      !buildSuperegoPrompt("E2E", "验收合同", "{}", {} as any).includes("mas_external_search"),
      "Superego prompt 不应暴露 HA 专属外部检索工具",
    );
    assert(
      !buildSuperegoPrompt("E2E", "验收合同", "{}", {} as any).includes("mas_external_read"),
      "Superego prompt 不应暴露 HA 专属外部读取工具",
    );
    assert(
      buildSuperegoPrompt("E2E", "验收合同", "{}", {} as any).includes("不要默认要求所有任务写入 output/"),
      "Superego prompt 应避免把 output/ 当作所有任务的默认边界",
    );
    writeFileSync(join(autonomyWorkspace, "package.json"), "{}");
    store.addApproval({
      runId: "e2e-workspace-boundary",
      toolCallId: "write-workspace-root",
      toolName: "write",
      decision: "allow_always",
      rawInput: { path: join(autonomyWorkspace, "package.json") },
    });
    const workspaceBoundaryAudit = buildAuditPacket(store, {
      runId: "e2e-workspace-boundary",
      cwd: autonomyWorkspace,
      egoResult: {
        status: "completed",
        summary: "Web 应用项目源码",
        final_response: "完成",
        evidence: [],
        changed_files: [join(autonomyWorkspace, "package.json")],
        verification: [],
        risks: [],
      },
      task: "开发一个 web 应用",
      contract: "allowedOutputs: 项目源代码 frontend/backend、README.md、package.json",
    });
    assert(workspaceBoundaryAudit.outputBoundary.mode === "workspace_root", "未显式要求 output/ 时应允许 workspace 根目录产物");
    assert(workspaceBoundaryAudit.currentWritesOutsideOutput.length === 0, "workspace_root 模式不应把根目录源码当作 output 外违规");
    assert(!workspaceBoundaryAudit.findings.some((finding) => finding.category === "output_boundary"), "workspace_root 模式不应产生 output_boundary 阻塞");
    const workspaceDiffDir = join(autonomyWorkspace, "workspace-root-diff");
    mkdirSync(workspaceDiffDir, { recursive: true });
    const workspaceRootBaseline = createBoundarySnapshot({
      cwd: workspaceDiffDir,
      task: "开发一个 web 应用",
      contract: "allowedOutputs: 项目源代码 frontend/backend、README.md、package.json",
    });
    writeFileSync(join(workspaceDiffDir, "README.md"), "# app\n");
    store.addApproval({
      runId: "e2e-workspace-boundary-diff",
      toolCallId: "write-workspace-root-diff",
      toolName: "write",
      decision: "allow_always",
      rawInput: { path: join(workspaceDiffDir, "README.md") },
    });
    const workspaceBoundaryDiffAudit = buildAuditPacket(store, {
      runId: "e2e-workspace-boundary-diff",
      cwd: workspaceDiffDir,
      egoResult: {
        status: "completed",
        summary: "Web 应用项目源码",
        final_response: "完成",
        evidence: [],
        changed_files: [join(workspaceDiffDir, "README.md")],
        verification: [],
        risks: [],
      },
      boundarySnapshot: workspaceRootBaseline,
      task: "开发一个 web 应用",
      contract: "allowedOutputs: 项目源代码 frontend/backend、README.md、package.json",
    });
    assert(!workspaceBoundaryDiffAudit.findings.some((finding) => finding.category === "workspace_boundary_diff"), "workspace_root 模式下根目录新增源码不应触发 boundary diff 阻塞");
    store.addApproval({
      runId: "e2e-output-only-boundary",
      toolCallId: "write-output-only-root",
      toolName: "write",
      decision: "allow_always",
      rawInput: { path: join(autonomyWorkspace, "package.json") },
    });
    const outputOnlyAudit = buildAuditPacket(store, {
      runId: "e2e-output-only-boundary",
      cwd: autonomyWorkspace,
      egoResult: {
        status: "completed",
        summary: "输出目录任务",
        final_response: "完成",
        evidence: [],
        changed_files: [join(autonomyWorkspace, "package.json")],
        verification: [],
        risks: [],
      },
      task: "生成报告",
      contract: "所有结果必须写入 output/ 目录",
    });
    assert(outputOnlyAudit.outputBoundary.mode === "output_dir", "显式要求 output/ 时应启用 output_dir 边界");
    assert(outputOnlyAudit.currentWritesOutsideOutput.length === 1, "output_dir 模式应识别 output/ 外当前写入");
    assert(outputOnlyAudit.findings.some((finding) => finding.category === "output_boundary"), "output_dir 模式应产生 output_boundary finding");
    assert(isReadOnlyTool("mas_query_memory"), "历史经验查询工具应被权限层识别为只读");
    assert(isReadOnlyTool("mas_query_recent_activity"), "近期活动查询工具应被权限层识别为只读");
    assert(isReadOnlyTool("mas_external_search"), "外部检索工具应被权限层识别为只读");
    assert(isReadOnlyTool("mas_external_read"), "外部读取工具应被权限层识别为只读");
    assert(
      enforceHaFinalReviewGate({
        blocking_issues: 0,
        quality_score: 0,
        summary: "",
        next_action: "accept",
        evidenceQuality: 0,
        critique_items: [],
      }).next_action === "escalate",
      "HA 终验空壳 accept 应被门禁升级",
    );
    assert(
      enforceHaFinalReviewGate(
        {
          blocking_issues: 0,
          quality_score: 0.9,
          summary: "通过",
          next_action: "accept",
          evidenceQuality: 0.8,
          critique_items: [],
        },
        {
          egoResult: {
            status: "needs_attention",
            summary: "未完成",
            final_response: "需要继续",
            evidence: [],
            changed_files: [],
            verification: [],
            risks: [],
          },
        },
      ).next_action === "revise",
      "HA 终验不能 accept Ego 未完成状态",
    );
    assert(
      routeEgoAttentionToCritique(
        {
          status: "needs_attention",
          summary: "普通未完成",
          final_response: "需要继续",
          evidence: [],
          changed_files: [],
          verification: [],
          risks: ["还缺少前端实现"],
        },
        1,
      ).next_action === "revise",
      "Ego needs_attention 应转为内部 revise 信号",
    );
    assert(
      routeSuperegoReviewForOrchestration({
        blocking_issues: 1,
        quality_score: 0.1,
        summary: "需要人工介入",
        next_action: "escalate",
        critique_items: [],
      }).next_action === "escalate",
      "Superego escalate 应保留为交给 HA 终验裁决的内部升级信号",
    );
    const haFinalReviewMessage = formatNeedsAttentionResult({
      headline: "HA 终验未通过：需要人工介入。",
      haFinalReview: {
        blocking_issues: 1,
        quality_score: 0.2,
        summary: "accept",
        next_action: "escalate",
        evidenceQuality: 0,
        remainingUncertainty: 0.8,
        nextBestObservation: "重新执行 HA 终验。",
        critique_items: [
          {
            category: "ha_final_review_gate",
            severity: "high",
            suggestion: "HA 终验 accept 必须包含非空摘要、正向质量评分和正向证据质量。",
          },
        ],
      },
      superegoReview: {
        blocking_issues: 0,
        quality_score: 0.9,
        summary: "Superego 已完成独立抽样验证。",
        next_action: "escalate",
        evidenceQuality: 0.85,
        remainingUncertainty: 0.15,
        critique_items: [],
      },
      egoOutput: "Ego 输出摘要",
    });
    assert(haFinalReviewMessage.includes("HA 终验批注："), "终验失败消息应包含 HA 人类可读批注");
    assert(haFinalReviewMessage.includes("Superego 批注："), "终验失败消息应包含 Superego 人类可读批注");
    assert(haFinalReviewMessage.includes("Superego 批注：\n- 结论：升级给 HA 裁决"), "Superego escalate 展示时不应写成用户人工介入");
    assert(!haFinalReviewMessage.includes("\"blocking_issues\""), "终验失败消息不应泄漏内部 JSON 字段名");
    assert(!haFinalReviewMessage.includes("{\n"), "终验失败消息不应直接展示 JSON 对象");

    const now = new Date(Date.now() - 1000).toISOString();
    const reflectionId = store.addReflectionTask({
      reflectionId: "e2e-reflection-due",
      sourceRunId: "e2e-run",
      purpose: "E2E due reflection",
      triggerAt: now,
      maxWakeups: 1,
    });
    const reflectDue = runCli(["reflect", "due", "--limit", "5"]);
    const reflectJson = JSON.parse(reflectDue.stdout);
    assert(reflectJson.processed >= 1, "reflect due 应处理 due reflection_task");
    assert(store.getReflectionTask(reflectionId)?.status === "completed", "due reflection_task 应进入 completed");

    store.addAutonomyJob({
      jobId: "e2e-autonomy-reflection",
      type: "reflection",
      sourceRunId: "e2e-run",
      triggerAt: now,
      budget: { wakeups: 0, maxWakeups: 1 },
      payload: { e2e: true, reflectionTaskCompat: true },
    });
    store.addReflectionTask({
      reflectionId: "e2e-autonomy-reflection",
      sourceRunId: "e2e-run",
      purpose: "E2E autonomy reflection compat",
      triggerAt: now,
      maxWakeups: 1,
    });
    store.addExperienceNode({
      nodeId: "e2e-autonomy-reflection",
      type: "reflection",
      runId: "e2e-run",
      status: "scheduled",
      title: "E2E scheduled reflection node",
      summary: "autonomy tick 后应同步为 completed",
    });
    store.addAutonomyJob({
      jobId: "e2e-autonomy-dream",
      type: "dream",
      sourceRunId: "e2e-run",
      triggerAt: now,
      budget: { wakeups: 0, maxWakeups: 1 },
      payload: { sourceExperienceNodeId: "e2e-experience", reason: "e2e" },
    });
    store.addAutonomyJob({
      jobId: "e2e-unrelated-autonomy-job",
      type: "consolidation",
      sourceRunId: "e2e-unrelated-run",
      triggerAt: now,
      budget: { wakeups: 0, maxWakeups: 1 },
      payload: { e2e: "unrelated" },
    });
    const goal = store.createGoal({
      goalId: "e2e-goal-continuation",
      cwd: autonomyWorkspace,
      title: "E2E Goal continuation",
      objective: "验证 Goal continuation 不递归执行 MAS run",
      requestedApprovalMode: "approve-reads",
      orchestrationMode: "ha-ego",
      maxTurns: 1,
      acceptanceContract: {
        objective: "验证 Goal continuation 不递归执行 MAS run",
        readonlyInputs: [],
        allowedOutputs: [autonomyWorkspace],
        forbiddenStates: ["不得递归执行 MasRunner.run"],
        doneCriteria: ["有 Judge 结果"],
        failureCriteria: ["缺证据时不能 done"],
        requiredEvidence: ["EntropyLedger"],
        validators: [],
        riskNotes: [],
        rawText: "E2E goal continuation",
      },
    });
    store.addAutonomyJob({
      jobId: "e2e-goal-continuation-job",
      type: "goal_continuation",
      sourceRunId: "e2e-run",
      goalId: goal.goalId,
      triggerAt: now,
      budget: { maxWakeups: 1 },
    });
    const tick = runCli(["autonomy", "tick", "--limit", "5", "--dream-limit", "5", "--run-id", "e2e-run"]);
    const tickJson = JSON.parse(tick.stdout);
    assert(tickJson.due?.processed === 3, "autonomy tick --run-id 应只处理目标 run 的 due autonomy_jobs");
    assert(store.getAutonomyJob("e2e-autonomy-reflection")?.status === "completed", "due AutonomyJob reflection 应进入 completed");
    assert(store.getAutonomyJob("e2e-autonomy-dream")?.status === "completed", "due AutonomyJob dream 应进入 completed");
    assert(store.getAutonomyJob("e2e-unrelated-autonomy-job")?.status === "scheduled", "autonomy tick --run-id 不应处理其他 run 的 due job");
    assert(
      tickJson.due?.completed?.some((job: any) => job.jobId === "e2e-autonomy-reflection" && job.status === "completed"),
      "autonomy tick stdout 应返回 completed job 的最终状态",
    );
    assert(
      store.listExperienceNodes({ runId: "e2e-run", type: "reflection", limit: 10 }).some((node) => node.nodeId === "e2e-autonomy-reflection" && node.status === "completed"),
      "autonomy reflection job 完成后 Experience Graph reflection 节点应同步为 completed",
    );
    assert(store.getReflectionTask("e2e-autonomy-reflection")?.status === "completed", "兼容 reflection_task 应同步为 completed");
    assert(tickJson.due?.goalContinuations?.some((item: any) => item.goalId === goal.goalId), "autonomy tick 应处理 goal_continuation");
    assert(store.getGoal(goal.goalId)?.status === "paused", "缺少低熵证据时 GoalJudge 应暂停 Goal");
    assert(store.listGoalRuns(goal.goalId, 5).length === 1, "goal_continuation 应写入 GoalRun");
    const jobIdFiltered = new AutonomyLoop(store, "e2e-job-id-filter").runDueAutonomyJobs({ jobId: "e2e-unrelated-autonomy-job", limit: 5 });
    assert(jobIdFiltered.processed === 1, "runDueAutonomyJobs --job-id 应只处理指定 due job");
    assert(jobIdFiltered.completed.some((job: any) => job.jobId === "e2e-unrelated-autonomy-job" && job.status === "completed"), "jobId 过滤返回值应包含指定 job 的最终状态");

    store.addApproval({ runId: "e2e-entropy-run", toolCallId: "tool-1", toolName: "shell", decision: "reject_once" });
    store.audit({
      runId: "e2e-entropy-run",
      actor: "superego",
      action: "audit_packet_built",
      payload: { findings: [{ category: "boundary", severity: "high", message: "越界写入", evidence: ["output 外"] }] },
    });
    const entropyLedger = recordRunEntropy(store, {
      runId: "e2e-entropy-run",
      status: "needs_attention",
      result: "验证失败",
      reason: "superego_escalate",
      egoResult: {
        status: "needs_attention",
        summary: "未完成",
        final_response: "未完成",
        evidence: [],
        changed_files: [],
        verification: [{ command: "npm run typecheck", result: "failed", notes: "类型错误" }],
        risks: ["存在失败验证"],
      },
    });
    assert(entropyLedger.riskScore > 0, "失败验证和审计发现应提高 riskScore");
    assert(entropyLedger.uncertaintyScore > 0, "未完成 run 应保留 uncertaintyScore");
    assert(store.listLowEntropySignals({ runId: "e2e-entropy-run", limit: 20 }).some((signal) => signal.type === "audit_finding"), "AuditPacket 应转换为低熵 audit_finding 信号");
    store.addEvalCandidate({
      candidateId: "e2e-candidate",
      sourceRunId: "e2e-entropy-run",
      title: "E2E candidate",
      failureMode: "验证 candidate 控制面",
      inputFixture: { e2e: true },
      expectedAssertions: ["candidate 可以晋升"],
      regressionScope: "manual",
      confidence: 0.8,
    });
    const candidates = runCli(["candidate", "list", "--status", "candidate"]);
    assert(candidates.stdout.includes("e2e-candidate"), "candidate list 应展示候选");
    const promoted = runCli(["candidate", "promote", "e2e-candidate"]);
    assert(promoted.stdout.includes("\"status\": \"promoted\""), "candidate promote 应晋升候选");

    const dreamReflectionId = store.addReflectionTask({
      reflectionId: "e2e-dream-prune",
      sourceRunId: "e2e-run",
      purpose: "E2E dream prune",
      triggerAt: now,
      depth: 1,
      maxDepth: 1,
    });
    const dream = runCli(["reflect", "dream", "--limit", "5"]);
    const dreamJson = JSON.parse(dream.stdout);
    assert(dreamJson.pruned >= 1, "reflect dream 应裁剪预算耗尽 reflection_task");
    assert(store.getReflectionTask(dreamReflectionId)?.status === "pruned", "预算耗尽 reflection_task 应进入 pruned");
  } finally {
    store.close();
  }
}

try {
  await autonomyStorageSmoke();
  cliSmoke();
  await acpSmoke();
  console.log(`OK E2E smoke 完成，临时目录：${tempRoot}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
