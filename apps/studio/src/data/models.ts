import type { ToolCapability } from '@qiansi/engine';

export type ConnectionStatus = 'untested' | 'testing' | 'ok' | 'fail';

export interface ModelDraft {
  id: string;
  label: string;
  provider: string;
  protocol: 'openai-chat' | 'anthropic-messages';
  baseUrl: string;
  model: string;
  apiKey: string;
  status: ConnectionStatus;
  latencyMs?: number;
  tools: ToolCapability[];
  approval: 'always' | 'per-run' | 'auto';
  note?: string;
}

export const initialModels: ModelDraft[] = [
  {
    id: 'conn-claude-relay',
    label: '主控 Claude（本地中转）',
    provider: 'Anthropic via relay',
    protocol: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1:15721',
    model: 'claude-opus-4-8[1M]',
    apiKey: '',
    status: 'untested',
    tools: ['fs.read'],
    approval: 'always',
    note: '密钥已由本机中转管理；此处留空也可连通。',
  },
  {
    id: 'conn-deepseek',
    label: 'DeepSeek Reasoner',
    provider: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-reasoner',
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
