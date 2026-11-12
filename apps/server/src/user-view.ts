import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ensureStateDir } from './state-dir.js';

/**
 * 用户视角验收：像用户一样把项目真的跑起来，用无头浏览器打开页面，截桌面
 * 和手机两张图，检查「看得到东西 / 没有脚本报错 / 图片都加载了 / 按钮点得到 /
 * 手机上没横向溢出」。
 *
 * 参考 Grok Bot 的验证原则：先把应用跑起来再说话；用机器可读的信号判定，
 * 证明留给截图，而不是让模型「觉得没问题」。
 *
 * 只启动工作目录里的 dev/start/preview 脚本或静态目录，结束后杀掉整棵进程树；
 * 不碰用户已经在跑的服务（用随机端口）。
 */

export type ProjectKind = 'vite' | 'next' | 'node' | 'static' | 'electron' | 'unknown';

export interface ProjectProbe {
  kind: ProjectKind;
  runnable: boolean;
  reason?: string;
  /** npm run 的脚本名；静态项目没有。 */
  script?: 'dev' | 'start' | 'preview';
  /** 静态项目的入口文件。 */
  entryHtml?: string;
  entry: string;
}

export interface UserViewCheck {
  name: string;
  label: string;
  ok: boolean;
  /** 软检查：写在报告里，但不否定整次验收（例如按钮点了没反应）。 */
  soft?: boolean;
  detail?: string;
}

export interface UserViewShot {
  label: 'desktop' | 'mobile';
  file: string;
  bytes: number;
  width: number;
  height: number;
}

export interface UserViewReport {
  ok: boolean;
  id: string;
  at: number;
  workspaceId: string | null;
  runId: string | null;
  rootDir: string;
  kind: ProjectKind;
  entry: string;
  url: string;
  durationMs: number;
  verdict: 'pass' | 'fail' | 'blocked';
  summary: string;
  checks: UserViewCheck[];
  shots: UserViewShot[];
  /** 页面上用户能看到的文字（前 1200 字），供人和模型复核。 */
  pageText: string;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function detectProject(rootDir: string): ProjectProbe {
  const pkgPath = join(rootDir, 'package.json');
  if (existsSync(pkgPath)) {
    let pkg: Record<string, any> = {};
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, any>;
    } catch {
      return { kind: 'unknown', runnable: false, reason: 'package.json 解析失败。', entry: pkgPath };
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, string>;
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    if (typeof scripts.dev === 'string') {
      if (deps.vite) return { kind: 'vite', runnable: true, script: 'dev', entry: 'scripts.dev' };
      if (deps.next) return { kind: 'next', runnable: true, script: 'dev', entry: 'scripts.dev' };
      // Electron 主进程脚本不是网址；有 web 脚本时优先 web。
      if (deps.electron && !deps.vite && !deps.react) {
        return {
          kind: 'electron',
          runnable: false,
          reason: 'Electron 应用需要真实桌面窗口，自动验收只覆盖网页构建；请在桌面端手动打开验收。',
          entry: 'scripts.dev',
        };
      }
      return { kind: 'node', runnable: true, script: 'dev', entry: 'scripts.dev' };
    }
    if (deps.electron) {
      return {
        kind: 'electron',
        runnable: false,
        reason: 'Electron 应用需要真实桌面窗口，自动验收只覆盖网页构建；请在桌面端手动打开验收。',
        entry: pkgPath,
      };
    }
    if (typeof scripts.start === 'string') {
      return { kind: 'node', runnable: true, script: 'start', entry: 'scripts.start' };
    }
    if (typeof scripts.preview === 'string') {
      return { kind: 'vite', runnable: true, script: 'preview', entry: 'scripts.preview' };
    }
    for (const dir of ['dist', 'build', 'out']) {
      const html = join(rootDir, dir, 'index.html');
      if (existsSync(html)) {
        return { kind: 'static', runnable: true, entryHtml: html, entry: `${dir}/index.html` };
      }
    }
    return {
      kind: 'unknown',
      runnable: false,
      reason: 'package.json 里没有 dev / start / preview 脚本，也没有 dist / build / out 里的 index.html。',
      entry: pkgPath,
    };
  }
  const html = join(rootDir, 'index.html');
  if (existsSync(html)) {
    return { kind: 'static', runnable: true, entryHtml: html, entry: 'index.html' };
  }
  return {
    kind: 'unknown',
    runnable: false,
    reason: '工作目录里没有 package.json，也没有 index.html，无法判断怎么启动。',
    entry: rootDir,
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function inside(root: string, target: string): boolean {
  const base = resolve(root);
  const full = resolve(target);
  return full === base || full.startsWith(base + sep);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? done(port) : fail(new Error('no free port'))));
    });
  });
}

