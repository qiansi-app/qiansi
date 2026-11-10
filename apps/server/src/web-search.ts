import type { SearchFn, SearchHit } from '@qiansi/engine';
import type { KeySlot } from './model-catalog.js';
import type { DpapiVault } from './vault.js';

/**
 * Web search adapters. The model never holds a search key; the server runs the
 * query through whichever provider is available and returns results as a tool
 * message. Selection is subscription-first: the GLM (智谱) web_search endpoint
 * is preferred because its key is billed by subscription, then optional metered
 * providers, then a keyless HTML fallback.
 */
export type SearchProviderId = 'zhipu' | 'bocha' | 'tavily' | 'html';

export interface SearchProviderInfo {
  id: SearchProviderId;
  label: string;
  billing: 'subscription' | 'metered' | 'free';
  requiresKey: boolean;
}

export const SEARCH_PROVIDERS: SearchProviderInfo[] = [
  { id: 'zhipu', label: '智谱 Web 搜索', billing: 'subscription', requiresKey: true },
  { id: 'bocha', label: '博查 Web 搜索', billing: 'metered', requiresKey: true },
  { id: 'tavily', label: 'Tavily', billing: 'metered', requiresKey: true },
  { id: 'html', label: 'Bing 网页（无 Key）', billing: 'free', requiresKey: false },
];

interface ResolvedProvider {
  info: SearchProviderInfo;
  key?: string;
}

export interface WebSearchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Resolve a managed key for a slot; defaults to vault + env. */
  keyFor?: (slot: KeySlot) => Promise<string | undefined>;
  /** Restrict or force a provider. */
  provider?: SearchProviderId;
  env?: NodeJS.ProcessEnv;
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 120;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timer = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/\s+/g, ' ')
    .trim();
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

async function zhipuSearch(
  query: string,
  limit: number,
  key: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<SearchHit[]> {
  const engine = process.env.QIANSI_SEARCH_ENGINE?.trim() || 'search_std';
  const response = await fetchImpl('https://open.bigmodel.cn/api/paas/v4/web_search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      search_engine: engine,
      search_query: query,
      count: limit,
      content_size: 'medium',
    }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`zhipu ${response.status}: ${text.slice(0, 300) || response.statusText}`);
  }
  const data = asRecord(JSON.parse(text));
  const list = Array.isArray(data.search_result) ? data.search_result : [];
  return list.slice(0, limit).map((item) => {
    const record = asRecord(item);
    return {
      title: asString(record.title),
      url: asString(record.link ?? record.url),
      snippet: asString(record.content ?? record.snippet),
      source: asString(record.media) || undefined,
      publishedAt: asString(record.publish_date) || undefined,
    };
  });
}

async function bochaSearch(
  query: string,
  limit: number,
  key: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<SearchHit[]> {
  const response = await fetchImpl('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, count: limit, summary: true, freshness: 'noLimit' }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`bocha ${response.status}: ${text.slice(0, 300) || response.statusText}`);
  }
  const data = asRecord(JSON.parse(text));
  const pages = asRecord(asRecord(data.data).webPages);
  const list = Array.isArray(pages.value) ? pages.value : [];
  return list.slice(0, limit).map((item) => {
    const record = asRecord(item);
    return {
      title: asString(record.name),
      url: asString(record.url),
      snippet: asString(record.summary ?? record.snippet),
      source: asString(record.siteName) || undefined,
      publishedAt: asString(record.datePublished) || undefined,
    };
  });
}

async function tavilySearch(
  query: string,
  limit: number,
  key: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<SearchHit[]> {
  const response = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: limit,
      search_depth: 'basic',
      include_answer: false,
    }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`tavily ${response.status}: ${text.slice(0, 300) || response.statusText}`);
  }
  const data = asRecord(JSON.parse(text));
  const list = Array.isArray(data.results) ? data.results : [];
  return list.slice(0, limit).map((item) => {
    const record = asRecord(item);
    return {
      title: asString(record.title),
      url: asString(record.url),
      snippet: asString(record.content),
      publishedAt: asString(record.published_date) || undefined,
    };
  });
}

