结论：把卡片从“居中压线的小方块”改成“沿连线法线方向偏移的产物卡”，用左侧状态条 + 状态图标 + 任务 ID + 摘要 + 状态徽标表达层级；从卡片边缘伸出一条短引导线，末端加连接点锚定在连线路径上，达到不压线、有美术效果。

## 1. 信息层级

DOM 建议：

```tsx
<button
  className={`artifact-card artifact-card--${tone}`}
  style={{
    position: 'absolute',
    transform: `translate(-50%, -50%) translate(var(--dx), var(--dy))`,
    pointerEvents: 'all',
  }}
  aria-label={`打开 ${artifact.taskId} 的产物与验收结果`}
  onClick={(event) => {
    event.stopPropagation();
    data?.onOpen?.(artifact.taskId);
  }}
>
  <span className="artifact-card__tether" aria-hidden="true" />
  <span className="artifact-card__icon" aria-hidden="true">{iconGlyph}</span>
  <span className="artifact-card__body">
    <span className="artifact-card__top">
      <span className="artifact-card__id">{artifact.taskId}</span>
      <span className="artifact-card__badge">{badgeText}</span>
    </span>
    <span className="artifact-card__summary">
      {artifact.output.replace(/\s+/g, ' ').slice(0, 42)}
    </span>
  </span>
</button>
```

优先级：  
状态图标 > 任务 ID > 验收徽标 > 产物摘要。  

关键字号与截断：  
- 任务 ID：11px，等宽/小号大写，颜色 `#c7d2df`。  
- 摘要：12px，最多 2 行，超出 `ellipsis`/`line-clamp: 2`。  
- 徽标：10px，胶囊形。  
- 整卡宽 220px，内边距 `8px 10px`，圆角 `10px`。  
- 不展示完整 output，完整内容放点击后打开的面板/抽屉。

## 2. 状态表达

三种状态不要只用颜色区分，必须“颜色 + 图标 + 文字”三重表达。

| 状态 | tone class | 颜色 | 图标 | 徽标文案 |
|---|---|---|---|---|
| pass | `artifact-card--ok` | `#4ade80` | ✓ | 通过 |
| needsHuman | `artifact-card--warn` | `#e0a458` | ⚠ | 需人工 |
| 其他/fail | `artifact-card--fail` | `#f87171` | ✕ | 未通过 |

卡片左侧 3px 状态条，用 `::before` 实现：

```css
.artifact-card {
  --tone: #6ea8fe;
  --tone-soft: rgba(110, 168, 254, 0.18);
}

.artifact-card--ok { --tone: #4ade80; --tone-soft: rgba(74, 222, 128, 0.16); }
.artifact-card--warn { --tone: #e0a458; --tone-soft: rgba(224, 164, 88, 0.16); }
.artifact-card--fail { --tone: #f87171; --tone-soft: rgba(248, 113, 113, 0.16); }

.artifact-card::before {
  content: "";
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--tone);
}
```

状态图标：18px 圆形底，背景 `var(--tone-soft)`，文字色 `var(--tone)`。  
徽标：背景 `var(--tone-soft)`，文字色 `var(--tone)`，胶囊形。  
连接点与引导线也使用同一个 `--tone`，状态一致。

## 3. 从连线偏移出去的呈现方式

不再让卡片中心固定在 `labelX/labelY`。偏移由布局工程师给出 `--dx`、`--dy`，交互层约定：

- 卡片主体与连线中轴净距至少 **6px**。
- 默认优先向连线上方偏移；若上方与节点/其他卡冲突，再翻转到下方、左侧或右侧。
- 引导线长度建议 **8–12px**，短边场景不超过 24px，避免卡片像浮在空中。
- 连接点直径 **5px**，始终落在连线路径上。

向上偏移时，引导线从卡片底部中央伸出：

```css
.artifact-card {
  position: absolute;
  transform: translate(-50%, -50%) translate(var(--dx), var(--dy));
  display: flex;
  gap: 8px;
  align-items: flex-start;
  width: 220px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: linear-gradient(180deg, #111821 0%, #0b1622 100%);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  color: #c7d2df;
  cursor: pointer;
  text-align: left;
  /* 关键：不能裁剪引导线 */
  overflow: visible;
}

.artifact-card__tether {
  position: absolute;
  left: 50%;
  bottom: -10px;
  width: 1px;
  height: 10px;
  background: var(--tone);
  transform: translateX(-50%);
}

.artifact-card__tether::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -3px;
  width: 5px;
  height: 5px;
  transform: translateX(-50%);
  border-radius: 50%;
  background: var(--tone);
  box-shadow: 0 0 0 3px var(--tone-soft);
}
```

不同偏移方向建议给根元素增加方向类，由布局工程师切换：

- `.artifact-card--tether-up`：引导线在卡片底部，指向下方连线。  
- `.artifact-card--tether-down`：引导线在卡片顶部。  
- `.artifact-card--tether-left` / `.artifact-card--tether-right`：引导线在卡片侧边。

连接点始终落在连线路径上；具体几何计算归布局工程师。交互层只约束视觉规格。

## 4. hover / active / focus / 点击反馈

```css
.artifact-card:hover {
  border-color: var(--tone);
  background: linear-gradient(180deg, #131d28 0%, #0d1923 100%);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45), 0 0 0 1px var(--tone-soft);
  color: #ffffff;
}

.artifact-card:hover .artifact-card__tether::after {
  box-shadow: 0 0 0 4px var(--tone-soft);
}

.artifact-card:active {
  transform: translate(-50%, -50%) translate(var(--dx), var(--dy)) scale(0.98);
}

.artifact-card:focus-visible {
  outline: 2px solid #6ea8fe;
  outline-offset: 2px;
}
```

反馈要点：  
- hover 时边框转状态色，背景轻微提亮，连接点外圈放大。  
- active 时卡片轻微缩放，模拟按压。  
- focus-visible 使用强调色 `#6ea8fe` 的 2px outline，保证键盘可达。  
- 点击仍是原生 `<button>` 行为，`stopPropagation` 后打开产物与验收详情。  
- 保留 `title` 作为补充，但要同时加 `aria-label`，不能把 `title` 当唯一可访问提示。

## 5. 不要做什么

- 不要把卡片中心继续钉在 `labelX/labelY` 上，这是压线的根因。  
- 不要给卡片加 `overflow: hidden`，否则会裁掉引导线和连接点。  
- 不要在卡片上放多个可点击子元素；整卡一个点击目标。  
- 不要只用红绿边框或圆点表达状态，必须同时有图标和文字徽标。  
- 不要让引导线超过 24px；短边、密集图里长引导线会形成视觉噪点。  
- 不引入新依赖，仍只用 React + CSS。