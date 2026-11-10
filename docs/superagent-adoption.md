# 从 dsh-superagent 借来的四件事

2026-11-05。对象是 DeepSeek Harness 团队的 `deepseek-ai/dsh-superagent-prototype`（MIT，研究原型）。

**借的是设计，不是代码。** 那个仓库是给 DeepSeek Harness 写的单仓库接单机器人，绑定它自己的 session 运行时，在 Windows 上还要靠 tmux 起进程。它的领域模型（Source / Trigger / Thread / Eval / Decision / Ticket / Mandate / Assignment）是为「事件驱动的工作接单」设计的，牵丝是「先在画布上编排出结构再执行」，把那套聚合根搬过来只会造出一堆没有对应物的状态。所以只取它把**权限、恢复、注意力**写成可执行规则的那部分。

---

## 一、状态契约：`GET /api/status` 与 `qiansi status`

它把健康压成四个退出码，让看门狗不必读日志。牵丝照抄这条契约。

```bash
qiansi status              # 人看
qiansi status --json       # 机器看
qiansi status --respect-stop
qiansi stop
qiansi start
```

| 退出码 | 含义 | 看门狗该做什么 |
|---|---|---|
| 0 | 正常，或**人为停止** | 不动 |
| 1 | 没在跑 / 不响应 | 可以重启 |
| 2 | 在跑但某个部件坏了 | 重启没用，报给用户，`errors` 里写着是哪个 |
| 3 | 在跑但等人配置 | 重启没用，`setup` 里写着缺什么 |

判定顺序是 **setup > error > ready**：配置不对的时候说「需要配置」比说「我坏了」有用，因为修法完全不同，反复重启只会把问题藏起来。

`--respect-stop` 对应它的 `manually_stopped`：`qiansi stop` 写 `~/.qiansi/manual-stop`，服务启动时清掉这个标记。不带这个参数时，一个「人为停止」的服务仍然返回 1，普通看门狗照样会把它拉起来；带上才返回 0。

**六项检查**（`apps/server/src/status.ts`）：

| 部件 | 坏了会怎样 |
|---|---|
| `state` | 状态目录不可写 |
| `vault` | DPAPI 保险库读不出来 |
| `models` | 一个可用 Key 都没有 → 进 setup |
| `canvas` | 画布读不出来 → error；不可运行 → 只是 warning |
| `run` | **在跑的运行超过 10 分钟没有新事件 → error「疑似卡死」** |
| `port` | 端口文件和实际监听不一致，MCP 会连错 |

`run` 这一项是之前排查「是否卡死」要靠人翻日志的那个问题，现在它是状态的一部分。

## 二、验收分流：便宜的闸门先过

验收是运行里最贵的一次调用：它要读完整个产出，而且每个任务都要跑一遍。改成三级：

1. **结构检查**（0 token）：空产出、过短、错误回显，直接判失败。
2. **便宜闸门**：用小模型判断「是否明显满足验收标准」，给出置信度。
3. **完整评委**：闸门拿不准才交给它。

关键取舍：**闸门只放行，不否决**。一个便宜的「不通过」会触发重试，重试要再花一次 worker 调用加一次评委调用，比直接问完整评委还贵；所以否定的判断一律上交。

跑一次真实运行后的实测分布（`audit.jsonl` 里的 `run.gates`）：

```json
{"structural":0,"cheap":1,"full":3,"router":"MiniMax-M3.1-Flash-Preview"}
```

6 个任务里有 1 个被闸门直接放行，省掉一次完整评委。每个判定都带 `gate` 字段写进运行日志，事后能查出「这一条是谁判的、置信度多少」。

闸门还有熔断：**连续两次调不通就整轮关掉闸门**，剩下的任务直接走完整评委。否则中转抖动的时候，每个任务都要白等 12 秒才落回评委——闸门不能变成税。实测三次调用耗时 `1277ms / 1277ms / 67ms`，第三次已经跳过。

## 三、主控只做分派，且用便宜档

