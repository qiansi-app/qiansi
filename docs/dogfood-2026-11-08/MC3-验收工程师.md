# 多工作区验收清单（可逐条执行）

## 一、现状

**已落地（可验）**
- `WorkspaceStore`：索引 `~/.qiansi/workspaces.json`，目录 `~/.qiansi/workspaces/<id>/`，方法 `list/current/setCurrent/get/resolve/create/rename/remove/touch`。
- 首次启动迁移：旧 `canvas.json` + `canvas.revision` → `workspaces/main/`，命名「主画布」；无旧文件则「空白画布」。
- `CanvasStore.exists()`；`RunStore.create` 带 `workspaceId`；`/api/runs/active` 按 `belongs()` 过滤（旧记录视为 `main`）；运行产物用发起时 `runWorkspace` 回写。
- API 已有 `/api/workspaces` 的 list/create/rename/remove/setCurrent。

**已确认的缺口（本清单中预期为 FAIL）**
1. `resolve()` 对未知/非法 id 一律回落当前工作区 → 写操作会跨项目落盘。
2. 无工作区级锁与 revision 校验（`apply`/`write`/`persist` 均无）→ 并发丢更新。
3. 迁移分支 `if (!existsSync(to)) renameSync else rmSync(from)` → 目标损坏时删源；迁移中途崩溃后凭「索引存在」判定完成。
4. MCP 工具无 workspace 参数，无参写落到全局当前工作区。
5. SSE、handoff、VS Code 深链未绑定工作区（本轮不在 CRUD 范围，但属发布阻断，见 C1）。

## 二、约束与前置

| 项 | 约束 |
|---|---|
| 数据隔离 | 所有验证在临时 stateDir 内进行，**禁止**在真实 `~/.qiansi` 上执行删除/迁移用例 |
| 进程 | 并发用例需 ≥2 个独立进程（非同一 Node 进程内的并发） |
| 平台 | 锁/重命名用例需 Linux 或 macOS；`chmod` 用例要求非 root |
| 数据库 | 无；断言对象为文件摘要 + 索引 JSON |
| 不可动 | 旧版 `canvas.json` / `canvas.revision` 源文件在迁移失败时必须保留（断言 M-03/M-04） |
| 判定门槛 | P0 全绿才可发布；P1 允许带已知问题发布但需登记 |

**不确定项（执行前必须核对实际代码，本清单相应命令需替换）**
- **R1** stateDir 的注入方式（构造参数 / CLI flag / 环境变量名）——清单占位 `$STATE_DIR`。
- **R2** 工作区标识的传递通道与名字（header `x-workspace-id`？query `workspace`？）与画布写端点路径——清单占位 `$WS_HEADER` / `/api/canvas/apply`。
- **R3** `CanvasStore` 文档 schema（`nodes`/`edges` 字段名）——迁移断言只用文件摘要，不受影响。
- **R4** 构建产物路径（`dist/workspaces.js` vs `dist/server/...`）。
- **R5** MCP 传输方式（stdio/HTTP）与错误响应形态（JSON-RPC error vs HTTP 4xx）——清单给出 HTTP 形态，stdio 需等价替换。

## 三、执行步骤

**S1 环境与夹具（产出：`/tmp/qiansi-acc.*` 目录树，负责人：验收执行者，无依赖）**
```bash
export STATE_DIR=$(mktemp -d /tmp/qiansi-acc.XXXXXX); echo $STATE_DIR
export PORT=17311; export API=http://127.0.0.1:$PORT
export WS_HEADER='x-workspace-id'   # ⚠ R2
mkdir -p accept
```

