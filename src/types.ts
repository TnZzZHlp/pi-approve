import type { Usage } from "@earendil-works/pi-ai";

export const MODES = ["ask", "auto", "full"] as const;
export type ApprovalMode = (typeof MODES)[number];
export const MODE_LABELS: Record<ApprovalMode, string> = {
  ask: "Ask for approval",
  auto: "Approve for me",
  full: "Full access",
};
export function isMode(value: unknown): value is ApprovalMode {
  return MODES.includes(value as ApprovalMode);
}
export interface ApprovalConfig {
  mode?: ApprovalMode;
  reviewers: Record<string, string>;
  timeoutMs: number;
}
export interface ApprovalState {
  mode: ApprovalMode;
}
export interface ReviewResult {
  decision: "allow" | "deny" | "unavailable";
  reason: string;
  reviewer?: string;
  reviewerDecision?: "deny";
  humanDecision?: "allow" | "deny";
  usage?: Usage;
}
export interface ApprovalRecord extends ReviewResult {
  tool: string;
  actionHash: string;
  mode: ApprovalMode;
  time: number;
}