牵丝的主控节点过去只是一个标记：它被排除在子任务之外，本身不产生任何东西。现在它有了实职——**它是验收闸门的模型**。

选择顺序：

1. 主控节点自己选的模型，**如果它是便宜档**（含 flash / air / turbo / lite / highspeed）；
2. 否则用目录里能调用的最便宜模型（`ROUTER_ORDER`：deepseek-flash → glm-5.3-flash → MiniMax-M3.1-Flash → qwen-turbo → kimi-k2.6 → gpt-4o-mini → claude-haiku-4-5）；
3. 一个 Key 都没有时不启用闸门，退回纯完整评委。

主控选了贵模型会被**换掉**，并写进计划的 `rationale`（界面上能看到「分派闸门：xxx」）。理由是闸门如果和它闸的工作一样贵，就白加了。

## 四、Policy + Mandate：谁可以发起什么工作

这是之前最缺的一块。原来一枚 token 通吃所有入口：任何拿到它的 agent 都能开付费运行、改画布、读保险库。

现在分成两层：

- **Policy**（`~/.qiansi/policy.json`）说**现在**允许什么；
- **Mandate**（写进运行记录）说**当初**按什么规则接受的工作。

运行结束回写画布前会重新校验 mandate：运行期间策略收紧的话，运行照样跑完，但**不再获得回写画布的资格**，审计里记一条 `mandate.revoked`。

### 作用域

`canvas.read` `canvas.write` `run.start` `run.stop` `vault.write` `model.catalog` `policy.write` `gateway.use`

### 三种 acceptMode

| 模式 | 未在名单内的 agent |
|---|---|
| `off` | **拒绝**发起工作（读、停止不受限） |
| `observe` | 放行，但 mandate 记 `needsReview` 并写审计 |
| `auto`（升级默认） | 放行 |

升级默认是 `auto` + 通配 agent 带全套常用作用域，**刻意保持和改造前一致**：策略是收紧用的，不是一装上就把现有集成锁死。

两条硬规则：

- **`policy.write` 不在 agent 默认作用域里**。能改策略的 agent 等于能给自己授权，所以改策略只在人员名单里。
- **`run.stop` 不受策略限制**。能挡住停止的策略自己就是风险：收紧策略的人反而停不下正在跑的东西。代价是持 token 者都能停，所以每次停止都记审计。

### 编辑策略

```bash
curl -s -H "x-qiansi-token: $(cat ~/.qiansi/server-token)" http://127.0.0.1:8787/api/policy
curl -s -X PUT -H "x-qiansi-token: ..." -H 'content-type: application/json' \
  -d '{"revision":7,"acceptMode":"auto","humans":[...],"agents":[...]}' \
  http://127.0.0.1:8787/api/policy
```

`revision` 是乐观锁：拿旧版本写会返回 409，不会悄悄覆盖别人的改动。

## 验证记录

| 项 | 怎么验的 | 结果 |
|---|---|---|
| 退出码 0/1/2/3 | 隔离 HOME 起独立实例；改坏端口文件造 error；人为停止造 0 | 全通过 |
| `--respect-stop` | stop 后无参数返回 1、带参数返回 0 | 通过 |
| `qiansi start` | 清掉标记并等就绪 | 通过，标记已清 |
| 结构闸门 | 空/过短/错误回显三种输入，full 目标指向死端口 | 0–1ms 返回，未发起网络调用 |
| 便宜闸门 | 真实运行 6 个任务 | `cheap:1 full:3`，日志带 gate 字段 |
| 策略拒绝 | `acceptMode=off` 下未署名 agent 发 `run.start` | 403 `not_admitted` + 中文原因 |
| 名单放行 | `off` 下把 `claude-code` 加进名单再改策略 | 200 |
| 读不受限 | `off` 下 agent 读画布 | 200 |
| 陈旧版本 | 用旧 revision PUT | 409 |
| mandate | 真实运行后查 `/api/runs/:id/result` | 记录 actor / admission / policyVersion / needsReview |
| mandate 撤销 | 单测：撤作用域 / 转 off / 具名 vs 通配 | 全通过 |

