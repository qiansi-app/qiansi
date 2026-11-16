import type { SearchFn, SearchHit } from '@qiansi/engine';
import type { KeySlot } from './model-catalog.js';
import type { DpapiVault } from './vault.js';

/**
 * Web search adapters. The model never holds a search key; the server runs the
 * query through whichever provider is available and returns results as a tool
 * message. Selection is subscription-first: the GLM (智谱) web_search endpoint
 * is preferred because its key is billed by subscription, then optional metered
 * providers, then a keyless HTML fallback.
 *
 * 检索管线（2026-11 借鉴 open-deep-research / gpt-researcher / SearXNG 的做法）：
 * 1. 关键源带正文（zhipu content_size=high，一条结果直接给 6KB+ 可读内容，
 *    省掉二次抓取——实测 meta/技术站都返回正文）；
 * 2. 多路并发 + RRF 融合：有 key 的源与 HTML 源同时查，按 1/(60+rank) 融合排序，
 *    URL 归一去重，单站点最多占 N 席，避免一个站的 SEO 页面刷屏；
 * 3. freshness：工具可声明 week/month/year，中文 query 里的「最新/今年」也自动收窄；
 * 4. 同查询 10 分钟缓存保留——重试的任务不为同一次搜索付两次钱。
 */
export type SearchProviderId = 'zhipu' | 'bocha' | 'tavily' | 'html';

export type SearchFreshness = 'anyTime' | 'week' | 'month' | 'year';

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
  /** 禁止与 HTML 源并发融合（测试里锁定单一来源时用）。 */
  singleSource?: boolean;
  /**
   * 可选的 LLM 钩子（deep-research / MultiQueryRetriever 的查询改写与重排）。
   * 由 index.ts 注入一个快模型调用；不注入或调用失败就完全退回纯检索路径。
   * 改写由 QIANSI_SEARCH_REWRITE=on 打开；重排默认开、QIANSI_SEARCH_RERANK=off 关。
   */
  llm?: (system: string, user: string, maxTokens?: number) => Promise<string>;
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

/** zhipu freshness 词表；其它源不支持就忽略。 */
const FRESHNESS_MAP: Record<Exclude<SearchFreshness, 'anyTime'>, string> = {
  week: 'oneWeek',
  month: 'oneMonth',
  year: 'oneYear',
};

/** 「最新/今年/最近」这类词出现在 query 里就自动收窄到一年内的结果。 */
const RECENT_HINT = /(最新|最近|今年|本月|上周|近期|新闻|发布|latest|recent|news|release|202[4-9])/i;

function normalizeFreshness(freshness?: string, query?: string): SearchFreshness {
  if (freshness === 'week' || freshness === 'month' || freshness === 'year') return freshness;
  if (!freshness || freshness === 'anyTime') {
    return RECENT_HINT.test(query ?? '') ? 'year' : 'anyTime';
  }
  return 'anyTime';
}