function startStaticServer(dir: string): Promise<{ url: string; server: Server }> {
  return new Promise((done, fail) => {
    const server = createServer((request, response) => {
      try {
        const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
        let file = resolve(join(dir, normalize(path)));
        if (!inside(dir, file)) {
          response.writeHead(403).end('forbidden');
          return;
        }
        let target = file;
        if (!existsSync(target) || statSync(target).isDirectory()) {
          target = join(file, 'index.html');
          // 只有无扩展名的路由才回落到 index.html；缺的 .js/.css 就该 404。
          if (!existsSync(target) && !extname(request.url ?? '')) target = join(dir, 'index.html');
        }
        if (!existsSync(target)) {
          response.writeHead(404).end('not found');
          return;
        }
        const buffer = readFileSync(target);
        response.writeHead(200, {
          'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        response.end(buffer);
      } catch {
        response.writeHead(500).end('static server error');
      }
    });
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      done({ url: `http://127.0.0.1:${port}/`, server });
    });
  });
}

interface Launched {
  child: ChildProcess | null;
  server: Server | null;
  output: () => string;
}

function outputTail(streams: { stdout: string; stderr: string }): string {
  return `${streams.stdout}\n${streams.stderr}`.trim().slice(-6000);
}

function launchDevServer(
  rootDir: string,
  probe: ProjectProbe,
  port: number
): Launched & { preferredUrl: string } {
  const streams = { stdout: '', stderr: '' };
  const script = probe.script ?? 'dev';
  let commandLine = `npm run ${script}`;
  if (probe.kind === 'vite' && script === 'dev') {
    commandLine += ` -- --host 127.0.0.1 --port ${port}`;
  } else if (probe.kind === 'next') {
    commandLine += ` -- -H 127.0.0.1 -p ${port}`;
  }
  const child = spawn(commandLine, {
    cwd: rootDir,
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      BROWSER: 'none',
      NO_OPEN: '1',
      CI: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    streams.stdout = (streams.stdout + chunk.toString('utf8')).slice(-8000);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    streams.stderr = (streams.stderr + chunk.toString('utf8')).slice(-8000);
  });
  return {
    child,
    server: null,
    output: () => outputTail(streams),
    preferredUrl: `http://127.0.0.1:${port}/`,
  };
}

function urlsInOutput(text: string): string[] {
  const found: string[] = [];
  const pattern = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?/gi;
  for (const match of text.matchAll(pattern)) {
    const url = match[0].replace(/[),.;]+$/, '');
    if (!found.includes(url)) found.push(url);
  }
  return found;
}

function killTree(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // already gone
  }
}