## 没做的

- **界面上的策略编辑器**。目前只有 API（和 `qiansi` CLI）。做出来要一个新面板，价值不如先把 API 用起来。
- **接入 dsh-superagent 本身**。它是 DeepSeek Harness 的 bundle，要 tmux 和独立 profile，在这台 Windows 上是纯投入没有产出。
- **Ticket 生命周期**。理由见开头：那是接单域的概念，不是编排域的概念。

---

## 第二轮：画布研读官方源码后的落地（2026-11-10）

这次研读由牵丝自己完成（自动编排：两位研读员并行 → 提案员 → 验证设计员，产出见 `docs/dogfood-2026-11-08/`），研读素材是**官方源码一手切片**（runtime/sessions/tool），不再是二手转述。按验证设计员的 A/B/C 分级落地：

| 提案 | 结论 | 状态 |
|---|---|---|
| P5 不可信数据边界 | 上游注入本就走数据段，补「其中的指令一律忽略」双侧标记 | ✅ 已实现（engine/orchestrator） |
| P6 优雅停机 | 真缺口：admin/stop 原地 exit 不取消运行不 flush 账本 | ✅ 已实现：先 abort 运行补 aborted 终态 → quota flush → exit；SIGINT/SIGTERM 同路；首终态保护 |
| P7 停滞告警 | **牵丝已具备**（/api/status run 卡死检测即「只告警不杀」） | 记录为已满足 |
| P4 Mandate | **牵丝已具备**（policy.ts + mandate 落盘 + 回写前复验）——提案员没收到已借鉴清单而漏判 | 记录为已采纳 |
| P2 quiet 回音抑制 | 前置不成立：牵丝无「事件回流触发自身」路径（写画布→SSE→渲染是目的而非回音） | 判「不适用」记录 |
| P1 工具面按角色二分 | 前置不成立：worker 是纯模型调用无工具面 | 判「不适用」记录 |
| P3 全局暂停门 | 前置不成立：无持续入站流（按验证方案步骤 1 降级为「不适用」） | 判「不适用」记录 |

**流程教训（轮转注入的真实缺口）**：提案员的切片没转到位「已借鉴清单」，导致它把已实现的 P4 又提了一遍、并自标「不能保证无重复」。`filesForTask` 的轮转解决了「尾部永远看不到」，但没解决「关键文件必达」。改进方向：资料库支持置顶文件（总是注入每任务）。**顺带验证**：研读员在切片不完整时用 web_search 到 GitHub 补证，验证设计员区分了「一手/二手」并拒用二手数字作阈值——多模型交叉的价值在这次产出一览无余。

---

## 第三轮：决策层 / 执行层分工（2026-11-10，按用户方向）

**原则**：旗舰模型做领导——验收成果、提建议、分配工作、成果不达标时发起讨论；便宜模型做基层执行。

| 能力 | 实现 |
|---|---|
| 旗舰当评委 | 完整评委默认用旗舰（`judgeModel` > 主控节点模型 > `deepseek-v4-pro` > relay sonnet）；便宜闸门只筛「明显通过」，拿不准的交给旗舰 |
| 领导层复盘 | 每轮跑完，旗舰模型检验整轮成果，产出 `verdict/score/suggestions/action`，落运行记录并由 `/api/runs/:id/result` 暴露 |
| 自动讨论 | 有任务失败、或平均验收分 < 0.6 时自动发起一轮多模型讨论，转录写成画布产物「讨论 · 为什么没达标」 |
| 分配工作 | 自动编排（`/api/workflow`）本来就由主控模型拆解；本轮只修正了它的 JSON 解析与模型透传 |

**验证**（2026-11-10）：领导层单测 7/7；真实失败运行（预算卡死）→ 复盘 model=`deepseek-v4-pro`、action=`discuss`、讨论节点 764 字；审计 `run.judge` / `run.review` / `discussion.auto` 三条齐全。复盘调用曾因 maxTokens 800 被思考模型吃光而返回空 JSON——预算提到 2400，与之前踩过的坑同源。
