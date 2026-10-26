import { describe, expect, it } from 'vitest';
import { fetchEastmoney, fetchEastmoneyOne, fetchOneThs, fetchQuotes, normalizeSymbol, parseSymbols } from '../src/quote.ts';
import { formatQuoteTime } from '../src/format.ts';

const EM_BODY = JSON.stringify({
  rc: 0,
  data: {
    total: 1,
    diff: [
      {
        f2: 1350,
        f3: 1.12,
        f4: 14.98,
        f5: 1000,
        f6: 200000000,
        f12: '600519',
        f13: 1,
        f14: '贵州茅台',
        f15: 1360,
        f16: 1330,
        f17: 1340,
        f18: 1335.02,
        f124: 1761000000,
      },
    ],
  },
});

const THS_BODY =
  'quotebridge_v6_time_hs_600519_last({"hs_600519":{"name":"贵州茅台","pre":"1335.00","date":"20261026","isTrading":1,' +
  '"rt":"0930-1130,1300-1500","data":"0930,1325.40,119948700,1325.400,90500;0931,1350.00,1,1350,1"}})';

/** 按 URL 分流的假 fetch:eastmoney 与 10jqka 各给一份。 */
function fakeFetch(handler: (url: string) => Response): typeof globalThis.fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof globalThis.fetch;
}

const ok = (body: string) => new Response(body, { status: 200 });

describe('代码归一化', () => {
  it('裸六位数按首位判交易所', () => {
    expect(normalizeSymbol('600519')).toEqual({ code: '600519', market: 'sh', secid: '1.600519', raw: '600519', index: false });
    expect(normalizeSymbol('000001')?.secid).toBe('0.000001');
    expect(normalizeSymbol('300750')?.market).toBe('sz');
    expect(normalizeSymbol('430047')?.market).toBe('bj');
    expect(normalizeSymbol('510300')?.market).toBe('sh');
  });

  it('带前缀、后缀与 secid 写法都认', () => {
    expect(normalizeSymbol('sh600519')?.secid).toBe('1.600519');
    expect(normalizeSymbol('SZ000001')?.market).toBe('sz');
    expect(normalizeSymbol('600519.SH')?.secid).toBe('1.600519');
    expect(normalizeSymbol('0.000001')?.market).toBe('sz');
    expect(normalizeSymbol('1.600519')?.market).toBe('sh');
  });

  it('INDEX: 前缀标出指数', () => {
    const ref = normalizeSymbol('INDEX:sh000001');
    expect(ref?.index).toBe(true);
    expect(ref?.code).toBe('000001');
    expect(ref?.secid).toBe('1.000001');
  });

  it('认不出的给 null', () => {
    expect(normalizeSymbol('')).toBeNull();
    expect(normalizeSymbol('abc')).toBeNull();
    expect(normalizeSymbol('12345')).toBeNull();
    expect(normalizeSymbol('600519.SZ.SH')).toBeNull();
  });

  it('parseSymbols 去重并把认不出的列出来', () => {
    const { symbols, problems } = parseSymbols('600519, 600519, 000001 sz000001 乱码');
    expect(symbols.map((s) => s.secid)).toEqual(['1.600519', '0.000001']);
    expect(problems).toEqual(['乱码']);
  });
});

