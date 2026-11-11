/**
 * 「自动编排」的接管判定：对主控发消息时，这条消息是触发一次完整编排，
 * 还是被降级成普通对话。
 *
 * 抽成纯函数是因为这条路径之前出现过「静默降级」——运行中发消息悄悄变成
 * 单节点聊天，用户以为接管失效。判定逻辑集中在这里，才有得测。
 */

export type TakeoverDecision =
  | { action: 'run' }
  | { action: 'chat-downgraded'; reason: 'run_in_progress' }
  | { action: 'chat' };

export function decideTakeover(input: {
  autoOrchestrate: boolean;
  isOrchestrator: boolean;
  running: boolean;
}): TakeoverDecision {
  if (!input.autoOrchestrate || !input.isOrchestrator) return { action: 'chat' };
  if (input.running) return { action: 'chat-downgraded', reason: 'run_in_progress' };
  return { action: 'run' };
}