async function waitForApp(opts: {
  preferredUrl: string;
  launched: Launched;
  deadline: number;
}): Promise<{ url: string; status: number }> {
  const candidate = new Set([opts.preferredUrl]);
  let lastError = '';
  while (Date.now() < opts.deadline) {
    for (const url of urlsInOutput(opts.launched.output())) candidate.add(url);
    for (const url of candidate) {
      try {
        const response = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(1500),
        });
        if (response.status < 400) {
          // 读掉 body，避免连接挂住
          await response.arrayBuffer().catch(() => undefined);
          return { url, status: response.status };
        }
        lastError = `HTTP ${response.status} ${url}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (opts.launched.child && opts.launched.child.exitCode !== null) {
      const exit = opts.launched.child.exitCode;
      throw new Error(
        `启动命令退出（exit ${exit}）。输出：${opts.launched.output().slice(-900) || '（无输出）'}`
      );
    }
    await sleep(700);
  }
  throw new Error(
    `等待页面超时（${lastError || '没有响应'}）。输出：${opts.launched.output().slice(-900) || '（无输出）'}`
  );
}

/* ── 最小 CDP 客户端：只用 Node 自带的 WebSocket，不引入 playwright ── */

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string };
  sessionId?: string;
}

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
};

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  private readonly listeners = new Set<(message: CdpMessage) => void>();

  private constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener('message', (event: any) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(String(event.data)) as CdpMessage;
      } catch {
        return;
      }
      if (typeof message.id === 'number') {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.fail(new Error(message.error.message ?? 'CDP 错误'));
        else waiter.done(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  static open(url: string, timeoutMs = 15000): Promise<Cdp> {
    const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (!Ctor) return Promise.reject(new Error('当前 Node 没有内置 WebSocket'));
    return new Promise((done, fail) => {
      const socket = new Ctor(url);
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore
        }
        fail(new Error('连接浏览器调试端口超时'));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        done(new Cdp(socket));
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        fail(new Error('连接浏览器调试端口失败'));
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 25000): Promise<any> {
    const id = this.nextId++;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) fail(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        done: (value) => {
          clearTimeout(timer);
          done(value);
        },
        fail: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: (message: CdpMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }
}

function findBrowser(): string | null {
  const paths = [
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  return paths.find((path) => existsSync(path)) ?? null;
}

async function launchBrowser(executable: string): Promise<{ child: ChildProcess; wsUrl: string; tempDir: string }> {
  const tempDir = join(ensureStateDir(), 'user-view', '.browser');
  mkdirSync(tempDir, { recursive: true });
  const profileDir = join(tempDir, randomUUID());
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
  const portFile = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      try {
        const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
        if (port && path) return { child, wsUrl: `ws://127.0.0.1:${port}${path}`, tempDir: profileDir };
      } catch {
        // retry
      }
    }
    if (child.exitCode !== null) throw new Error('浏览器启动后立即退出');
    await sleep(250);
  }
  killTree(child);
  throw new Error('浏览器调试端口没有就绪');
}

interface PageObservation {
  title: string;
  text: string;
  elementCount: number;
  imageCount: number;
  brokenImages: string[];
  interactive: number;
  unnamedButtons: number;
  scrollWidth: number;
  innerWidth: number;
  framework: string;
}

const OBSERVE_SCRIPT = `(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const images = Array.from(document.images || []);
  const interactiveEls = Array.from(document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="link"]')).filter(visible);
  const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
  return {
    title: document.title || '',
    text: ((document.body && document.body.innerText) || '').trim().slice(0, 1200),
    elementCount: document.querySelectorAll('*').length,
    imageCount: images.length,
    brokenImages: images.filter((img) => !(img.complete && img.naturalWidth > 0)).map((img) => (img.currentSrc || img.src || '').slice(0, 200)).slice(0, 5),
    interactive: interactiveEls.length,
    unnamedButtons: buttons.filter((el) => {
      const label = (el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '';
      return !label;
    }).length,
    scrollWidth: document.documentElement ? document.documentElement.scrollWidth : 0,
    innerWidth: window.innerWidth,
    framework: window.__NEXT_DATA__ ? 'next' : (document.querySelector('#root, #app, [data-reactroot]') ? 'spa' : 'plain'),
  };
})()`;

const INTERACT_SCRIPT = `(() => new Promise((resolve) => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const button = Array.from(document.querySelectorAll('button, [role="button"]')).find(visible);
  if (!button) return resolve({ clicked: false });
  let mutated = false;
  const observer = new MutationObserver((records) => { if (records.length) mutated = true; });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const before = location.href;
  try { button.click(); } catch { /* click handler threw; the console check reports it */ }
  setTimeout(() => {
    observer.disconnect();
    resolve({ clicked: true, mutated, navigated: location.href !== before });
  }, 700);
}))()`;

async function observePage(cdp: Cdp, sessionId: string): Promise<PageObservation> {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression: OBSERVE_SCRIPT, returnByValue: true, awaitPromise: false },
    sessionId
  );
  const value = (result?.result?.value ?? {}) as Partial<PageObservation>;
  return {
    title: String(value.title ?? ''),
    text: String(value.text ?? ''),
    elementCount: Number(value.elementCount ?? 0),
    imageCount: Number(value.imageCount ?? 0),
    brokenImages: Array.isArray(value.brokenImages) ? value.brokenImages.map(String) : [],
    interactive: Number(value.interactive ?? 0),
    unnamedButtons: Number(value.unnamedButtons ?? 0),
    scrollWidth: Number(value.scrollWidth ?? 0),
    innerWidth: Number(value.innerWidth ?? 0),
    framework: String(value.framework ?? ''),
  };
}

