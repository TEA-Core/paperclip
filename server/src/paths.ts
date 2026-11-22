import path from "node:path";
import { resolveDefaultConfigPath } from "./home-paths.js";
import { currentBootEnvPlan, findAncestorConfig } from "@paperclipai/shared/boot-env";

const PAPERCLIP_ENV_FILENAME = ".env";


export function resolvePaperclipConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  const plan = currentBootEnvPlan();
  if (plan) return plan.configPath;
  if (process.env.PAPERCLIP_CONFIG) return path.resolve(process.env.PAPERCLIP_CONFIG);
  return findAncestorConfig(process.cwd()) ?? resolveDefaultConfigPath();
}

export function resolvePaperclipEnvPath(overrideConfigPath?: string): string {
  return path.resolve(path.dirname(resolvePaperclipConfigPath(overrideConfigPath)), PAPERCLIP_ENV_FILENAME);
}