**S2 存储层探针（产出：`accept/probe.mjs`，负责人：验收执行者；依赖 S1）**
```js
// accept/probe.mjs  用法: node probe.mjs <cmd> <stateDir> [args...]
// ⚠ R4: 把 import 路径改成实际构建产物
import { WorkspaceStore } from '../dist/workspaces.js';
import { CanvasStore } from '../dist/canvas.js';
const [cmd, dir, ...rest] = process.argv.slice(2);
const w = new WorkspaceStore(dir);
const out = (o) => console.log(JSON.stringify(o));
switch (cmd) {
  case 'init': out({ current: w.current(), items: w.list() }); break;
  case 'create': out(w.create(rest[0])); break;
  case 'rename': out({ ok: w.rename(rest[0], rest[1]) }); break;
  case 'remove': out({ ok: w.remove(rest[0]), current: w.current(), items: w.list() }); break;
  case 'set': out({ ok: w.setCurrent(rest[0]) }); break;
  case 'resolve': out({ id: w.resolve(rest[0]).id }); break;          // 非法入参期望抛错
  case 'digest': {
    const c = new CanvasStore(w.dirOf(w.resolve(rest[0]).id));
    out({ exists: c.exists(), doc: c.read() }); break;
  }
  case 'rmw': { // 读-改-写，用于并发丢更新检测
    const c = new CanvasStore(w.dirOf(w.resolve(rest[0]).id));
    const doc = c.read();
    await new Promise(r => setTimeout(r, 50 + Math.random() * 80));
    doc.nodes = [...(doc.nodes ?? []), { id: `n-${process.pid}-${rest[1]}` }];
    c.write(doc);                       // ⚠ 若实际是 apply(ops)，按实际签名替换
    out({ ok: true, nodes: doc.nodes.length }); break;
  }
}
```

**S3 迁移夹具（产出：4 个中间态目录，负责人：验收执行者；依赖 S1）**
```bash
mk() { d=$(mktemp -d /tmp/qiansi-acc.$1.XXXXXX); echo $d; }
# A: 干净旧版
A=$(mk A); echo '{"nodes":[],"edges":[]}' > $A/canvas.json; echo -n '7' > $A/canvas.revision
# B: 目标已存在且内容不同
B=$(mk B); echo '{"nodes":[{"id":"old"}]}' > $B/canvas.json
            mkdir -p $B/workspaces/main; echo '{"nodes":[{"id":"NEW"}]}' > $B/workspaces/main/canvas.json
# C: 目标相同、revision 未迁移
C=$(mk C); echo '{"nodes":[]}' > $C/canvas.json
            mkdir -p $C/workspaces/main; cp $C/canvas.json $C/workspaces/main/canvas.json
# D: 索引损坏但目录数据完好
D=$(mk D); echo '{ broken' > $D/workspaces.json
            mkdir -p $D/workspaces/main; echo '{"nodes":[{"id":"keep"}]}' > $D/workspaces/main/canvas.json
```

**S4 执行顺序**：S1 → 存储层 CRUD/隔离/迁移/并发（无需起服务）→ 起服务跑 API 与 MCP 用例 → 汇总。
**验收执行者**：1 人，约 0.5 人日。**依赖**：R1–R5 核对完成；服务可启动。

## 四、验收标准

> 每条格式：断言 → 命令 → 预期。标 **FAIL(已知)** 者当前实现预期不通过，用于界定发布门槛。

### A. CRUD（P0）

| ID | 断言 | 命令 | 预期 |
|---|---|---|---|
| C-01 | 首次初始化生成 main 工作区 | `node accept/probe.mjs init $A` | `items=[{id:"main",name:"主画布"}]`，`current="main"`，存在 `$A/workspaces/main/` |
| C-02 | create 生成合规 id 并落盘 | `node accept/probe.mjs create $A '项目A'` | `id` 匹配 `/^ws-[0-9a-z]+-[0-9a-z]{4}$/`；目录已建；`workspaces.json` 含该项 |
| C-03 | 默认名与截断 | `probe.mjs create $A ''`；`probe.mjs create $A "$(printf 'x%.0s' {1..60})"` | 名称分别为 `画布 N`（N=当前数量+1）与长度 40 的截断串；首尾空格被 trim |
| C-04 | rename 生效 | `probe.mjs rename $A <id> '新名'` | 索引中 `name` 变更、`updatedAt` 增大；重启后仍为 `新名` |
| C-05 | rename 非法入参 | `probe.mjs rename $A no-such 'x'`；`probe.mjs rename $A <id> ''` | 返回失败/抛错，索引不变（不得写入空名） |
| C-06 | setCurrent 合法/非法 | `probe.mjs set $A <id>`；`probe.mjs set $A no-such` | 前者 `true` 且**重启后** `current` 仍为该 id；后者 `false`/404，`current` 不变 |
| C-07 | 删除最后一个被拒 | 单工作区状态下 `probe.mjs remove $A main` | `ok:false`，`items.length===1`，目录仍存在 |
| C-08 | 删除当前项后 current 切换 | 建 A、B 后 `probe.mjs remove $A <A>` | 返回新 `current` 为剩余列表第一项；被删项不在 `items`；其目录已清理或打 tombstone |
| C-09 | list 排序稳定 | 建 3 个工作区后 `probe.mjs init $A` | 按 `createdAt` 升序，无重复 id |
| C-10 | 索引原子写 | 反复 `set` 100 次后 `jq . $A/workspaces.json` | JSON 可解析；无残留 `workspaces.json.tmp` |
| C-11 | API 与存储一致 | `curl -s $API/api/workspaces \| jq '.current, (.items\|length)'` | 与 `probe.mjs init` 输出一致；`canvasExists` 与实际目录一致 |

