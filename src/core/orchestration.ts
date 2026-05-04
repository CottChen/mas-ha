export const DEFAULT_ORCHESTRATION_MODE = "ha-ego-superego";

export const ORCHESTRATION_MODES = {
  "ha-ego-superego": {
    id: "ha-ego-superego",
    name: "HA + Ego + Superego",
    description: "HA 生成验收合同，Ego 执行，Superego 评审并触发返工。",
    usesSuperego: true,
  },
  "ha-ego": {
    id: "ha-ego",
    name: "HA + Ego",
    description: "HA 生成验收合同，Ego 执行，跳过 Superego 评审和返工。",
    usesSuperego: false,
  },
} as const;

export type OrchestrationMode = keyof typeof ORCHESTRATION_MODES;

export function normalizeOrchestrationMode(value: unknown): OrchestrationMode {
  if (typeof value === "string" && value in ORCHESTRATION_MODES) {
    return value as OrchestrationMode;
  }
  return DEFAULT_ORCHESTRATION_MODE;
}

export function orchestrationModeList(): Array<{
  id: OrchestrationMode;
  name: string;
  description: string;
}> {
  return Object.values(ORCHESTRATION_MODES).map(({ id, name, description }) => ({ id, name, description }));
}
