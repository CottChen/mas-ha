import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const MAS_HOME = process.env.MAS_HOME ?? join(process.env.HOME ?? process.cwd(), ".mas");
export const MAS_DATA_DIR = join(MAS_HOME, "data");
export const MAS_ARTIFACT_DIR = join(MAS_HOME, "artifacts");
export const AIONUI_BIN = process.env.AIONUI_BIN ?? "/opt/AionUi/AionUi";

export function ensureMasDirs(): void {
  mkdirSync(MAS_DATA_DIR, { recursive: true });
  mkdirSync(MAS_ARTIFACT_DIR, { recursive: true });
}