function parseBing(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const items = html.match(/<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<\/li>/gi) ?? [];
  for (const item of items) {
    const anchor = item.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const snippet = item.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '';
    hits.push({
      title: decodeEntities(anchor[2] ?? ''),
      url: decodeEntities(anchor[1] ?? ''),
      snippet: decodeEntities(snippet),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

function parseDuckDuckGo(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const items = html.match(/<div[^>]*class="[^"]*result[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi) ?? [];
  for (const item of items) {
    const anchor = item.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const snippet = item.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '';
    const href = decodeEntities(anchor[1] ?? '');
    const url = href.includes('uddg=')
      ? decodeURIComponent(href.split('uddg=')[1]?.split('&')[0] ?? href)
      : href;
    hits.push({ title: decodeEntities(anchor[2] ?? ''), url, snippet: decodeEntities(snippet) });
    if (hits.length >= limit) break;
  }
  return hits;
}

async function htmlSearch(
  query: string,
  limit: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<SearchHit[]> {
  const headers = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  const bing = await fetchImpl(
    `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}&setlang=zh-hans`,
    { headers, signal }
  );
  if (bing.ok) {
    const hits = parseBing(await bing.text(), limit);
    if (hits.length > 0) return hits;
  }
  const ddg = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers,
    signal,
  });
  if (!ddg.ok) throw new Error(`html search ${ddg.status}`);
  return parseDuckDuckGo(await ddg.text(), limit);
}

/**
 * One service per server process. It caches identical queries for ten minutes
 * so a retried task does not pay for the same search twice.
 */
export class WebSearchService {
  private readonly cache = new Map<string, { at: number; hits: SearchHit[] }>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly keyFor: (slot: KeySlot) => Promise<string | undefined>;
  private readonly env: NodeJS.ProcessEnv;
  private providerOverride?: SearchProviderId;

  constructor(
    private readonly vault: DpapiVault,
    options: WebSearchOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.env = options.env ?? process.env;
    this.providerOverride = options.provider;
    this.keyFor =
      options.keyFor ??
      (async (slot) => {
        const ref = slot === 'zhipu' ? 'conn-zhipu' : '';
        return ref ? await this.vault.get(ref) : undefined;
      });
  }

  private async resolveProvider(): Promise<ResolvedProvider | null> {
    const forced = this.providerOverride ?? (this.env.QIANSI_SEARCH_PROVIDER as SearchProviderId);
    const zhipuKey =
      (await this.keyFor('zhipu')) || this.env.ZHIPUAI_API_KEY || undefined;
    const bochaKey = this.env.BOCHA_API_KEY || undefined;
    const tavilyKey = this.env.TAVILY_API_KEY || undefined;

    const byId = (id: SearchProviderId): ResolvedProvider | null => {
      const info = SEARCH_PROVIDERS.find((item) => item.id === id)!;
      if (id === 'zhipu') return zhipuKey ? { info, key: zhipuKey } : null;
      if (id === 'bocha') return bochaKey ? { info, key: bochaKey } : null;
      if (id === 'tavily') return tavilyKey ? { info, key: tavilyKey } : null;
      return { info };
    };

    if (forced) {
      const picked = byId(forced);
      if (picked) return picked;
      // A forced provider without a key falls through to the normal order
      // rather than disabling search entirely.
    }
    if (zhipuKey) return byId('zhipu');
    if (bochaKey) return byId('bocha');
    if (tavilyKey) return byId('tavily');
    return byId('html');
  }

  /** SearchFn injected into the engine's SearchToolAdapter. */
  readonly search: SearchFn = async ({ query, maxResults, signal }) => {
    const cleaned = query.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!cleaned) return [];
    const limit = Math.min(Math.max(Math.trunc(maxResults ?? 6), 1), 10);
    const cacheKey = `${limit}:${cleaned.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.hits;

    const provider = await this.resolveProvider();
    if (!provider) throw new Error('no search provider configured');

    const controller = new AbortController();
    const timeout = withTimeout(signal, this.timeoutMs);
    const abort = () => controller.abort();
    timeout.addEventListener('abort', abort, { once: true });
    let hits: SearchHit[];
    try {
      const requestSignal = AbortSignal.any([controller.signal, timeout]);
      if (provider.info.id === 'zhipu' && provider.key) {
        hits = await zhipuSearch(cleaned, limit, provider.key, this.fetchImpl, requestSignal);
      } else if (provider.info.id === 'bocha' && provider.key) {
        hits = await bochaSearch(cleaned, limit, provider.key, this.fetchImpl, requestSignal);
      } else if (provider.info.id === 'tavily' && provider.key) {
        hits = await tavilySearch(cleaned, limit, provider.key, this.fetchImpl, requestSignal);
      } else {
        hits = await htmlSearch(cleaned, limit, this.fetchImpl, requestSignal);
      }
    } catch (error) {
      // A keyed provider that fails should not take search down with it: fall
      // back to the keyless HTML path once, then report the original error.
      if (provider.info.id !== 'html') {
        const fallbackSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs);
        try {
          hits = await htmlSearch(cleaned, limit, this.fetchImpl, fallbackSignal);
        } catch {
          throw error;
        }
      } else {
        throw error;
      }
    } finally {
      timeout.removeEventListener('abort', abort);
    }

    this.cache.set(cacheKey, { at: Date.now(), hits });
    if (this.cache.size > CACHE_MAX) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    return hits;
  };

  async status(): Promise<{
    provider: SearchProviderInfo | null;
    configured: Array<SearchProviderInfo & { ready: boolean }>;
    cachedQueries: number;
  }> {
    const provider = await this.resolveProvider();
    const ready: Array<SearchProviderInfo & { ready: boolean }> = [];
    for (const info of SEARCH_PROVIDERS) {
      let has = !info.requiresKey;
      if (info.id === 'zhipu') has = Boolean((await this.keyFor('zhipu')) || this.env.ZHIPUAI_API_KEY);
      if (info.id === 'bocha') has = Boolean(this.env.BOCHA_API_KEY);
      if (info.id === 'tavily') has = Boolean(this.env.TAVILY_API_KEY);
      ready.push({ ...info, ready: has });
    }
    return { provider: provider?.info ?? null, configured: ready, cachedQueries: this.cache.size };
  }
}
