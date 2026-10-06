import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODES, MODE_LABELS, type ApprovalMode } from "./types.ts";

export function displayText(text: string) {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, char =>
    "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}
export function status(ctx: ExtensionContext, mode: ApprovalMode, reviewing = false) {
  const text = `${MODE_LABELS[mode]}${reviewing ? " | Reviewing..." : ""}`;
  ctx.ui.setStatus("pi-approve", ctx.mode === "tui"
    ? ctx.ui.theme.fg(mode === "full" ? "warning" : "accent", text)
    : text);
}
export async function selectMode(ctx: ExtensionContext, current: ApprovalMode) {
  if (!ctx.hasUI) return undefined;
  const labels = MODES.map(mode => `${mode === current ? "[active] " : ""}${MODE_LABELS[mode]}`);
  const choice = await ctx.ui.select("Permissions", labels);
  const index = labels.indexOf(choice ?? "");
  return index < 0 ? undefined : MODES[index];
}
export async function confirmFull(ctx: ExtensionContext) {
  return ctx.hasUI && await ctx.ui.confirm(
    "Enable Full access?",
    "将关闭本插件的所有审批门禁。工具可使用 Pi 进程的文件、网络和系统权限。其他插件的限制仍然生效。",
  );
}