### B. 隔离性（P0）

| ID | 断言 | 命令 | 预期 |
|---|---|---|---|
| I-01 | 两工作区同名节点互不影响 | 对 A、B 各写 `{id:"n1"}`，再分别读取 | A 读到自己的 `n1`，B 的不含 A 的内容（比较 `nodes` 全等） |
| I-02 | 切换后读到新数据 | `set` 到 B → 读画布 | 返回 B 的文档；无 A 内容残留 |
| I-03 | 未知 id 读：允许回落但必须标记 | `curl -s $API/api/canvas -H "$WS_HEADER: no-such"` | 200 且响应含 `workspace_id` + `resolved_by:"fallback"` **FAIL(已知：无标记)** |
| I-04 | 未知 id 写：禁止回落 | `curl -s -o /dev/null -w '%{http_code}' -X POST $API/api/canvas/apply -H "$WS_HEADER: no-such" -d '{"ops":[...]}'` | `400 workspace_required`，且**任一**工作区画布摘要不变 **FAIL(已知)** |
| I-05 | 无 id 写：禁止回落 | 同上，去掉 header | `400 workspace_required` **FAIL(已知)** |
| I-06 | 路径穿越（`../`） | `$WS_HEADER: ../../tmp/pwn`；`canvasFor` 侧构造 `resolve('../../etc/passwd')` | 4xx / 抛错；`/tmp/pwn` 不存在；`$STATE_DIR` 外文件未被读 |
| I-07 | URL 编码穿越 | `$WS_HEADER: %2e%2e%2f%2e%2e%2ftmp%2fpwn` | 同上，拒绝 **FAIL(已知：resolve 会回落)** |
| I-08 | 绝对路径 id | `resolve('/etc')` | 抛错，不得回落当前工作区 **FAIL(已知)** |
| I-09 | 索引注入不生效 | 手改 `workspaces.json` 加 `{"id":"../../x"}` 后启动 | 启动即校验失败或该项被过滤；不创建 `$STATE_DIR/../x` |

### C. 迁移与恢复（P0）

| ID | 断言 | 命令 | 预期 |
|---|---|---|---|
| M-01 | 迁移内容零丢失 | `b=$(sha256sum $A/canvas.json\|cut -d' ' -f1)`；`probe.mjs init $A`；`echo $b; sha256sum $A/workspaces/main/canvas.json` | 两摘要相等；`canvas.revision` 内容 `7` 同样迁至 `main/`；索引 `items[0].name==="主画布"` |
| M-02 | 迁移幂等 | 连续两次 `probe.mjs init $A` | 第二次后 `main/canvas.json` 摘要不变；`items.length===1`；无重复里程碑日志 |
| M-03 | 目标已存在且不同 → 冲突停手 | `probe.mjs init $B` | 明确报冲突（非静默）；`$B/canvas.json` **仍存在**且摘要未变；`main/canvas.json` 保持原内容 **FAIL(已知：走 rmSync 删源)** |
| M-04 | 目标相同、附属文件缺失 | `probe.mjs init $C` | `main/canvas.revision` 被迁移，或明确报「迁移未完成」；不得在 revision 缺失时标记 completed **FAIL(已知)** |
| M-05 | 索引损坏不得毁数据 | `probe.mjs init $D` | `main/canvas.json` 摘要不变（`keep` 仍在）；索引重建为 `id=main`；不得命名为「空白画布」造成误导 **FAIL(已知：命名)** |
| M-06 | 不得误判完成 | 构造「索引存在但 `workspaces/main/` 缺 canvas」的目录后 `init` | 明确报错或进入恢复流程；不得静默当作已迁移 **FAIL(已知)** |
| M-07 | 写索引失败保留旧索引 | `chmod 500 $D` 后 `probe.mjs create $D x`；`chmod 700 $D` | 抛错；`workspaces.json` 原内容未被空索引覆盖；临时文件被清理 |
| M-08 | 迁移失败保留源 | 令目标目录只读后 `init $A2`（含旧文件） | `$A2/canvas.json` 仍在原路径；错误可读、可重试 |

