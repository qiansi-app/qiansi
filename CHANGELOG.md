# Changelog

## Unreleased

- **接管会话 takes over the session you are actually in.** With an empty project field, the server used its own start directory to locate Claude Code transcripts, so it could pick a weeks-old session from an unrelated project — the plan then worked on the wrong task, and nothing the user was doing got continued. Discovery now defaults to the globally most recently active session, reads project facts from that session's own `cwd`, and notes when an explicitly entered project differs. Verified: handoff picked the live session (age 0 min, 302 records) with project `e:\代码转视频` instead of the Nov 8 session under the server directory.
- **接管 runs the plan it produces.** Worker nodes are text-only models, so goals like "调用 mcp__qiansi__describe_canvas" used to become impossible tasks and the run aborted on acceptance. The planner now turns tool/MCP/file actions into a text deliverable plus an execution checklist, and the final node summarizes what is ready to execute. Re-ran the previously failing goal end-to-end: plan produced 「MCP 调用待执行清单」 + 一句话汇总, the run finished `done` in 39 s with acceptance score 1.0, and both nodes are `done` on the canvas.
- **Handoff no longer flashes console windows.** The git probes behind the duplicate-session/dirty checks spawned without `windowsHide`; under the VS Code extension host (which has no console) each call opened a visible console window. Hidden now.
- **接管后自动跳到新画布** when a run was started, so progress is visible immediately instead of leaving the user on the old canvas.
- **接管 failure modes are now visible and predictable.** A run that cannot start (409 run already in progress, 403 policy, 422 canvas not runnable, 503 missing credentials) returns its reasons/hint in `runError` and as a note instead of being swallowed. Unchecking 自动编排 disables 立即运行 (there would be no runnable nodes) and the server explains when a requested run was skipped. An archived (no-plan) canvas no longer renders a 去新画布 button. An explicitly entered project directory is now strict — no silent fallback to another project's session — and Codex sessions contribute their `cwd`; trailing separators are normalized before encoding. The planner also ranks the user's explicit task above the session/reference pack: the pack supplements facts but cannot replace the goal. `qiansi start` hides its detached console window.

- **Self-optimization is now a multi-model panel, not one voice.** Multiple models (one per configured vendor, up to five) read the same evidence through different lenses (correctness / adversarial / usability / evolution), then cross-examine each other: every candidate is confirmed, revised with corrected evidence/proposal/acceptance, or refuted; a flagship host merges duplicates and drops refuted candidates. Code changes get a second set of eyes too — a different model reviews the diff before the commit and can roll it back. Falls back to single-model reflection when only one model is available; panel size scales with level (L1 2 → L4 4) and can be pinned with `QIANSI_SELFOPT_PANEL` / `QIANSI_SELFOPT_MODELS`. The panel, stage strip and canvas nodes show who proposed each finding and the review verdicts. Verified with a fake-model harness (32 assertions: perspectives, refute/revise/merge, reviewer rollback, single-model fallback) and on real models through an isolated instance (panel deepseek-v4-pro + claude-opus-4-8[1M], 15.6k tokens, canvas `自省 · fixture` with 提出/互审 lines; UI 11/11).

- **Self-optimization runs on a canvas, on any repository.** Each session now creates its own canvas — 「自省 · <repo>」 — where the survey becomes a node and every discovered problem becomes an artifact node carrying its evidence, proposed fix, acceptance criteria and status (updated live as fixes are applied). The panel gained a project-path field, so the same survey → benchmark → reflect → apply → verify → snapshot loop can optimize any git project, not just Qiansi; the result view links straight to the canvas. Verified end-to-end on a separate fixture repo: one [high/bug] finding (off-by-one in findNote) surfaced as a node with its fix, on a canvas named after that repo.

