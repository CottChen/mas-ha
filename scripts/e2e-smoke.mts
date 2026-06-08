import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "mas-e2e-smoke-"));
const masHome = join(tempRoot, "mas-home");
const workspace = join(tempRoot, "workspace");
mkdirSync(workspace, { recursive: true });

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
  const client = startAcp(["--experimental-acp", "--approve-all", "--approval-mode-policy", "mutable", "--orchestration-mode", "ha-ego-superego"]);
  try {
    const initialized = await client.request("initialize", {});
    assert(initialized.serverInfo?.name === "mas", "initialize 应返回 mas serverInfo");
    assert(initialized.capabilities?.sessionCapabilities?.prompt === true, "initialize 应声明 prompt 能力");

    const session = await client.request("session/new", { cwd: workspace, orchestrationMode: "ha-ego" });
    const sessionId = String(session.sessionId);
    assert(session.currentModeId === "bypassPermissions", "approve-all 初始模式应映射为 bypassPermissions");
    assert(session.configOptions?.[0]?.value === "ha-ego", "session/new 应采用请求的编排模式");
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
    assert(
      client.notifications.some((msg) => JSON.stringify(msg).includes("\"compact\"") && JSON.stringify(msg).includes("\"goal\"")),
      "session/new 应公告 /compact 和 /goal 命令",
    );

    const mode = await client.request("session/set_mode", { sessionId, modeId: "default" });
    assert(mode.currentModeId === "default", "mutable 策略下 set_mode default 应生效");

    const config = await client.request("session/set_config_option", { sessionId, optionId: "orchestrationMode", value: "ha-ego-superego" });
    assert(config.configOptions?.[0]?.value === "ha-ego-superego", "set_config_option 应切换编排模式");

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
}

function runCli(args: string[], expectedStatus = 0): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, "src/cli.ts"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, MAS_HOME: masHome },
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
    env: { ...process.env, MAS_HOME: masHome },
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
  const { AutonomyLoop } = await import("../src/core/autonomy.js");
  const { ContextPerturbationController } = await import("../src/core/context-perturbation.js");
  const { buildRecentActivitySummary } = await import("../src/core/activity.js");
  const { buildEgoPrompt, buildHaDecisionPrompt, buildHaFinalReviewPrompt, buildSuperegoPrompt } = await import("../src/core/prompts.js");
  const { isReadOnlyTool } = await import("../src/pi/pi-sdk.js");
  const store = new MasStore();
  const perturbations = new ContextPerturbationController(store);
  const autonomyWorkspace = join(tempRoot, "autonomy-workspace");
  mkdirSync(autonomyWorkspace, { recursive: true });
  try {
    const haPerturbation = perturbations.createCandidate({
      runId: "e2e-perturb-ha",
      targetRole: "ha",
      trigger: "intent_check",
      sourceRefs: ["e2e:user_task"],
    });
    const egoPerturbation = perturbations.createCandidate({
      runId: "e2e-perturb-ego",
      targetRole: "ego",
      trigger: "execution_plan",
      sourceRefs: ["e2e:contract"],
    });
    const superegoPerturbation = perturbations.createCandidate({
      runId: "e2e-perturb-superego",
      targetRole: "superego",
      trigger: "review_sampling",
      sourceRefs: ["e2e:audit_packet"],
    });
    assert(haPerturbation?.payload && typeof haPerturbation.payload === "object", "HA 普通路由应生成低风险上下文扰动");
    assert(egoPerturbation?.payload && typeof egoPerturbation.payload === "object", "Ego 首轮执行应生成低风险上下文扰动");
    assert(superegoPerturbation?.payload && typeof superegoPerturbation.payload === "object", "Superego 普通评审应生成低风险上下文扰动");
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
    assert(buildHaDecisionPrompt("E2E 最近在做什么").includes("mas_query_recent_activity"), "HA prompt 应要求状态问题使用近期活动查询工具");
    assert(buildHaDecisionPrompt("查询第三方库当前版本").includes("mas_external_search"), "HA prompt 应说明外部检索工具");
    assert(
      buildHaFinalReviewPrompt("E2E", "验收合同", "{}", undefined).includes("ha_final_review"),
      "HA 终验 prompt 应要求调用 ha_final_review 工具",
    );
    assert(
      buildHaFinalReviewPrompt("E2E", "验收合同", "{}", undefined).includes("mas_external_search"),
      "HA 终验 prompt 应允许使用外部检索工具做交叉验证",
    );
    assert(buildEgoPrompt("E2E", "验收合同").includes("mas_query_memory"), "Ego prompt 应说明历史经验查询工具");
    assert(
      buildSuperegoPrompt("E2E", "验收合同", "{}", {} as any).includes("mas_query_recent_activity"),
      "Superego prompt 应说明近期活动查询工具",
    );
    assert(
      !buildSuperegoPrompt("E2E", "验收合同", "{}", {} as any).includes("mas_external_search"),
      "Superego prompt 不应暴露 HA 专属外部检索工具",
    );
    assert(isReadOnlyTool("mas_query_memory"), "历史经验查询工具应被权限层识别为只读");
    assert(isReadOnlyTool("mas_query_recent_activity"), "近期活动查询工具应被权限层识别为只读");
    assert(isReadOnlyTool("mas_external_search"), "外部检索工具应被权限层识别为只读");

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
