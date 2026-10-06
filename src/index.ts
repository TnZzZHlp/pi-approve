import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ApprovalController } from "./controller.ts";

export default function (pi: ExtensionAPI) {
  new ApprovalController(pi).register();
}
