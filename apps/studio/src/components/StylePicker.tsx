import { useMemo } from 'react';

import { CONVERSATION_STYLES, suggestStyle, styleById } from '@qiansi/engine';

/**
 * 风格选择器。
 *
 * 画布节点的风格过去是「按名称猜」，猜完就定了，界面上既看不见也改不了。
 * 这里给出三件事：当前生效的是哪一种、它是自动推断还是手动指定、以及一键改回自动。
 */
export function StylePicker({
  value,
  hint,
  onChange,
  disabled,
}: {
  /** 显式设置的风格；undefined 表示自动推断。 */
  value?: string;
  /** 推断用的文本（节点名 + 角色）。 */
  hint?: string;
  onChange: (style: string | undefined) => void;
  disabled?: boolean;
}) {
  const suggested = useMemo(() => suggestStyle(hint ?? ''), [hint]);
  const suggestedLabel = styleById(suggested).label;
  const explicit = typeof value === 'string' && value.length > 0;
  const effective = explicit ? styleById(value) : styleById(suggested);

  return (
    <div className="style-picker">
      <select
        className="inspector-input"
        value={explicit ? String(value) : 'auto'}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === 'auto' ? undefined : next);
        }}
      >
        <option value="auto">自动 · 按名称推断（当前：{suggestedLabel}）</option>
        {CONVERSATION_STYLES.map((style) => (
          <option key={style.id} value={style.id}>
            {style.label} · {style.scenario}
          </option>
        ))}
      </select>
      <div className="inspector-meta">
        {explicit
          ? `已手动指定「${effective.label}」，运行编排与讨论都按这个风格走。`
          : `未指定：按名称/角色推断为「${suggestedLabel}」；推断依据是关键词，可以手动改。`}
      </div>
      {explicit && (
        <button className="mini-btn style-reset" onClick={() => onChange(undefined)} disabled={disabled}>
          改回自动推断
        </button>
      )}
    </div>
  );
}
