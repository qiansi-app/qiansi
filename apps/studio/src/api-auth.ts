/**
 * Header-based auth for embedded webviews.
 *
 * The VS Code panel renders this page inside an iframe whose top-level document
 * is vscode-webview://… . That makes every request to http://127.0.0.1:<port>
 * cross-site, and a SameSite=Strict session cookie is never sent in that
 * context — every /api call came back 401 and the studio fell back to the demo
 * graph, which users read as "the canvas shows an old board".
 *
 * /api/bootstrap hands the token to the page itself; we attach it as a header
 * on every same-origin /api and /v1 request. Header auth has no SameSite rules,
 * so the embedded panel behaves exactly like the Electron app or a browser tab.
 */
export function installApiAuth(): void {
  const rawFetch = window.fetch.bind(window);

  const tokenReady: Promise<string> = rawFetch('/api/bootstrap')
    .then((response) => response.json())
    .then((data: { token?: unknown }) => (typeof data?.token === 'string' ? data.token : ''))
    .catch(() => '');

  let token = '';

  const isLocalApi = (url: string): boolean =>
    url.startsWith('/api/') ||
    url.startsWith('/v1/') ||
    url.startsWith(`${location.origin}/api/`) ||
    url.startsWith(`${location.origin}/v1/`);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (isLocalApi(url) && !url.includes('/api/bootstrap')) {
      if (!token) token = await tokenReady;
      if (token) {
        const headers = new Headers(init?.headers);
        if (!headers.has('x-qiansi-token')) headers.set('x-qiansi-token', token);
        init = { ...(init ?? {}), headers };
      }
    }
    return rawFetch(input, init);
  }) as typeof window.fetch;
}