async function zhipuSearch(
  query: string,
  limit: number,
  key: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  freshness: SearchFreshness = 'anyTime'
): Promise<SearchHit[]> {
  const engine = process.env.QIANSI_SEARCH_ENGINE?.trim() || 'search_std';
  const body: Record<string, unknown> = {
    search_engine: engine,
    search_query: query,
    // 多取一倍再融合去重：单站刷屏和重复 URL 都在这里被挤掉。
    count: Math.min(20, limit * 2),
    // high 直接返回页面正文（实测 6–8KB/条）：模型拿到的不是摘要而是材料。
    content_size: 'high',
  };
  if (freshness !== 'anyTime') body.freshness = FRESHNESS_MAP[freshness];
  const response = await fetchImpl('https://open.bigmodel.cn/api/paas/v4/web_search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`zhipu ${response.status}: ${text.slice(0, 300) || response.statusText}`);
  }
  const data = asRecord(JSON.parse(text));
  const list = Array.isArray(data.search_result) ? data.search_result : [];
  return list.slice(0, limit * 2).map((item) => {
    const record = asRecord(item);
    const content = asString(record.content ?? record.snippet);
    return {
      title: asString(record.title),
      url: asString(record.link ?? record.url),
      // snippet 留短版给列表展示；content 是给模型读的材料。
      snippet: content.slice(0, 300),
      content: content.length > 300 ? content : undefined,
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
  signal: AbortSignal,
  freshness: SearchFreshness = 'anyTime'
): Promise<SearchHit[]> {
  const response = await fetchImpl('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query,
      count: Math.min(20, limit * 2),
      summary: true,
      freshness: freshness === 'anyTime' ? 'noLimit' : FRESHNESS_MAP[freshness],
    }),
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
  signal: AbortSignal,
  freshness: SearchFreshness = 'anyTime'
): Promise<SearchHit[]> {
  const response = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: Math.min(20, limit * 2),
      search_depth: 'advanced',
      include_answer: false,
      ...(freshness !== 'anyTime' ? { time_range: freshness } : {}),
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
 * URL 归一化：小写 host、去跟踪参数、去尾斜杠——同一个页面从两个源回来时
 * 只留一份。RRF 的名次以去重后的清单为准。
 */
function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const drop = [...parsed.searchParams.keys()].filter((key) =>
      /^(utm_|spm|from|fr|share_|ref_?id$|id_?from$)/i.test(key)
    );
    for (const key of drop) parsed.searchParams.delete(key);
    parsed.hostname = parsed.hostname.toLowerCase();
    let out = parsed.toString();
    if (out.endsWith('/') && parsed.pathname === '/') out = out.replace(/\/$/, '');
    return out;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Reciprocal Rank Fusion（SearXNG/开源 deep-research 通用做法）：
 * 每个来源贡献 score = 1 / (K + rank)，K=60；并发源的命中天然靠前，
 * 单一来源的运气结果不会压过两个来源的共同结果。
 */
function rrfMerge(lists: SearchHit[][], limit: number, weights?: number[]): SearchHit[] {
  const K = 60;
  const byUrl = new Map<string, { hit: SearchHit; score: number }>();
  lists.forEach((list, listIndex) => {
    const weight = weights?.[listIndex] ?? 1;
    list.forEach((hit, rank) => {
      const key = canonicalUrl(hit.url) || hit.url;
      const entry = byUrl.get(key);
      const gain = (weight / (K + rank));
      if (entry) {
        entry.score += gain;
        // 首个来源的标题/正文最完整，只补空字段。
        if (!entry.hit.snippet && hit.snippet) entry.hit.snippet = hit.snippet;
        if (!entry.hit.content && hit.content) entry.hit.content = hit.content;
        if (!entry.hit.source && hit.source) entry.hit.source = hit.source;
        if (!entry.hit.publishedAt && hit.publishedAt) entry.hit.publishedAt = hit.publishedAt;
      } else {
        byUrl.set(key, { hit: { ...hit }, score: gain });
      }
    });
  });
  const ranked = [...byUrl.values()].sort((a, b) => b.score - a.score);
  // 单站点最多占一半席位：把 SEO 刷屏挤出去，让来源多样一点。
  const perHost = new Map<string, number>();
  const out: SearchHit[] = [];
  const overflow: typeof ranked = [];
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  };
  for (const entry of ranked) {
    const host = hostOf(entry.hit.url);
    const count = perHost.get(host) ?? 0;
    if (count >= Math.max(2, Math.ceil(limit / 2))) {
      overflow.push(entry);
      continue;
    }
    perHost.set(host, count + 1);
    out.push(entry.hit);
    if (out.length >= limit) return out;
  }
  for (const entry of overflow) {
    out.push(entry.hit);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * One service per server process. It caches identical queries for ten minutes
 * so a retried task does not pay for the same search twice.
 */
export class WebSearchService {
  private readonly cache = new Map<string, { at: number; hits: SearchHit[]; ttl?: number }>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly keyFor: (slot: KeySlot) => Promise<string | undefined>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly singleSource: boolean;
  private readonly llm?: (system: string, user: string, maxTokens?: number) => Promise<string>;
  private readonly rewriteEnabled: boolean;
  private readonly rerankEnabled: boolean;
  private providerOverride?: SearchProviderId;

  constructor(
    private readonly vault: DpapiVault,
    options: WebSearchOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.env = options.env ?? process.env;
    this.providerOverride = options.provider;
    this.singleSource = options.singleSource ?? false;
    this.llm = options.llm;
    this.rewriteEnabled = this.env.QIANSI_SEARCH_REWRITE === 'on';
    this.rerankEnabled = this.env.QIANSI_SEARCH_RERANK !== 'off';
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
  readonly search: SearchFn = async ({ query, maxResults, signal, freshness }) => {
    const cleaned = query.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!cleaned) return [];
    const limit = Math.min(Math.max(Math.trunc(maxResults ?? 6), 1), 10);
    const window = normalizeFreshness(freshness, cleaned);
    const cacheKey = `${limit}:${window}:${cleaned.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < (cached.ttl ?? CACHE_TTL_MS)) return cached.hits;

    const provider = await this.resolveProvider();
    if (!provider) throw new Error('no search provider configured');

    const controller = new AbortController();
    const timeout = withTimeout(signal, this.timeoutMs);
    const abort = () => controller.abort();
    timeout.addEventListener('abort', abort, { once: true });
    let hits: SearchHit[];
    try {
      // 有 key 的源与 HTML 源并发，再 RRF 融合：一个源的盲区由另一个源补上。
      // 强制 singleSource（测试）或强制 html 时只走一路。
      const keyedId = provider.info.id === 'html' ? null : provider.info.id;
      const mergeHtml =
        !this.singleSource &&
        provider.info.id !== 'html' &&
        (this.providerOverride ?? this.env.QIANSI_SEARCH_PROVIDER) === undefined;
      // 查询改写（MultiQueryRetriever / deep-research 的扇出）：一次 LLM 调用生成
      // 2 个变体，与原查询各查一路再融合；失败降级为原查询，绝不毁掉整轮。
      const keyedQueries = [cleaned];
      if (this.rewriteEnabled && this.llm && keyedId !== null) {
        const variants = await this.rewriteQuery(cleaned).catch(() => [] as string[]);
        for (const variant of variants.slice(0, 2)) {
          const trimmed = variant.replace(/\s+/g, ' ').trim().slice(0, 300);
          if (trimmed && trimmed.toLowerCase() !== cleaned.toLowerCase()) keyedQueries.push(trimmed);
        }
      }
      const providerCall = (q: string) => {
        const requestSignal = AbortSignal.any([controller.signal, timeout]);
        if (provider.info.id === 'zhipu' && provider.key) {
          return zhipuSearch(q, limit, provider.key, this.fetchImpl, requestSignal, window);
        }
        if (provider.info.id === 'bocha' && provider.key) {
          return bochaSearch(q, limit, provider.key, this.fetchImpl, requestSignal, window);
        }
        if (provider.info.id === 'tavily' && provider.key) {
          return tavilySearch(q, limit, provider.key, this.fetchImpl, requestSignal, window);
        }
        return Promise.resolve([] as SearchHit[]);
      };
      const keyedCall = (async () => {
        const perQuery = await Promise.all(
          keyedQueries.map((q) => providerCall(q).catch(() => [] as SearchHit[]))
        );
        // 每路保留独立列表：RRF 的名次在各自列表内计算——拍平会让第 2 路的
        // 第 1 名从第 7 名开始算，改写就白改了。
        return perQuery.filter((list) => list.length > 0);
      })();
      const htmlCall = mergeHtml
        ? htmlSearch(cleaned, limit, this.fetchImpl, AbortSignal.any([controller.signal, timeout])).catch(
            () => [] as SearchHit[]
          )
        : Promise.resolve(null as SearchHit[] | null);

      const [keyedLists, html] = await Promise.all([keyedCall, htmlCall]);
      const lists: SearchHit[][] = [];
      const weights: number[] = [];
      if (keyedId === null) {
        // 没有任何 key：HTML 源自己就是主力（Bing→DDG）。
        lists.push(
          (await htmlCall) ??
            (await htmlSearch(
              cleaned,
              limit,
              this.fetchImpl,
              AbortSignal.any([controller.signal, timeout])
            ))
        );
      } else if (keyedLists.length > 0) {
        for (const list of keyedLists) {
          lists.push(list);
          // 有 key 的源（订阅计费、质量更高）加权 1.0，HTML 源 0.7。
          weights.push(1);
        }
        if (html && html.length > 0) {
          lists.push(html);
          weights.push(0.7);
        }
      } else {
        // 有 key 的源挂了或空返回：整体落到 HTML 兜底，别返回空结果。
        lists.push(
          await htmlSearch(cleaned, limit, this.fetchImpl, AbortSignal.any([controller.signal, timeout]))
        );
      }
      hits = rrfMerge(lists, limit, keyedId === null ? undefined : weights);

      // LLM 重排（FlashRank/bge 的 TS 等价）：命中多时把 fused 结果交给快模型
      // 按与 query 的相关性排一次序；失败保持原序，绝不因它报错。
      if (this.llm && this.rerankEnabled && hits.length > 4) {
        hits = await this.rerankWithLlm(cleaned, hits, limit).catch(() => hits);
      }
      if (hits.length === 0 && keyedId !== null) {
        throw new Error(`${provider.info.id} returned no results`);
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

    // 时效结果的保鲜期短：week 窗口 3 分钟，其余 10 分钟（FreshQA 的教训）。
    const ttl = window === 'week' ? 3 * 60_000 : CACHE_TTL_MS;
    this.cache.set(cacheKey, { at: Date.now(), hits, ttl });
    if (this.cache.size > CACHE_MAX) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    return hits;
  };

  /** LLM 查询改写：最多 2 个互补变体（不同措辞/不同语言/更具体的实体）。 */
  private async rewriteQuery(query: string): Promise<string[]> {
    if (!this.llm) return [];
    const text = await this.llm(
      '你是查询改写器。只输出一个 JSON 数组，包含 2 个与原查询互补的搜索变体（换措辞、补实体、必要时换语言），不要解释。',
      `原查询：${query}`,
      200
    );
    const match = /\[[\s\S]*\]/.exec(text);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 3);
  }

  /** LLM listwise 重排：只回一个 JSON 索引数组，解析不了就原序返回。 */
  private async rerankWithLlm(query: string, hits: SearchHit[], limit: number): Promise<SearchHit[]> {
    if (!this.llm) return hits;
    const lines = hits
      .slice(0, limit * 2)
      .map((hit, index) => `${index + 1}. ${hit.title} :: ${(hit.snippet ?? '').slice(0, 120)}`)
      .join('\n');
    const text = await this.llm(
      '你是检索重排器。只输出一个 JSON 数组，按与查询的相关性从高到低排列编号，形如 [3,1,2]。不要解释。',
      `查询：${query}\n候选：\n${lines}`,
      200
    );
    const match = /\[[\d\s,，]+\]/.exec(text);
    if (!match) return hits;
    const order = JSON.parse(match[0].replace(/，/g, ',')) as number[];
    if (!Array.isArray(order) || order.length === 0) return hits;
    const pool = hits.slice(0, limit * 2);
    const seen = new Set<number>();
    const out: SearchHit[] = [];
    for (const raw of order) {
      const index = Number(raw) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= pool.length || seen.has(index)) continue;
      seen.add(index);
      out.push(pool[index]);
      if (out.length >= limit) return out;
    }
    for (const hit of pool) {
      if (out.length >= limit) break;
      if (!seen.has(pool.indexOf(hit))) out.push(hit);
    }
    return out;
  }

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
