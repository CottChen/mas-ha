import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

loadLocalEnv();

export const MAS_HOME = process.env.MAS_HOME ?? join(process.env.HOME ?? process.cwd(), ".mas");
export const MAS_DATA_DIR = join(MAS_HOME, "data");
export const MAS_ARTIFACT_DIR = join(MAS_HOME, "artifacts");

export function ensureMasDirs(): void {
  mkdirSync(MAS_DATA_DIR, { recursive: true });
  mkdirSync(MAS_ARTIFACT_DIR, { recursive: true });
}

function loadLocalEnv(): void {
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const envPath = join(projectRoot, ".env.local");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    process.env[key] = value;
  }
}
