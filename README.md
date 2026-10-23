# 牵丝（Qiansi）

**A local-first canvas where every AI model is a teammate.**

Qiansi puts your API models on a canvas as first-class nodes. You designate one model as the orchestrator; it decomposes the goal, assigns subtasks to the other nodes according to their capability profiles, calibrates the reasoning effort per subtask, checks acceptance, and sends work back for bounded revision. You can click any node or wire to chat with that exact model and manually reassign its work.

> Status: early prototype (v0.1.0). The canvas and the engine contracts are in place; the studio currently runs a mock orchestration. The architecture is decided: browser studio + headless CLI + local Hono/SSE server (see [ADR 0001](docs/decisions/0001-architecture.md)). The release name is 牵丝 / Qiansi; the earlier codename collision research is kept in [naming decision 0002](docs/decisions/0002-naming.md).

## Why

Every existing visual AI builder puts **steps** on the canvas; the model is a dropdown inside a step. None of them gives you:

1. Models as first-class nodes with living capability profiles
2. One orchestrator model that visibly owns plan → dispatch → acceptance → revision
3. Per-subtask reasoning-effort calibration
4. Click a node or wire → a persistent 1:1 chat with that model, plus manual reassignment
5. Human-in-the-loop as multi-option choice cards, not binary approve/reject

Qiansi is built around those five ideas. It is not a RAG pipeline builder, an integration platform, or a multi-user SaaS.

## Core concepts

- **Agent slot** = role + model + effort + status. A slot is the canvas node; the model is its property, so one model can serve several roles.
- **Typed wires**: `assign`, `handoff`, `review`, `context`. Wires carry meaning, not just arrows.
- **Task graph**: tasks with `dependsOn`, acceptance criteria, and a machine-checkable flag.
- **Capability profile**: a versioned JSON row per model — protocol, effort dialect, modalities, context, cost, strengths, measured health.
- **Choice card**: a small decision card shown only for real trade-offs (cost/quality tie, budget overrun, low acceptance confidence, retry exhausted).

## Architecture

```
apps/studio   React + React Flow (view only)
packages/engine   pure TypeScript orchestrator, task graph, acceptance, effort calibration
provider adapters   openai-chat | anthropic-messages | MiniMax multimodal sub-adapters
```

The engine never imports React. The canvas never owns business truth: node positions are view state; tasks, messages, and acceptance results live in the engine and are emitted as events.

## Quick start

```bash
npm install
npm run dev        # server :8787 + studio http://localhost:5173
```

### Desktop app

```bash
npm run desktop:dev       # Electron window, dev server + hot reload
npm run desktop:portable  # builds release/Qiansi-portable/Qiansi.exe
```

The portable build is self-contained: it starts the bundled server and serves the studio at `127.0.0.1:8787`. See [docs/desktop.md](docs/desktop.md) for packaging, autostart and known limits.

The model manager tests real connections through the local server. The Run button submits a real live run (3 tasks + a real judge) and streams node status/output over SSE; if the server or relay credential is unavailable it falls back to the local demo.

## Documentation

- [Blueprint](docs/blueprint.md) — product definition, architecture, orchestration state machine, provider strategy, MVP
- [Research notes](docs/research-notes.md) — competitive landscape and technical findings
- [Canvas spec](docs/canvas-spec.md) — full interaction spec synthesized from ComfyUI, n8n, Flowise/Langflow, Dify/Coze and React Flow (v0 baseline in `docs/canvas-spec-v0.md`)
- [Roadmap](docs/roadmap.md) — milestones and acceptance criteria
- [ADR 0001: architecture](docs/decisions/0001-architecture.md) — why browser + headless CLI + Hono/SSE
- [ADR 0002: naming](docs/decisions/0002-naming.md) — confirmed collisions; clearance checklist
- [Connections & security](docs/connections-and-security.md) — editable model identity, key probing, sandboxed tools, connection stability, confidentiality
- [Local server API](docs/server-api.md) — endpoints, auth, SSE, probe behaviour
- [Desktop app](docs/desktop.md) — Electron shell, portable build, autostart, limits
- [Agent integration](docs/agent-integration.md) — MCP tools, OpenAI-compatible gateway, approval relay, budgets
- [ADR 0003: desktop](docs/decisions/0003-desktop.md) — Electron + portable fallback
- [Canvas controls](docs/canvas-controls.md) — orchestrator switching, auto layout, AI discussion, task/artifact/file modules, region brush
- [Release process](docs/release.md) — versioning, CI artifacts, signing, publishing checklist
- [Publish to GitHub](docs/github-publish.md) — first commit, remote, CI, tag release, repository settings
- [中文说明](README.zh-CN.md)

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org). Team roles, build provenance and the privacy statement are in [docs/code-signing-policy.md](docs/code-signing-policy.md).

## License

MIT. See [LICENSE](LICENSE).

Third-party prompt collections and leaked system prompts are **not** vendored into this repository; see `docs/research-notes.md` for the rules.
