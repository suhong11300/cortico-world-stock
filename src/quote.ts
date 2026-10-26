/**
 * 行情源:东方财富(批量、字段全)与同花顺(单只、JSONP)。
 * 两条路都只读公开行情页,不登录、不碰账户接口;账户数据另行由 account.ts 从本地配置读。
 */
import { formatQuoteTime } from './format.ts';

export type QuoteSource = 'eastmoney' | 'ths';
export type MarketTag = 'sh' | 'sz' | 'bj';

export interface SymbolRef {
  /** 归一化后的 6 位代码。 */
  code: string;
  /** 交易所。 */
  market: MarketTag;
  /** 东方财富的 secid,形如 1.600519。 */
  secid: string;
  /** 原始输入,回执里按它回话。 */
  raw: string;
  /** 是否被显式标成指数(同花顺路不走指数)。 */
  index: boolean;
}

export interface Quote {
  code: string;
  name: string;
  market: MarketTag;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  change: number;
  changePct: number;
  /** 成交量(手)。 */
  volume: number;
  /** 成交额(元)。 */
  amount: number;
  /** 数据源给的时间戳,毫秒;没有就是 null。 */
  at: number | null;
  source: QuoteSource;
  /** 停牌/无报价时为 true,此时 price 等字段是 0。 */
  suspended: boolean;
}

export type QuoteErrorKind = 'network' | 'http' | 'parse' | 'empty' | 'unsupported';

export class QuoteError extends Error {
  readonly kind: QuoteErrorKind;
  constructor(message: string, kind: QuoteErrorKind) {
    super(message);
    this.name = 'QuoteError';
    this.kind = kind;
  }
}

export interface FetchQuotesOptions {
  source?: QuoteSource | 'auto';
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** 东财单批上限;超过就分批。 */
  batchSize?: number;
}

export interface FetchQuotesResult {
  quotes: Quote[];
  /** 认不出或取不到的行,按原始输入回报。 */
  errors: Array<{ raw: string; reason: string }>;
  /** 真正用上的源;auto 下逐级降级后是实际成功的那一个。 */
  source: QuoteSource | null;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const THS_REFERER = 'https://stockpage.10jqka.com.cn/';
const EM_FIELDS = 'f1,f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f124';

/** `600519` / `sh600519` / `600519.SH` / `1.600519` 都归一化成同一份引用。 */
export function normalizeSymbol(input: string): SymbolRef | null {
  const raw = input.trim();
  if (!raw) return null;
  let text = raw.toUpperCase();
  let market: MarketTag | undefined;
  let index = false;

  if (text.startsWith('INDEX:')) {
    index = true;
    text = text.slice(6);
  }
  const prefixed = /^(SH|SZ|BJ)(\d{6})$/.exec(text);
  const suffixed = /^(\d{6})\.(SH|SZ|BJ)$/.exec(text);
  const secidForm = /^([01])\.(\d{6})$/.exec(text);
  let code = text;
  if (prefixed) {
    market = prefixed[1].toLowerCase() as MarketTag;
    code = prefixed[2];
  } else if (suffixed) {
    market = suffixed[2].toLowerCase() as MarketTag;
    code = suffixed[1];
  } else if (secidForm) {
    market = secidForm[1] === '1' ? 'sh' : 'sz';
    code = secidForm[2];
  } else if (!/^\d{6}$/.test(text)) {
    return null;
  }

  if (!market) market = guessMarket(code);
  const emMarket = market === 'sh' ? 1 : 0;
  return { code, market, secid: `${emMarket}.${code}`, raw, index };
}

/** 不带前缀时的交易所推断:6/9/5 开头沪市,0/3/1(债) 深市,4/8 北交所。 */
function guessMarket(code: string): MarketTag {
  const head = code[0];
  if (head === '6' || head === '9' || head === '5') return 'sh';
  if (head === '4' || head === '8') return 'bj';
  return 'sz';
}

/** `600519, sz000001 300750` 这类自由写法拆成引用表;重复的代码只留一次。 */
export function parseSymbols(text: string): { symbols: SymbolRef[]; problems: string[] } {
  const symbols: SymbolRef[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const piece of text.split(/[,，、\s|]+/)) {
    const token = piece.trim();
    if (!token) continue;
    const ref = normalizeSymbol(token);
    if (!ref) {
      problems.push(token);
      continue;
    }
    if (seen.has(ref.secid)) continue;
    seen.add(ref.secid);
    symbols.push(ref);
  }
  return { symbols, problems };
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function getText(url: string, opts: FetchQuotesOptions, referer?: string): Promise<string> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const headers: Record<string, string> = { 'User-Agent': UA, Accept: '*/*' };
    if (referer) headers.Referer = referer;
    const res = await doFetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new QuoteError(`HTTP ${res.status}`, 'http');
    return await res.text();
  } catch (err) {
    if (err instanceof QuoteError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new QuoteError(message, 'network');
  } finally {
    clearTimeout(timer);
  }
}

interface EastmoneyRow {
  f2?: unknown;
  f3?: unknown;
  f4?: unknown;
  f5?: unknown;
  f6?: unknown;
  f12?: unknown;
  f13?: unknown;
  f14?: unknown;
  f15?: unknown;
  f16?: unknown;
  f17?: unknown;
  f18?: unknown;
  f124?: unknown;
}

/** 东方财富批量接口:一次最多 50 个 secid,返回的行按代码对齐。 */
export async function fetchEastmoney(symbols: readonly SymbolRef[], opts: FetchQuotesOptions = {}): Promise<Quote[]> {
  if (!symbols.length) return [];
  const size = Math.max(1, Math.min(opts.batchSize ?? 50, 50));
  const quotes: Quote[] = [];
  for (let i = 0; i < symbols.length; i += size) {
    const batch = symbols.slice(i, i + size);
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=' +
      EM_FIELDS +
      '&secids=' +
      encodeURIComponent(batch.map((s) => s.secid).join(','));
    const body = await getText(url, opts);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new QuoteError('东方财富返回的不是 JSON,可能是反爬页', 'parse');
    }
    const data = (parsed as { data?: { diff?: EastmoneyRow[] } | null }).data;
    if (!data || !Array.isArray(data.diff) || data.diff.length === 0) {
      throw new QuoteError('东方财富没有返回行情行', 'empty');
    }
    for (const row of data.diff) {
      const code = String(row.f12 ?? '');
      const ref = symbols.find((s) => s.code === code);
      const price = num(row.f2);
      const prevClose = num(row.f18);
      const change = num(row.f4);
      const changePct = num(row.f3);
      const stamp = num(row.f124);
      quotes.push({
        code,
        name: String(row.f14 ?? code),
        market: num(row.f13) === 1 ? 'sh' : ref?.market === 'bj' ? 'bj' : 'sz',
        price,
        prevClose,
        open: num(row.f17),
        high: num(row.f15),
        low: num(row.f16),
        change: price > 0 ? change : 0,
        changePct: price > 0 ? changePct : 0,
        volume: num(row.f5),
        amount: num(row.f6),
        at: stamp > 0 ? stamp * 1000 : null,
        source: 'eastmoney',
        suspended: price <= 0,
      });
    }
  }
  return quotes;
}

