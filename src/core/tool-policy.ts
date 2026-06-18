export const MAS_BASH_DEFAULT_TIMEOUT_SECONDS = 120;
export const MAS_BASH_DEFAULT_TIMEOUT_ENV = "MAS_BASH_DEFAULT_TIMEOUT_SECONDS";

const MAX_BASH_DEFAULT_TIMEOUT_SECONDS = 24 * 60 * 60;

export function getMasBashDefaultTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAS_BASH_DEFAULT_TIMEOUT_ENV]?.trim();
  if (!raw) return MAS_BASH_DEFAULT_TIMEOUT_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return MAS_BASH_DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.trunc(value), MAX_BASH_DEFAULT_TIMEOUT_SECONDS);
}

export function bashTimeoutGuidance(): string {
  const timeout = getMasBashDefaultTimeoutSeconds();
  return [
    "bash 命令超时规则：",
    `- MAS 会给未显式设置 timeout 的 bash 命令自动应用默认超时：${timeout} 秒。`,
    "- 如果命令预计更久，例如安装依赖、构建、大型测试或只读数据复算，应在 bash 工具参数中显式设置更大的 timeout 秒数。",
    "- 如果命令只是快速探测，应按需设置更小的 timeout，避免无意义等待。",
    "- 长期运行的服务命令不能当成普通前台验证命令等待自然结束；需要启动服务时，应设置有限 timeout 完成短探活，并在结果中报告端口、日志和剩余风险。",
    "- Windows 环境禁止按进程名批量杀 Node，例如 `taskkill /F /IM node.exe`、`Stop-Process -Name node`、`pkill node`；清理服务必须定位当前任务启动的具体 PID 或端口。",
  ].join("\n");
}

export interface BashCommandPolicyDecision {
  allowed: boolean;
  reason?: string;
  ruleId?: string;
  severity?: "low" | "medium" | "high";
}

export function evaluateBashCommandPolicy(command: string): BashCommandPolicyDecision {
  const normalized = normalizeCommand(command);
  if (!normalized) return { allowed: true };

  const context: BashCommandPolicyContext = {
    normalized,
  };
  for (const rule of BASH_COMMAND_POLICY_RULES) {
    if (rule.match(context)) {
      return { allowed: false, reason: rule.reason, ruleId: rule.id, severity: rule.severity };
    }
  }
  return { allowed: true };
}

interface BashCommandPolicyContext {
  normalized: string;
}

interface BashCommandPolicyRule {
  id: string;
  severity: "low" | "medium" | "high";
  reason: string;
  match: (context: BashCommandPolicyContext) => boolean;
}

const GLOBAL_NODE_KILL_REASON =
  "禁止按进程名或镜像名批量结束 Node 进程；这会杀掉 MAS/ACP/AionUI runtime 或其他无关 Node 进程。请先定位当前任务启动的具体 PID 或端口，再只清理该进程。";

const BASH_COMMAND_POLICY_RULES: BashCommandPolicyRule[] = [
  {
    id: "windows-taskkill-node-image",
    severity: "high",
    reason: GLOBAL_NODE_KILL_REASON,
    match: ({ normalized }) => /\btaskkill\b/.test(normalized) && (/(?:\/|-)+im\s+node(?:\.exe)?\b/.test(normalized) || /imagename\s+eq\s+node(?:\.exe)?\b/.test(normalized)),
  },
  {
    id: "powershell-stop-process-node-name",
    severity: "high",
    reason: GLOBAL_NODE_KILL_REASON,
    match: ({ normalized }) =>
      /\bstop-process\b/.test(normalized) &&
      (/(?:-name|-processname)\s+['"]?node(?:\.exe)?['"]?\b/.test(normalized) ||
        /\bget-process\b(?=.*\bnode(?:\.exe)?\b)(?=.*\|\s*stop-process\b)/.test(normalized)),
  },
  {
    id: "posix-kill-node-name",
    severity: "high",
    reason: GLOBAL_NODE_KILL_REASON,
    match: ({ normalized }) => /\b(?:pkill|killall)\b/.test(normalized) && /\bnode(?:\.exe)?\b/.test(normalized),
  },
  {
    id: "pipeline-kill-node-process-list",
    severity: "high",
    reason: GLOBAL_NODE_KILL_REASON,
    match: ({ normalized }) =>
      /\b(?:ps|pgrep|get-process)\b/.test(normalized) &&
      /\bnode(?:\.exe)?\b/.test(normalized) &&
      /\|\s*(?:xargs\s+)?(?:kill\b|stop-process\b|taskkill\b)/.test(normalized),
  },
  {
    id: "posix-kill-pgrep-node-substitution",
    severity: "high",
    reason: GLOBAL_NODE_KILL_REASON,
    match: ({ normalized }) => /\bkill\b/.test(normalized) && /\bpgrep\b(?=.*\bnode(?:\.exe)?\b)/.test(normalized),
  },
];

function normalizeCommand(command: string): string {
  return command
    .replace(/[`\\\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