### D. 并发与冲突（P0）

| ID | 断言 | 命令 | 预期 |
|---|---|---|---|
| P-01 | 同工作区并发不丢更新 | `for i in $(seq 1 20); do node accept/probe.mjs rmw $A <ws> $i & done; wait`；再读 `nodes` 数量 | 成功写入数 = 节点数（20），或冲突者返回 `409 workspace_conflict` 且计数守恒 **FAIL(已知：无锁无版本)** |
| P-02 | 用户编辑 vs 运行回写 | 模拟：一进程 `rmw` 持续写入，同时触发一次运行产物回写 | 用户节点全部保留，产物以补丁合入（节点数 = 用户数 + 产物数，无覆盖） **FAIL(已知)** |
| P-03 | 锁可跨进程且可恢复 | 进程 X 持锁 `kill -9`；通知进程 Y 写入 | Y 在超时后获得锁或返回明确「陈旧锁」错误，并提供解锁手段（`--force-unlock` 或删除 `canvas.json.lock` 文档化） **FAIL(已知：无锁文件)** |
| P-04 | 索引并发不损坏 | 两进程各 `set` 100 次（不同目标） | 结束后 `jq .` 可解析、id 无重复、`current` 为其中之一 |
| P-05 | 删除 vs 回写 | 删除工作区同时让迟到任务回写 | 写前校验返回 `409 workspace_busy` 或不复活目录 **FAIL(已知)** |

### E. MCP 默认值（P0）

| ID | 断言 | 命令 | 预期 |
|---|---|---|---|
| MCP-01 | 写工具无参必须报错 | 调 `create/delete/apply/run/write_artifacts` 不带 workspace | `400 workspace_required`（或等价 JSON-RPC error），**不写入**任何画布 **FAIL(已知)** |
| MCP-02 | 读工具可无参但必须回报解析 | 调读工具不带 workspace | 200，响应含 `workspace_id` 与 `resolved_by:"fallback"` **FAIL(已知：无字段)** |
| MCP-03 | 显式非法 id 拒绝 | `workspace_id:"../tmp/x"` / `"no-such"` | 4xx，不回落 **FAIL(已知)** |
| MCP-04 | 会话绑定与切换确认 | 会话内切工作区后发写调用 | 要求重新确认或报错；日志含 `workspace_id`、`resolved_by` **FAIL(已知)** |
| MCP-05 | 与 HTTP 路径一致 | 同一显式 workspace 下 MCP 与 HTTP 写入同一节点 id | 落盘到同一目录（摘要互见），不回落到 `current` |

### F. 范围外但发布阻断（引用 C1，本轮不执行用例）

handoff 固定写当前工作区、VS Code 深链无法指定工作区、SSE 未按 `workspaceId` 过滤与重放、运行上下文 `workspaceId` 不可变性。四项须在发布评审前补齐用例，判定标准见 C1 清单。

### 最终判定

- **P0 通过** = A/C/D/E 全部 + B 的 I-01/I-02/I-06/I-07/I-08/I-09 通过。
- 当前基线预期：C 组 9/11 通过（C-05 需确认）、I 组 4/9、D 组 1/5、E 组 0/5。
- 结论口径：**通过项可声明「目录隔离已落地」；未通过项不得声明「多工作区已完整落地」**。