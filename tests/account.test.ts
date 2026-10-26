import { describe, expect, it } from 'vitest';
import { buildBook, parseHoldings, parseHoldingsTable } from '../src/account.ts';
import type { Quote } from '../src/quote.ts';

const CRLF = String.fromCharCode(10);

function quote(over: Partial<Quote> = {}): Quote {
  return {
    code: '600519',
    name: '贵州茅台',
    market: 'sh',
    price: 1350,
    prevClose: 1335.02,
    open: 1340,
    high: 1360,
    low: 1330,
    change: 14.98,
    changePct: 1.12,
    volume: 1000,
    amount: 200000000,
    at: 1761000000000,
    source: 'eastmoney',
    suspended: false,
    ...over,
  };
}

describe('手填持仓', () => {
  it('认代码:股数:成本', () => {
    const { holdings, problems } = parseHoldings('600519:100:1300.5');
    expect(problems).toEqual([]);
    expect(holdings).toEqual([{ code: '600519', shares: 100, cost: 1300.5 }]);
  });

  it('省掉成本价就是 0', () => {
    const { holdings } = parseHoldings('600519:100, 000001:2000');
    expect(holdings).toHaveLength(2);
    expect(holdings[1]).toEqual({ code: '000001', shares: 2000, cost: 0 });
  });

  it('全角冒号、分号、换行都能断行', () => {
    const text = ['600519：100：1300', '000001 2000 10.5'].join(CRLF) + '；300750:300';
    const { holdings, problems } = parseHoldings(text);
    expect(problems).toEqual([]);
    expect(holdings.map((h) => h.code)).toEqual(['600519', '000001', '300750']);
  });

  it('认不出的段进 problems,不猜', () => {
    const { holdings, problems } = parseHoldings('乱写,600519:0,600519:100:abc');
    expect(holdings).toEqual([]);
    expect(problems).toEqual(['乱写', '600519:0', '600519:100:abc']);
  });
});

describe('持仓表', () => {
  it('有表头就按表头找列', () => {
    const text = ['证券代码,持仓数量,成本价', '600519,100,1300.5', '000001,2000,10.5'].join(CRLF);
    const { holdings, problems } = parseHoldingsTable(text);
    expect(problems).toEqual([]);
    expect(holdings).toEqual([
      { code: '600519', shares: 100, cost: 1300.5 },
      { code: '000001', shares: 2000, cost: 10.5 },
    ]);
  });

  it('没有表头时按位置取', () => {
    const { holdings } = parseHoldingsTable('600519,100,1300.5');
    expect(holdings).toEqual([{ code: '600519', shares: 100, cost: 1300.5 }]);
  });

  it('带货币符号的单元格也能读', () => {
    const text = ['代码,数量,成本', '600519,100,"¥1,300.50"'].join(CRLF);
    const { holdings } = parseHoldingsTable(text);
    expect(holdings[0]?.cost).toBe(1300.5);
  });

  it('坏行进 problems', () => {
    const text = ['代码,数量,成本', '600519,0,1', 'abc,100,1'].join(CRLF);
    const { holdings, problems } = parseHoldingsTable(text);
    expect(holdings).toEqual([]);
    expect(problems).toHaveLength(2);
  });
});

describe('持仓折算', () => {
  it('按现价算市值、成本与浮盈', () => {
    const book = buildBook([{ code: '600519', shares: 100, cost: 1300 }], [quote()], 'eastmoney');
    expect(book.marketValue).toBe(135000);
    expect(book.costValue).toBe(130000);
    expect(book.pnl).toBe(5000);
    expect(book.pnlPct).toBeCloseTo(3.8462, 3);
    expect(book.missing).toEqual([]);
    expect(book.positions[0]?.name).toBe('贵州茅台');
    expect(book.positions[0]?.source).toBe('eastmoney');
  });

  it('停牌按昨收折市值', () => {
    const book = buildBook([{ code: '600519', shares: 100, cost: 1300 }], [quote({ suspended: true, price: 0 })], 'eastmoney');
    expect(book.marketValue).toBeCloseTo(133502, 0);
    expect(book.positions[0]?.price).toBe(1335.02);
  });

  it('没填成本价就只算市值', () => {
    const book = buildBook([{ code: '600519', shares: 100, cost: 0 }], [quote()], 'eastmoney');
    expect(book.marketValue).toBe(135000);
    expect(book.costValue).toBe(0);
    expect(book.pnl).toBe(0);
    expect(book.positions[0]?.pnl).toBeNull();
    expect(book.positions[0]?.pnlPct).toBeNull();
  });

  it('缺行情的持仓点名进 missing', () => {
    const book = buildBook([
      { code: '600519', shares: 100, cost: 1300 },
      { code: '300750', shares: 200, cost: 200 },
    ], [quote()], 'eastmoney');
    expect(book.missing).toEqual(['300750']);
    expect(book.marketValue).toBe(135000);
    expect(book.positions).toHaveLength(1);
  });
});