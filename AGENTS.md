# pi-approve

## Overview

Pi extension providing a tool-level approval gate, not an OS sandbox. Modes are `ask` (human approval), `auto` (independent model review), and `full` (no approval from this extension). Users control it through `/permissions`, Ctrl+Shift+A, `--approval-mode`, and `--approval-reviewer`.

## Layout

- `src/index.ts`: thin extension entry point; registers `ApprovalController`.
- `src/controller.ts`: lifecycle, commands, serialized approval queue, cancellation, session state, audit records, reviewer usage, and denial circuit breaker.
- `src/boundary.ts`: built-in tool identification, workspace path normalization, protected paths, symlinks, hardlinks, and special-file checks.
- `src/reviewer.ts`: reviewer selection, bounded transcript evidence, model invocation, timeout, and strict response validation. Includes the Codex `codex-auto-review` fallback.
- `src/policy.ts`: reviewer policy and denial guidance.
- `src/config.ts`: validated agent-directory `approval.json` loading and atomic saving.
- `src/inheritance.ts`: validated approval-mode snapshots passed from a root Pi process to native detached child processes.
- `src/types.ts` and `src/ui.ts`: shared modes/types and dialogs/status/text sanitization.
- `e2e/approval.ts` and `e2e/inheritance.ts`: end-to-end scenarios; `rpc-client.ts` launches Pi and handles RPC dialogs; `mock-server.ts` serves local streaming model responses.

## Development

- ESM TypeScript; Node.js requirement is `>=22.19.0`. Compiler settings are strict, ES2023, NodeNext, and no emit.
- npm manifests and lockfile are present. Pi AI, coding-agent, and TUI packages are peer dependencies. The lockfile does not include their installed packages; the inspected environment supplies them through symlinks to Pi 1.0.4. A fresh dependency installation procedure has not been verified.
- Run `npm run check` for TypeScript checking of both `src/` and `e2e/`.
- Run `npm run test:e2e` for integration coverage. Requires `pi` on PATH, localhost HTTP access, child processes, shell execution, and filesystem link support. Tests use offline Pi processes, a temporary `PI_CODING_AGENT_DIR`, and mock providers rather than real credentials.
- Both commands passed in the inspected environment on Node.js 25.9.0. Minimum-version compatibility was not tested; the mock server imports `zstdDecompressSync` from `node:zlib`.
- No separate build, lint, or formatter script is defined. The package ships `src/` and declares `src/index.ts` as its Pi extension.

## Coding and testing

- Follow existing two-space indentation, double quotes, semicolons, explicit `.ts` import extensions, and type-only imports where appropriate.
- Keep registration/bootstrap thin and retain the existing module responsibility boundaries.
- Preserve existing Chinese notifications and reviewer explanations, English mode labels, and sanitization of untrusted UI text through `displayText`.
- Extend the existing end-to-end scenarios for permission behavior; assert tool side effects, confirmation counts, reviewer requests, and blocked-data non-disclosure. Keep test configuration isolated in temporary directories and clean up Pi processes/server/files in `finally`.

## Safety and behavior constraints

- In `ask`/`auto`, only verified built-in `read`, `write`, `edit`, and `ls` operations on ordinary workspace paths bypass approval. Shell, recursive search, network, extension/MCP tools, external/protected paths, symlinks, multi-linked files, and special files require approval. Tool descriptions and annotations are not authorization.
- A valid `auto` denial offers human confirmation of the exact action when UI is available. Only an explicit allow may override it; refusal/cancellation or no UI keeps it blocked. Preserve the reviewer denial and human decision in audit records, and do not change the permission mode.
- Preserve fail-closed behavior: invalid configuration blocks tools; missing UI in `ask`, unavailable reviewers, timeouts, malformed responses, and reviewer tool calls must not become approvals or offer a denial override.
- Reviewer evidence is untrusted. Only actual user messages establish authorization. Keep the reviewer tool-free and require exactly `decision` and `reason` in its JSON response.
- Approval covers the exact action only. Preserve epoch/signal checks, input snapshots, cancellation on mode/session changes, and the denial guidance against alternate-route retries.
- Preserve the auto-mode breaker: three consecutive final denials or ten final denials in the last fifty approvals interrupt the turn; explicitly human-approved overrides count as allows. Reviewer usage must remain included in tool usage accounting, including nested tools.
- All three modes, including `full`, are saved in agent-directory `approval.json`. Restore precedence is explicit CLI mode, active-branch state, saved mode, then `ask`. CLI overrides alone do not rewrite the saved preference. Switching from another mode to `full` requires confirmation and warns that it persists across new sessions/restarts.
- Native detached Pi child processes inherit the root process's launch-time mode snapshot only when `PI_SUBAGENT_CHILD=1`; inherited mode/reviewer data is not written to shared config. Invalid or missing child snapshots fail closed, and ordinary root processes ignore stray snapshot variables.
- Configuration writes use a private directory/file and temporary-file rename; preserve reviewer mappings and timeout when saving a mode. Never use the user's real agent configuration or credentials as test fixtures.