export interface RunUserViewOptions {
  rootDir: string;
  workspaceId?: string | null;
  runId?: string | null;
  /** 直接验收一个已经在跑的地址，不再启动项目。 */
  url?: string;
  timeoutMs?: number;
  stateDir?: string;
}

export function userViewDir(id: string): string {
  return join(ensureStateDir(), 'user-view', id);
}

export function userViewShotFile(id: string, label: string): string {
  return join(userViewDir(id), `${label}.png`);
}

function saveReport(report: UserViewReport): void {
  const dir = userViewDir(report.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 1), 'utf8');
}

export function readUserView(id: string): UserViewReport | null {
  try {
    return JSON.parse(
      readFileSync(join(userViewDir(id), 'report.json'), 'utf8')
    ) as UserViewReport;
  } catch {
    return null;
  }
}

export function latestUserView(workspaceId?: string | null): UserViewReport | null {
  const base = join(ensureStateDir(), 'user-view');
  if (!existsSync(base)) return null;
  const candidates: Array<{ at: number; id: string }> = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(base, entry.name, 'report.json');
    if (!existsSync(file)) continue;
    try {
      candidates.push({ at: statSync(file).mtimeMs, id: entry.name });
    } catch {
      // skip
    }
  }
  // 按画布过滤后再取最新：全局最新的那份可能属于另一张画布，
  // 拿它去过滤会让本画布的验收结果凭空消失。
  candidates.sort((a, b) => b.at - a.at);
  for (const candidate of candidates) {
    const report = readUserView(candidate.id);
    if (!report) continue;
    if (workspaceId && report.workspaceId !== workspaceId) continue;
    return report;
  }
  return null;
}

/**
 * 执行一次用户视角验收。永远返回报告（连「项目启动不了」也是一种结论），
 * 不抛异常；调用方据此展示，而不是吞掉错误。
 */