describe('东方财富', () => {
  it('批量取数并映射字段', async () => {
    let seen = '';
    const quotes = await fetchEastmoney([normalizeSymbol('600519')!], {
      fetchImpl: fakeFetch((url) => {
        seen = url;
        return ok(EM_BODY);
      }),
    });
    expect(seen).toContain('secids=1.600519');
    expect(seen).toContain('fltt=2');
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      code: '600519',
      name: '贵州茅台',
      market: 'sh',
      price: 1350,
      prevClose: 1335.02,
      change: 14.98,
      changePct: 1.12,
      at: 1761000000000,
      source: 'eastmoney',
      suspended: false,
    });
  });

  it('价格为 0 记成停牌且涨跌清零', async () => {
    const body = JSON.stringify({ data: { diff: [{ f12: '600519', f2: 0, f3: 0, f4: 0, f13: 1, f14: '贵州茅台', f18: 1335.02, f124: 0 }] } });
    const quotes = await fetchEastmoney([normalizeSymbol('600519')!], { fetchImpl: fakeFetch(() => ok(body)) });
    expect(quotes[0]?.suspended).toBe(true);
    expect(quotes[0]?.at).toBeNull();
    expect(quotes[0]?.change).toBe(0);
  });

  it('空列表直接返回,不发请求', async () => {
    let called = 0;
    const quotes = await fetchEastmoney([], {
      fetchImpl: fakeFetch(() => {
        called += 1;
        return ok(EM_BODY);
      }),
    });
    expect(quotes).toEqual([]);
    expect(called).toBe(0);
  });

  it('返回非 JSON 时报 parse 类错误', async () => {
    await expect(
      fetchEastmoney([normalizeSymbol('600519')!], { fetchImpl: fakeFetch(() => ok('<html>反爬</html>')) }),
    ).rejects.toThrow('东方财富返回的不是 JSON');
  });

  it('没有行情行时报 empty', async () => {
    await expect(
      fetchEastmoney([normalizeSymbol('600519')!], { fetchImpl: fakeFetch(() => ok(JSON.stringify({ data: null }))) }),
    ).rejects.toThrow('东方财富没有返回行情行');
  });

  it('HTTP 非 200 抛错', async () => {
    await expect(
      fetchEastmoney([normalizeSymbol('600519')!], { fetchImpl: fakeFetch(() => new Response('no', { status: 502 })) }),
    ).rejects.toThrow('HTTP 502');
  });
});

describe('同花顺', () => {
  it('从分时 JSONP 取最后一笔有效价', async () => {
    let seenReferer = '';
    const quote = await fetchOneThs(normalizeSymbol('600519')!, {
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        seenReferer = String((init?.headers as Record<string, string>)?.Referer ?? '');
        return ok(THS_BODY);
      }) as unknown as typeof globalThis.fetch,
    });
    expect(seenReferer).toBe('https://stockpage.10jqka.com.cn/');
    expect(quote).toMatchObject({ code: '600519', name: '贵州茅台', price: 1350, prevClose: 1335, source: 'ths' });
    expect(quote.change).toBe(15);
    expect(quote.changePct).toBeCloseTo(1.1236, 3);
    expect(quote.at).toBe(formatQuoteTime('20261026'));
  });

  it('指数这条路不支持', async () => {
    await expect(fetchOneThs(normalizeSymbol('INDEX:sh000001')!)).rejects.toThrow('不支持指数');
  });
});

