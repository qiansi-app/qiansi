# Changelog

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