- **Layout that survives a narrow panel.** The canvas tabs moved out of the toolbar into their own row; the toolbar measures itself and, below 860px, drops the brand subtitle and counters, and below 560px reorders itself so 接管会话 / 重载 / 运行编排 stay fully visible while secondary tool icons scroll. The canvas refits the graph (~250ms debounce) whenever its container changes size, so dragging the VS Code sidebar no longer leaves nodes off-screen.

- **One workflow = one canvas, with tabs and history.** Delegated tasks and handoffs now each get a fresh canvas named after the task instead of overwriting the one you are looking at. The workspace dropdown became a tab strip: running canvases show a pulsing dot, closing a tab archives the canvas into 历史画布 (soft delete), and history offers restore or permanent delete. `POST /api/workspaces/:id/archive|restore` added; `GET /api/workspaces` now carries `archivedAt` and a live `running` count per canvas.
- **接管会话 is a first-class toolbar button** (it was buried under 更多), and it actually starts work: handoff defaults to auto-run, passes the session task text straight to the canvas, skips the slow critique pass, and runs in the new canvas. Delegated runs no longer depend on the current canvas having an orchestrator set — one is synthesized from the billing strategy when missing.
- **Handoff reads the right thing.** Tool results were being mistaken for user requests (`role: user` also carries `tool_result` blocks, and transcripts can reach 100 MB), so a fixed 512 KB tail missed the latest ask entirely. The reader now scans backwards in chunks until it finds real text messages, and the workflow call falls back through every available model instead of two — one dead key no longer kills the takeover.

