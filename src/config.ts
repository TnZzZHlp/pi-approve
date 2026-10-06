import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ApprovalConfig } from "./types.ts";

export function configPath() {
  return join(getAgentDir(), "approval.json");
}
export async function loadConfig(): Promise<ApprovalConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath(), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected an object");
    const reviewers: Record<string, string> = Object.create(null);
    if (raw.reviewers !== undefined) {
      if (!raw.reviewers || typeof raw.reviewers !== "object" || Array.isArray(raw.reviewers)) {
        throw new Error("reviewers must be an object");
      }
      for (const [provider, model] of Object.entries(raw.reviewers)) {
        if (typeof model !== "string" || !validModelRef(model)) throw new Error("Invalid reviewer model");
        reviewers[provider] = model;
      }
    }
    const timeoutMs = raw.timeoutMs ?? 90_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
      throw new Error("timeoutMs must be between 1000 and 300000");
    }
    return { reviewers, timeoutMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { reviewers: Object.create(null), timeoutMs: 90_000 };
    }
    throw error;
  }
}
export function validModelRef(value: string): boolean {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1 && !/\s/.test(value);
}
export async function saveConfig(config: ApprovalConfig) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temp, path);
}
