/**
 * 当前工作区：一张画布 = 一个会话/项目。
 *
 * 存在 localStorage 里，并且由 api-auth 的 fetch 垫片统一附加到请求头——
 * 这样 App 里几十处 fetch 不需要逐个改。切换工作区直接整页重载：
 * 画布、运行进度、SSE 订阅、自动保存全都跟着一起换，不存在半新半旧的状态。
 */

const KEY = 'qiansi.workspace';

export function currentWorkspace(): string {
  try {
    return window.localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function setCurrentWorkspace(id: string): void {
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  } catch {
    // 隐私模式下写不了 localStorage：本次会话仍用内存值
  }
  memory = id;
}

let memory = '';

export function workspaceHeader(): string {
  return memory || currentWorkspace();
}

/** 切换并整页重载：确保没有跨工作区的残留状态。 */
export function switchWorkspace(id: string): void {
  setCurrentWorkspace(id);
  // 服务端也有「当前画布」，脚本/MCP/无头请求都以它兜底；不通知的话，
  // 关标签、新开窗口、无工作区头的请求都会落回旧画布。
  void fetch(`/api/workspaces/${encodeURIComponent(id)}/activate`, { method: 'POST' }).catch(() => undefined);
  window.location.reload();
}
