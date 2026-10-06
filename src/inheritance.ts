import { randomUUID } from "node:crypto";
import { validModelRef } from "./config.ts";
import { isMode, type ApprovalMode } from "./types.ts";

export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const APPROVAL_INHERITANCE_ENV = "PI_APPROVE_SUBAGENT_SNAPSHOT";

const MAX_SNAPSHOT_BYTES = 4096;
const PUBLISHER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ApprovalModeSnapshot {
  version: 1;
  mode: ApprovalMode;
  reviewer?: string;
  blocked?: boolean;
  publisher: string;
}

export type ApprovalInheritance =
  | { kind: "root" }
  | { kind: "inherited"; snapshot: ApprovalModeSnapshot }
  | { kind: "invalid"; reason: string };

export function captureApprovalInheritance(env: NodeJS.ProcessEnv = process.env): ApprovalInheritance {
  if (env[SUBAGENT_CHILD_ENV] !== "1") return { kind: "root" };

  const raw = env[APPROVAL_INHERITANCE_ENV];
  if (!raw) return { kind: "invalid", reason: "子代理权限快照缺失，工具将默认拦截。" };
  if (Buffer.byteLength(raw, "utf8") > MAX_SNAPSHOT_BYTES) {
    return { kind: "invalid", reason: "子代理权限快照过大，工具将默认拦截。" };
  }

  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const snapshot = value as Record<string, unknown>;
    if (Object.keys(snapshot).some(key => !["version", "mode", "reviewer", "blocked", "publisher"].includes(key)) ||
      snapshot.version !== 1 || !isMode(snapshot.mode) || typeof snapshot.publisher !== "string" ||
      !PUBLISHER_ID.test(snapshot.publisher) ||
      (snapshot.reviewer !== undefined && (typeof snapshot.reviewer !== "string" || !validModelRef(snapshot.reviewer))) ||
      (snapshot.blocked !== undefined && typeof snapshot.blocked !== "boolean")) {
      throw new Error();
    }
    return { kind: "inherited", snapshot: snapshot as unknown as ApprovalModeSnapshot };
  } catch {
    return { kind: "invalid", reason: "子代理权限快照无效，工具将默认拦截。" };
  }
}

export function publishApprovalInheritance(
  mode: ApprovalMode,
  reviewer: string | undefined,
  blocked: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const snapshot: ApprovalModeSnapshot = {
    version: 1,
    mode,
    ...(reviewer && validModelRef(reviewer) ? { reviewer } : {}),
    ...(blocked ? { blocked: true } : {}),
    publisher: randomUUID(),
  };
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("Approval mode snapshot exceeded its size limit.");
  }
  env[APPROVAL_INHERITANCE_ENV] = serialized;
  return serialized;
}

export function restorePublishedApprovalInheritance(
  published: string | undefined,
  previous: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (published === undefined || env[APPROVAL_INHERITANCE_ENV] !== published) return;
  if (previous === undefined) delete env[APPROVAL_INHERITANCE_ENV];
  else env[APPROVAL_INHERITANCE_ENV] = previous;
}
