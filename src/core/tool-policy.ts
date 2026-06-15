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
  ].join("\n");
}
