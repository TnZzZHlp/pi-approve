import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCallEvent, ToolInfo } from "@earendil-works/pi-coding-agent";

const FILE_TOOLS = new Set(["read", "write", "edit", "ls"]);
const PROTECTED = /^(?:\.git|\.pi|\.ssh|\.aws|\.gnupg|\.env(?:\..*)?|\.npmrc|\.pypirc|auth\.json|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx)|AGENTS(?:\.override)?\.md|CLAUDE\.md)$/i;

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
function normalize(input: string) {
  let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    path = join(homedir(), path.slice(2));
  }
  if (path.startsWith("file://")) path = fileURLToPath(path);
  return path;
}

export async function boundaryReason(event: ToolCallEvent, cwd: string, tool?: ToolInfo): Promise<string | undefined> {
  if (!tool || tool.sourceInfo.path !== `builtin:${event.toolName}` || !FILE_TOOLS.has(event.toolName)) {
    return "Shell、递归搜索、网络或扩展工具需要审批；工具声明的安全提示不作为授权。";
  }
  const input = event.input as Record<string, unknown>;
  const raw = input.path ?? (event.toolName === "ls" ? "." : undefined);
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return "无法确定操作路径。";
  try {
    const workspace = await realpath(cwd);
    const target = resolve(workspace, normalize(raw));
    if (!inside(workspace, target)) return "操作位于工作区之外。";
    const parts = relative(workspace, target).split(sep).filter(Boolean);
    if (parts.some(part => PROTECTED.test(part))) return "凭据、策略、指令或运行时配置需要审批。";
    let current = workspace;
    for (const part of parts) {
      current = join(current, part);
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) return "路径含符号链接，需要审批。";
        if (!stats.isDirectory() && !stats.isFile()) return "特殊文件需要审批。";
        if (stats.isFile() && stats.nlink > 1) {
          return event.toolName === "read" ? "读取多重硬链接文件需要审批。" : "修改多重硬链接文件需要审批。";
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (event.toolName === "read" || event.toolName === "edit") return "路径不存在或无法确认。";
        break;
      }
    }
    input.path = target;
    return undefined;
  } catch {
    return "路径无法规范化或检查，需要审批。";
  }
}