describe('两路取数', () => {
  it('auto 优先东方财富', async () => {
    const result = await fetchQuotes([normalizeSymbol('600519')!], { fetchImpl: fakeFetch(() => ok(EM_BODY)) });
    expect(result.source).toBe('eastmoney');
    expect(result.errors).toEqual([]);
  });

  it('东方财富挂了就退同花顺', async () => {
    const result = await fetchQuotes([normalizeSymbol('600519')!], {
      fetchImpl: fakeFetch((url) => (url.includes('eastmoney') ? new Response('no', { status: 503 }) : ok(THS_BODY))),
    });
    expect(result.source).toBe('ths');
    expect(result.quotes[0]?.price).toBe(1350);
  });

  it('指定单一源失败就抛,不静默为空', async () => {
    await expect(
      fetchQuotes([normalizeSymbol('600519')!], {
        source: 'eastmoney',
        fetchImpl: fakeFetch(() => new Response('no', { status: 500 })),
      }),
    ).rejects.toThrow('HTTP 500');
  });

  it('两路都取不到时抛 empty 并带明细', async () => {
    await expect(
      fetchQuotes([normalizeSymbol('600519')!], {
        fetchImpl: fakeFetch(() => new Response('no', { status: 500 })),
      }),
    ).rejects.toThrow('两条路都没取到行情');
  });

  it('空列表不发请求', async () => {
    const result = await fetchQuotes([]);
    expect(result).toEqual({ quotes: [], errors: [], source: null });
  });
});
describe('美股指数', () => {
  it('字母代码归一化成 100.<CODE>', () => {
    expect(normalizeSymbol('DJIA')).toMatchObject({ code: 'DJIA', market: 'us', secid: '100.DJIA' });
    expect(normalizeSymbol('100.SPX')).toMatchObject({ code: 'SPX', market: 'us', secid: '100.SPX' });
    expect(normalizeSymbol('US.NDX')).toMatchObject({ code: 'NDX', market: 'us', secid: '100.NDX' });
    expect(normalizeSymbol('INDEX:DJIA')).toMatchObject({ code: 'DJIA', index: true });
  });

  it('DJI 认成 DJIA,小写字母代码不认', () => {
    expect(normalizeSymbol('DJI')?.code).toBe('DJIA');
    expect(normalizeSymbol('IXIC')?.code).toBe('NDX');
    expect(normalizeSymbol('djia')).toBeNull();
  });

  it('和 A 股混写也能分开', () => {
    const { symbols, problems } = parseSymbols('sh000001,DJIA 600519');
    expect(symbols.map((s) => s.secid)).toEqual(['1.000001', '100.DJIA', '1.600519']);
    expect(problems).toEqual([]);
  });

  it('东财按 100.DJIA 取美股,market 记成 us', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({ data: { diff: [{ f2: 52215.16, f3: -1.23, f4: -650, f12: "DJIA", f13: 100, f14: "道琼斯", f124: 1761000000 }] } }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;
    const ref = normalizeSymbol('DJIA');
    if (!ref) throw new Error('DJIA 应该能归一化');
    const quotes = await fetchEastmoney([ref], { fetchImpl });
    expect(urls[0]).toContain('100.DJIA');
    expect(quotes[0]).toMatchObject({ code: 'DJIA', name: '道琼斯', market: 'us', price: 52215.16 });
  });

  it('同花顺这条路不收美股指数', async () => {
    const ref = normalizeSymbol('DJIA');
    if (!ref) throw new Error('DJIA 应该能归一化');
    await expect(fetchOneThs(ref)).rejects.toThrow('美股指数请用 eastmoney');
  });
});

describe('东财单只接口兜底', () => {
  /** 批量接口被掐断(实测有网络会直接 RST),单只 stock/get 还能用。 */
  const mixed = (seen: string[]): typeof globalThis.fetch =>
    (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('ulist.np')) throw new TypeError('fetch failed');
      const secid = new URL(url).searchParams.get('secid') ?? '';
      const code = secid.split('.')[1] ?? '';
      return new Response(
        JSON.stringify({
          data: {
            f43: 3697.52,
            f44: 3699.01,
            f45: 3664.82,
            f46: 3671,
            f47: 432794318,
            f48: 746528025716.4,
            f57: code,
            f58: '上证指数',
            f60: 3690.48,
            f86: 1793001570,
            f169: 7.04,
            f170: 0.19,
          },
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

  it('批量失败就逐只走 stock/get', async () => {
    const seen: string[] = [];
    const refs = parseSymbols('sh000001,sz399001').symbols;
    const quotes = await fetchEastmoney(refs, { fetchImpl: mixed(seen) });
    expect(quotes).toHaveLength(2);
    expect(seen[0]).toContain('ulist.np');
    expect(seen.some((u) => u.includes('stock/get'))).toBe(true);
    expect(quotes[0]).toMatchObject({
      code: '000001',
      name: '上证指数',
      price: 3697.52,
      prevClose: 3690.48,
      open: 3671,
      high: 3699.01,
      low: 3664.82,
      change: 7.04,
      changePct: 0.19,
      source: 'eastmoney',
      suspended: false,
    });
    expect(quotes[0]?.at).toBe(1793001570000);
  });

  it('单只请求带 fltt=2 与 secid', async () => {
    const seen: string[] = [];
    const ref = parseSymbols('600519').symbols[0];
    if (!ref) throw new Error('600519 应该能归一化');
    await fetchEastmoneyOne(ref, { fetchImpl: mixed(seen) });
    expect(seen[0]).toContain('fltt=2');
    expect(seen[0]).toContain('secid=1.600519');
  });

  it('两条路都失败才抛错,且抛的是批量那条', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 502 })) as unknown as typeof globalThis.fetch;
    await expect(fetchEastmoney(parseSymbols('600519').symbols, { fetchImpl })).rejects.toThrow('HTTP 502');
  });
});