export async function runUserView(options: RunUserViewOptions): Promise<UserViewReport> {
  const startedAt = Date.now();
  const deadline = startedAt + (options.timeoutMs ?? 120000);
  const id = randomUUID();
  const rootDir = resolve(options.rootDir);
  const probe = options.url
    ? ({ kind: 'node', runnable: true, entry: options.url } as ProjectProbe)
    : detectProject(rootDir);

  const base: UserViewReport = {
    ok: false,
    id,
    at: startedAt,
    workspaceId: options.workspaceId ?? null,
    runId: options.runId ?? null,
    rootDir,
    kind: probe.kind,
    entry: probe.entry,
    url: options.url ?? '',
    durationMs: 0,
    verdict: 'blocked',
    summary: '',
    checks: [],
    shots: [],
    pageText: '',
  };

  if (!probe.runnable) {
    const report: UserViewReport = {
      ...base,
      durationMs: Date.now() - startedAt,
      summary: `无法自动验收：${probe.reason ?? '项目类型无法识别'}`,
      checks: [{ name: 'launch', label: '启动项目', ok: false, detail: probe.reason }],
      error: probe.reason,
    };
    saveReport(report);
    return report;
  }

  let launched: Launched | null = null;
  let browser: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  const checks: UserViewCheck[] = [];

  try {
    let appUrl = options.url ?? '';
    let serveStatus = 0;
    if (!options.url) {
      const port = await freePort();
      if (probe.kind === 'static' && probe.entryHtml) {
        const dir = probe.entryHtml.endsWith('index.html')
          ? probe.entryHtml.slice(0, -'index.html'.length)
          : rootDir;
        const staticServer = await startStaticServer(dir);
        launched = { child: null, server: staticServer.server, output: () => '' };
        const ready = await waitForApp({ preferredUrl: staticServer.url, launched, deadline });
        appUrl = ready.url;
        serveStatus = ready.status;
      } else {
        const dev = launchDevServer(rootDir, probe, port);
        launched = dev;
        const ready = await waitForApp({ preferredUrl: dev.preferredUrl, launched: dev, deadline });
        appUrl = ready.url;
        serveStatus = ready.status;
      }
    } else {
      const response = await fetch(options.url, { signal: AbortSignal.timeout(10000) });
      serveStatus = response.status;
      await response.arrayBuffer().catch(() => undefined);
    }
    checks.push({
      name: 'serve',
      label: '项目能启动并响应',
      ok: serveStatus >= 200 && serveStatus < 400,
      detail: `HTTP ${serveStatus} · ${appUrl}`,
    });

    const executable = findBrowser();
    if (!executable) throw new Error('没有找到 Edge 或 Chrome，无法做视觉检查');
    const browserLaunched = await launchBrowser(executable);
    browser = browserLaunched.child;
    cdp = await Cdp.open(browserLaunched.wsUrl);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(attached.sessionId);

    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const badResponses: string[] = [];
    const requestUrls = new Map<string, string>();
    let loaded = false;

    cdp.on((message) => {
      if (message.sessionId !== sessionId) return;
      const params = message.params ?? {};
      switch (message.method) {
        case 'Page.loadEventFired':
          loaded = true;
          break;
        case 'Runtime.exceptionThrown':
          consoleErrors.push(
            String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '脚本异常').slice(0, 220)
          );
          break;
        case 'Log.entryAdded':
          if (params.entry?.level === 'error') {
            consoleErrors.push(String(params.entry.text ?? '').slice(0, 220));
          }
          break;
        case 'Runtime.consoleAPICalled':
          if (params.type === 'error') {
            consoleErrors.push(
              (params.args ?? [])
                .map((arg: any) => String(arg.value ?? arg.description ?? ''))
                .join(' ')
                .slice(0, 220)
            );
          }
          break;
        case 'Network.requestWillBeSent':
          requestUrls.set(String(params.requestId), String(params.request?.url ?? ''));
          break;
        case 'Network.loadingFailed': {
          const url = requestUrls.get(String(params.requestId)) ?? '';
          // 主动取消（页面跳转）不算失败
          if (params.canceled !== true) failedRequests.push(`${params.errorText ?? '加载失败'} · ${url}`.slice(0, 220));
          break;
        }
        case 'Network.responseReceived': {
          const status = Number(params.response?.status ?? 0);
          if (status >= 400) {
            badResponses.push(`HTTP ${status} · ${String(params.response?.url ?? '')}`.slice(0, 220));
          }
          break;
        }
        default:
          break;
      }
    });

    const origin = new URL(appUrl).origin;
    const sameOrigin = (line: string) => line.includes(origin);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId
    );
    await cdp.send('Page.navigate', { url: appUrl }, sessionId);
    const loadDeadline = Date.now() + 25000;
    while (!loaded && Date.now() < loadDeadline) await sleep(200);
    // 框架首屏通常是异步渲染，等一会儿再采样
    await sleep(1800);

    const desktop = await observePage(cdp, sessionId);
    const desktopShot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const desktopBuffer = Buffer.from(String(desktopShot.data ?? ''), 'base64');
    mkdirSync(userViewDir(id), { recursive: true });
    writeFileSync(userViewShotFile(id, 'desktop'), desktopBuffer);

    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      sessionId
    );
    await sleep(900);
    const mobile = await observePage(cdp, sessionId);
    const mobileShot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const mobileBuffer = Buffer.from(String(mobileShot.data ?? ''), 'base64');
    writeFileSync(userViewShotFile(id, 'mobile'), mobileBuffer);

    // 实际点一下主要按钮：页面有没有变化，这是「功能」层面的用户反馈。
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId
    );
    const interact = await cdp.send(
      'Runtime.evaluate',
      { expression: INTERACT_SCRIPT, returnByValue: true, awaitPromise: true },
      sessionId,
      15000
    );
    const interaction = (interact?.result?.value ?? {}) as {
      clicked?: boolean;
      mutated?: boolean;
      navigated?: boolean;
    };

    const textLength = desktop.text.length;
    checks.push({
      name: 'content',
      label: '页面有可见内容',
      ok: textLength >= 12 && desktop.elementCount >= 8,
      detail: `标题「${desktop.title || '无'}」· 可见文本 ${textLength} 字 · ${desktop.elementCount} 个元素`,
    });
    // 资源加载失败已经由 network 检查统计；浏览器为每个失败资源再发一条
    // 「Failed to load resource」，不去重会把一个 404 算成两个问题。
    const consoleProblems = [...new Set(consoleErrors)].filter(
      (line) => !/Failed to load resource/i.test(line)
    );
    checks.push({
      name: 'console',
      label: '没有脚本报错',
      ok: consoleProblems.length === 0,
      detail:
        consoleProblems.length === 0
          ? '控制台干净'
          : `${consoleProblems.length} 条错误：${consoleProblems.slice(0, 3).join('；')}`,
    });
    // favicon、sourcemap、HMR 之类的请求失败不是用户看得见的问题。
    const noise = /favicon\.ico|\.map(\?|$)|hot-update|@react-refresh|__vite/i;
    const localFailures = [...new Set([...failedRequests, ...badResponses])]
      .filter(sameOrigin)
      .filter((line) => !noise.test(line));
    checks.push({
      name: 'network',
      label: '本站资源都加载成功',
      ok: localFailures.length === 0,
      detail: localFailures.length === 0 ? '没有失败请求' : localFailures.slice(0, 3).join('；'),
    });
    checks.push({
      name: 'images',
      label: '图片都能显示',
      ok: desktop.brokenImages.length === 0,
      detail:
        desktop.imageCount === 0
          ? '页面没有图片'
          : `${desktop.imageCount} 张图，${desktop.brokenImages.length} 张加载失败${desktop.brokenImages.length ? `：${desktop.brokenImages.join('、')}` : ''}`,
    });
    checks.push({
      name: 'interactive',
      label: '有可点击的操作',
      ok: desktop.interactive > 0,
      detail: `${desktop.interactive} 个可交互元素${desktop.unnamedButtons ? `，${desktop.unnamedButtons} 个按钮没有文字或标签` : ''}`,
    });
    const overflow = mobile.scrollWidth - 390;
    checks.push({
      name: 'overflow',
      label: '手机上不横向溢出',
      ok: overflow <= 2,
      detail: overflow > 2 ? `页面在 390px 宽下横向溢出 ${overflow}px` : '手机宽度下布局正常',
    });
    checks.push({
      name: 'interact',
      label: '主要按钮有反应',
      soft: true,
      ok: Boolean(interaction.clicked && (interaction.mutated || interaction.navigated)),
      detail:
        interaction.clicked !== true
          ? '页面没有可点的按钮'
          : interaction.mutated || interaction.navigated
            ? '点击后页面有变化'
            : '点了按钮，页面没有任何变化',
    });
    const visualOk = desktopBuffer.length > 8000 && mobileBuffer.length > 6000;
    checks.push({
      name: 'visual',
      label: '截到了真实画面',
      ok: visualOk,
      detail: `桌面 ${(desktopBuffer.length / 1024).toFixed(0)}KB · 手机 ${(mobileBuffer.length / 1024).toFixed(0)}KB`,
    });

    const shots: UserViewShot[] = [
      { label: 'desktop', file: userViewShotFile(id, 'desktop'), bytes: desktopBuffer.length, width: 1440, height: 900 },
      { label: 'mobile', file: userViewShotFile(id, 'mobile'), bytes: mobileBuffer.length, width: 390, height: 844 },
    ];
    const failedChecks = checks.filter((check) => !check.ok && !check.soft);
    const softWarnings = checks.filter((check) => check.soft && !check.ok);
    const report: UserViewReport = {
      ...base,
      url: appUrl,
      durationMs: Date.now() - startedAt,
      verdict: failedChecks.length === 0 ? 'pass' : 'fail',
      ok: failedChecks.length === 0,
      summary:
        failedChecks.length === 0
          ? `用户视角验收通过：页面能打开、有可见内容、没有脚本错误，桌面和手机截图已保存。${
              softWarnings.length ? `提醒：${softWarnings.map((check) => check.label).join('、')}。` : ''
            }`
          : `用户视角验收未通过：${failedChecks.map((check) => check.label).join('、')}。`,
      checks,
      shots,
      pageText: desktop.text,
    };
    saveReport(report);
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report: UserViewReport = {
      ...base,
      durationMs: Date.now() - startedAt,
      verdict: 'blocked',
      summary: `用户视角验收没跑起来：${message.slice(0, 300)}`,
      checks:
        checks.length > 0
          ? checks
          : [{ name: 'launch', label: '启动项目', ok: false, detail: message.slice(0, 400) }],
      error: message.slice(0, 1000),
    };
    saveReport(report);
    return report;
  } finally {
    cdp?.close();
    killTree(browser);
    killTree(launched?.child ?? null);
    if (launched?.server) {
      const server = launched.server;
      await new Promise<void>((done) => server.close(() => done()));
    }
  }
}