/** 同花顺 JSONP 存根:quotebridge_v6_time_hs_600519_last({...}) */
function unwrapJsonp(body: string): unknown {
  const trimmed = body.trim();
  const open = trimmed.indexOf('(');
  const close = trimmed.lastIndexOf(')');
  if (open < 0 || close <= open) throw new QuoteError('同花顺返回的不是 JSONP', 'parse');
  try {
    return JSON.parse(trimmed.slice(open + 1, close));
  } catch {
    throw new QuoteError('同花顺返回的分时数据解析失败', 'parse');
  }
}

/** 同花顺分时接口:data 是 `时间,价,金额,均价,量;` 拼成的串,取最后一笔有效价。 */
export async function fetchOneThs(ref: SymbolRef, opts: FetchQuotesOptions = {}): Promise<Quote> {
  if (ref.index) throw new QuoteError('同花顺这条路不支持指数,请用 eastmoney 或 auto', 'unsupported');
  const url = `https://d.10jqka.com.cn/v6/time/hs_${ref.code}/last.js`;
  const body = await getText(url, opts, THS_REFERER);
  const parsed = unwrapJsonp(body) as Record<string, unknown>;
  const node = (parsed[`hs_${ref.code}`] ?? Object.values(parsed)[0]) as Record<string, unknown> | undefined;
  if (!node) throw new QuoteError('同花顺没有这只票的分时数据', 'empty');
  const prevClose = num(node.pre);
  const series = typeof node.data === 'string' ? node.data : '';
  let price = 0;
  let high = 0;
  let low = 0;
  let volume = 0;
  let amount = 0;
  for (const seg of series.split(';')) {
    if (!seg) continue;
    const cells = seg.split(',');
    const p = num(cells[1]);
    if (p <= 0) continue;
    price = p;
    high = high > 0 ? Math.max(high, p) : p;
    low = low > 0 ? Math.min(low, p) : p;
    amount = Math.max(amount, num(cells[2]));
    volume = Math.max(volume, num(cells[4]));
  }
  const dateText = typeof node.date === 'string' ? node.date : '';
  const at = /^\d{8}$/.test(dateText) ? formatQuoteTime(dateText) : null;
  const change = price > 0 && prevClose > 0 ? price - prevClose : 0;
  return {
    code: ref.code,
    name: typeof node.name === 'string' ? node.name : ref.code,
    market: ref.market,
    price,
    prevClose,
    open: 0,
    high,
    low,
    change,
    changePct: prevClose > 0 ? (change / prevClose) * 100 : 0,
    volume,
    amount,
    at,
    source: 'ths',
    suspended: price <= 0,
  };
}

/** 并发上限固定的批处理,避免对同花顺一次打太多请求。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function fetchThs(symbols: readonly SymbolRef[], opts: FetchQuotesOptions = {}): Promise<Quote[]> {
  const rows = await mapLimit(symbols, 4, (ref) => fetchOneThs(ref, opts));
  return rows;
}

/**
 * 按 source 取行情。auto 先用东方财富(一次批量、字段全),整批失败再退同花顺(单只、慢)。
 * 两路都拿不到就抛出带 kind 的错误,调用方据此把「取不到」如实说出去。
 */
export async function fetchQuotes(
  symbols: readonly SymbolRef[],
  opts: FetchQuotesOptions = {},
): Promise<FetchQuotesResult> {
  if (!symbols.length) return { quotes: [], errors: [], source: null };
  const source = opts.source ?? 'auto';
  if (source === 'eastmoney' || source === 'auto') {
    try {
      const quotes = await fetchEastmoney(symbols, opts);
      return { quotes, errors: [], source: 'eastmoney' };
    } catch (err) {
      if (source === 'eastmoney') throw err;
    }
  }
  const errors: Array<{ raw: string; reason: string }> = [];
  const quotes: Quote[] = [];
  for (const ref of symbols) {
    try {
      quotes.push(await fetchOneThs(ref, opts));
    } catch (err) {
      errors.push({ raw: ref.raw, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!quotes.length) {
    throw new QuoteError(`两条路都没取到行情(${errors.map((e) => e.reason).join(';') || '无明细'})`, 'empty');
  }
  return { quotes, errors, source: 'ths' };
}
