import type { ToolCapability } from '@qiansi/engine';

export type ConnectionStatus = 'untested' | 'testing' | 'ok' | 'fail';

export interface ModelDraft {
  id: string;
  label: string;
  provider: string;
  protocol: 'openai-chat' | 'anthropic-messages';
  baseUrl: string;
  model: string;
  /** Every model this key can call — one key serves a family, not one model. */
  models?: string[];
  apiKey: string;
  status: ConnectionStatus;
  latencyMs?: number;
  tools: ToolCapability[];
  approval: 'always' | 'per-run' | 'auto';
  note?: string;
}

export function catalogOf(model: ModelDraft): string[] {
  const list = (model.models ?? []).map((item) => item.trim()).filter(Boolean);
  const primary = model.model.trim();
  if (primary && !list.includes(primary)) list.unshift(primary);
  return list.length ? list : primary ? [primary] : [];
}

/**
 * Cheap/fast tier beats the flagship for worker nodes: most subtasks are short
 * and get re-run on failure, so latency and price matter more than the last few
 * benchmark points. Mirrors the server's preferredModel().
 */
const CHEAP_HINTS = ['flash', 'air', 'turbo', 'lite', 'highspeed'];

export function preferredModel(models: string[]): string {
  if (!models.length) return '';
  const scored = models.map((model) => {
    const lower = model.toLowerCase();
    const cheap = CHEAP_HINTS.some((hint) => lower.includes(hint)) ? 0 : 1;
    const version = lower
      .match(/(\d+(?:\.\d+)*)/)?.[1]
      ?.split('.')
      .map((part) => Number(part))
      .reduce((acc, part, index) => acc + part * 10 ** (2 - index), 0) ?? 0;
    return { model, cheap, version };
  });
  scored.sort((a, b) => a.cheap - b.cheap || b.version - a.version);
  return scored[0]!.model;
}

/**
 * cc-switch style onboarding: pick a provider preset, paste the key, and the
 * official model catalog is fetched from the provider itself.
 */
export interface ProviderPreset {
  key: string;
  label: string;
  provider: string;
  protocol: 'openai-chat' | 'anthropic-messages';
  baseUrl: string;
  keyHint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    provider: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    keyHint: 'sk-…',
  },
  {
    key: 'moonshot',
    label: 'Kimi / Moonshot',
    provider: 'Moonshot',
    protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyHint: 'sk-…',
  },
  {
    key: 'minimax',
    label: 'MiniMax',
    provider: 'MiniMax',
    protocol: 'openai-chat',
    baseUrl: 'https://api.minimaxi.com/v1',
    keyHint: 'eyJ…',
  },
  {
    key: 'zhipu',
    label: '智谱 GLM',
    provider: 'Zhipu',
    protocol: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyHint: '….',
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    provider: 'OpenRouter',
    protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-…',
  },
  {
    key: 'qwen',
    label: '通义千问',
    provider: 'Qwen',
    protocol: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyHint: 'sk-…',
  },
  {
    key: 'siliconflow',
    label: '硅基流动',
    provider: 'SiliconFlow',
    protocol: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyHint: 'sk-…',
  },
  {
    key: 'ark',
    label: '火山方舟',
    provider: 'Volcengine Ark',
    protocol: 'openai-chat',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyHint: '…',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    provider: 'OpenAI',
    protocol: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-…',
  },
  {
    key: 'groq',
    label: 'Groq',
    provider: 'Groq',
    protocol: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyHint: 'gsk_…',
  },
  {
    key: 'anthropic',
    label: 'Anthropic',
    provider: 'Anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
    keyHint: 'sk-ant-…',
  },
  {
    key: 'custom',
    label: '自定义',
    provider: 'Custom',
    protocol: 'openai-chat',
    baseUrl: '',
  },
];

export const initialModels: ModelDraft[] = [
  {
    id: 'conn-claude-relay',
    label: '主控 Claude（本地中转）',
    provider: 'Anthropic via relay',
    protocol: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1:15721',
    model: 'claude-opus-4-8[1M]',
    models: ['claude-opus-4-8[1M]', 'claude-sonnet-4-6[1M]', 'claude-haiku-4-5'],
    apiKey: '',
    status: 'untested',
    tools: ['fs.read'],
    approval: 'always',
    note: '密钥已由本机中转管理；此处留空也可连通。一把 key 可调用目录里的全部模型。',
  },
  {
    id: 'conn-deepseek',
    label: 'DeepSeek Reasoner',
    provider: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-reasoner',
    models: ['deepseek-reasoner', 'deepseek-chat'],
    apiKey: '',
    status: 'untested',
    tools: ['fs.read', 'network'],
    approval: 'always',
  },
  {
    id: 'conn-minimax',
    label: 'MiniMax M3.1',
    provider: 'MiniMax',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    model: 'MiniMax-M3.1-Flash-Preview',
    models: ['MiniMax-M3.1-Flash-Preview', 'MiniMax-M3.1-Flash'],
    apiKey: '',
    status: 'untested',
    tools: ['fs.read'],
    approval: 'always',
    note: '国内 Key 只能配 api.minimaxi.com；国际 Key 不通用。',
  },
  {
    id: 'conn-kimi',
    label: 'Kimi K2 Thinking',
    provider: 'Moonshot',
    protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-thinking',
    models: ['kimi-k2-thinking'],
    apiKey: '',
    status: 'untested',
    tools: ['fs.read'],
    approval: 'always',
  },
];

export const toolLabels: Record<ToolCapability, { label: string; risky?: boolean; hint: string }> = {
  'fs.read': { label: '读取文件', hint: '仅限工作区根目录内' },
  'fs.write': { label: '写入文件', hint: '仅限工作区根目录内，写前备份' },
  shell: { label: '执行命令', risky: true, hint: '需 WSL2/Docker 沙箱与命令白名单' },
  browser: { label: '浏览器', hint: '打开页面、抓取内容；禁止自动提交表单' },
  screen: { label: '屏幕控制', risky: true, hint: 'V2 能力；需沙箱、可见录制与急停' },
  network: { label: '网络访问', hint: '仅限连接配置里的域名白名单' },
};
