import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { loadPiSdk } from "../pi/pi-sdk.js";
import type { SkillSummary } from "../types.js";

export async function discoverSkills(cwd: string): Promise<SkillSummary[]> {
  const pi = await loadPiSdk();
  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir: pi.getAgentDir(),
    additionalSkillPaths: configuredSkillPaths(),
  });
  await loader.reload();
  const result = loader.getSkills();
  return result.skills.map((skill: Record<string, unknown>) => ({
    name: String(skill.name ?? ""),
    description: String(skill.description ?? ""),
    path: String(skill.filePath ?? ""),
  }));
}

function configuredSkillPaths(): string[] {
  const value = process.env.MAS_SKILL_PATHS;
  if (!value) return [];
  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && existsSync(item));
}