- **DSH plugin finalized (qiansi-dsh 0.1.1)**: one command installs it into a bootable DSH profile (`node dsh/qiansi/install.mjs --profile <name> --template headless`), because `dsh plugin add` on a fresh name initializes a base-only profile with no app. The installer now also adds the `@deepseek-ai/dsh-mcp-client` bridge explicitly — it declares no `dsh.bundle`, so it never becomes a profile layer and the patch's reference to it would otherwise fail to resolve. The status plugin's reachability probe no longer gives up after 1.5s (DSH's startup saturates the event loop and a live canvas was reported as down); it retries once and reports with a fallback path when the host has no logger. `QIANSI_DSH_DEBUG=1` mirrors the status line to stderr. Verified end-to-end: fresh profile → boot → `[qiansi] canvas reachable` + `[qiansi-mcp] ready`, and the same stdio invocation exposes 29 tools.

- **Auto-arrange sizes itself to the task** instead of always emitting 3–5 nodes: 2–3 for a single deliverable, 4–6 for research→write→verify work, 7–10 when the goal has several independent parts or needs multiple verification rounds. The planner and the critic both apply one test — "delete this node, which deliverable stops being produced?" — and the server caps rise to 10 nodes / 30 edges (12 subtasks per plan). The critic now also flags plans that are split too coarsely or padded to look complete, and the response says whether the plan was revised.
- **Auto-arrange now plans tasks, not roles.** Each generated node carries a one-line work order, a named deliverable (form + required contents) and 2–3 acceptance criteria that a third party can check independently; roles are how a task is carried out, not what gets split. The plan is then reviewed by the same orchestrator wearing a critic's hat, which looks only for overlapping responsibilities, uncovered parts of the goal, and criteria nobody can judge — on a revise verdict the corrected plan replaces the draft and the issues are surfaced in the UI. Deterministic guards back it up: duplicate node names get suffixes, missing criteria get concrete fallbacks, and every worker gets an explicit assign edge.
- The task's own deliverable and acceptance criteria now reach the worker prompt and the orchestrator's acceptance check, instead of one generic standard shared by every task.

- **Self-optimization**: Qiansi can now improve its own repository. Pick one of five modes (`repair` / `harden` / `polish` / `value` / `evolve`) and one of five levels (`L1` report → `L5` loop), and it runs survey → benchmark → reflect → apply → verify → snapshot: runs the repo's own typecheck/tests, reads git state and TODOs, searches the web for competitors and papers when the mode allows, asks a flagship model for evidence-backed findings, then applies each fix as a minimal exact-match edit, re-runs the checks, and commits it with a `selfopt/<hash>` tag. Any failure rolls that one change back.
- Token forecast for every run (`survey + benchmark + reflect + findings × per-fix`), calibrated against the median predicted/actual ratio of previous sessions of the same mode and level.
- Version index survives restarts: list versions, view the diff, `git checkout -B qiansi/version-<hash>` to switch, or return to the original branch. The worktree must be clean for anything that writes.
- Safety: git-repo-only, secret scan of the staged diff before every commit (refuses and rolls back on a hit), edits restricted to files listed at start, exact-match uniqueness checks, never pushes, one session at a time. Gated by the new Policy scope `selfopt.write`, audited on start/stop/finish/switch.
- Surfaces: 「更多 → 自我优化」 panel, `qiansi selfopt [--mode] [--level] [--budget] [--rounds] [--dir] [--status] [--versions]`, and the MCP tools `self_optimize` / `self_opt_status` / `self_opt_versions`.
- **Long-running projects**: `run.start` accepts `resumeOf` to continue a failed or interrupted run — only tasks without output are re-executed, completed outputs are injected as upstream context, and every resumed task carries a recovery note. Also exposed as the MCP tool `resume_project` and a 续跑 button on failed/interrupted rows of the Needs-attention panel.
- `autoResume` runs re-queue themselves after a failure or interruption (max 2 more rounds), including after a server restart; intentionally stopped runs are never auto-resumed.
- Leadership layer: the full judge defaults to a flagship model (`judgeModel` > orchestrator node model > `deepseek-v4-pro` > relay sonnet); each run ends with a flagship review (`verdict` / `score` / `suggestions` / `action`), and a multi-model discussion starts automatically when a task failed or the average acceptance score is below 0.6.
- Needs-attention inbox (`GET /api/attention`) aggregates pending approvals, judge `needsHuman` verdicts, failed runs and interrupted runs; the toolbar shows a badge.
- Upstream output pruner (threshold 8192 / head 4096 / tail 1024 chars) keeps deep chains from re-injecting whole earlier outputs; workspace-level standing instructions are injected into every worker prompt.
- Run records persist from creation; leftovers are marked `aborted` at boot; a side-effect ledger replays missing canvas write-backs and deliverables. `/api/admin/stop` and SIGINT/SIGTERM now shut down gracefully, and `qiansi watchdog [--interval 60] [--once]` supervises the server by exit code.

## 0.1.6 — 2026-10-23

- Auto layout, AI refinement and one-click workflow generation now re-fit the viewport, so the whole graph is visible instead of leaving the user zoomed into one corner.

## 0.1.5 — 2026-10-23

- One-click workflow: describe a goal, pick the orchestrator and worker models, optionally attach files or a folder, and the orchestrator designs a 3–5 node workflow that is placed on the canvas with assign/handoff/review wires and a public file library.
- Added `POST /api/workflow`; the plan is validated against the available connections before anything touches the canvas.
- Fixed the layered layout hanging on review/retry cycles by assigning levels only on first visit.

## 0.1.4 — 2026-10-23

- Added “清空画板” under More → System: removes every node, wire, message and run state after a confirmation. Model connections, settings and uploaded files are kept.
- An intentionally empty canvas is now persisted and restored as empty instead of falling back to the starter graph.

## 0.1.3 — 2026-10-23

- Final brand icon: blue-to-peach gradient squircle with a black orchestration tree (one orchestrator, two workers), rendered at 16–256 px plus a multi-size `.ico`.
- Performance regions can now be resized by dragging any corner or edge handle; the new size is persisted with the canvas.
- Region geometry moved from inline styles to React Flow node width/height, with a migration for canvases saved by older builds.

## 0.1.2 — 2026-10-23

- New brand icon: a white silk loop with a teal-to-violet centre node, smooth rounded corners, and size-specific 16/20/24 px variants inside a multi-size `.ico`.
- Decluttered the top bar: add, auto-layout, brush, file and discussion stay as icon tools; file library, model connections, run report, approvals, external agents, reset and settings move into a grouped “more” menu.
- Counters for discussions, approvals and external sessions now appear as compact badges.

## 0.1.1 — 2026-10-23

- New application icon: 1024 px master with smooth rounded corners, dedicated 16/20/24/32 px variants, and a multi-size `.ico` used by both NSIS and portable builds.
- README now carries the build badge, a direct download link and the clone command.
- Packaging fixes: disable electron-builder's workspace npm rebuild, resolve the Studio resources path from the repository root, and stop automatic publishing during builds.

## 0.1.0 — 2026-10-21

> 2026-10-22 fixes: stable memoized canvas nodes (the previous build could hit React maximum-update-depth and render a black window), renderer error boundary, Ctrl/⌘ or Shift multi-select, brush exits after one region, AI layout returns levels while local layout applies instantly, duplicate/self-loop wire guards, and file modules delete their file on disk.

First release under the 牵丝 / Qiansi name.

- Renamed from the AgentWeave engineering codename: package scope `@qiansi/*`, app id `dev.qiansi.desktop`, executable `Qiansi.exe`.
- Data directory moved to `~/.qiansi`; an existing `~/.agentweave` directory is migrated on first start. The DPAPI vault and run history carry over.
- `%APPDATA%\AgentWeave` (renderer storage) is migrated to `%APPDATA%\Qiansi` once; browser settings fall back to the old localStorage key.
- Old `AGENTWEAVE_*` environment variables, `x-agentweave-*` headers, and the `aw_session` cookie are still accepted, and the MCP server sends both header sets, so existing integrations keep working.
- Added a 256 px app icon plus a multi-size `.ico`.
- Portable builds now stamp product/version resources into the executable instead of shipping Electron's identity.
- Packaging: `asarUnpack` for the bundled server, explicit executable name, timestamp server configured for future signing.
- CI: `npm ci`, version consistency check, NSIS + portable artifacts, SHA-256 checksums, and a tag-driven GitHub Release.
- Orchestrator is now switchable: any agent node can be promoted to the main model from its 「能力」 tab; the roster sent to the run and the judge marks it as `[主控]`.
- Auto layout: the toolbar asks the orchestrator model for coordinates and falls back to a deterministic layered layout when the model or relay is unavailable.
- AI discussion: Ctrl/⌘ (or Shift) select two or more model nodes, give a topic, and each model speaks in turn with the full prior transcript; results can be saved as an artifact module.
- Task and artifact modules: run tasks and artifacts can be pulled out of the report onto the canvas, shown or hidden per module or from Settings.
- File modules: upload a file, get a node with a text preview, and wire it into any model or task as context.
- Region brush: drag a rectangle to create a subproject region; the mode (two-way, inbound, outbound, closed) gates which wires may cross the boundary.
- Node deletion is consistent across agent, task, artifact, file and region nodes, with a styled confirmation dialog.
- Node chat now calls the configured model through `/api/chat` instead of replying with a mock.
- Canvas persistence: node positions, wires, regions, task/artifact/file modules, hidden state and the chosen orchestrator are saved to `~/.qiansi/canvas.json` and restored on restart. Transient final-artifact nodes are not persisted.
- Drag membership: nodes, tasks, artifacts, files and libraries can be dragged into or out of a project region; membership is decided by the node center and the region gate still applies to crossing wires.
- Copy module: task and artifact modules can be duplicated from the inspector; copies carry their own output and do not affect the main flow.
- File library: a library node can hold many files, upload multiple files or a whole folder (relative paths preserved), and connect to several nodes. The auto-created public library connects to every model node and injects its file previews into node chat and AI discussion.
- Artifacts on wires: each task's output appears as a clickable chip on its source wire as soon as the task completes (not only at run end); an artifact module can be returned to its wire from the inspector, and pinned chips survive restart.
- File nodes and libraries can fan out to multiple targets; duplicate wires between the same pair are still rejected.
