import { describe, expect, it } from 'vitest';
import { askText, composeBrief, toneOf } from '../src/copy.ts';
import type { Quote } from '../src/quote.ts';
import { resolveClock, type ClockInfo } from '../src/time.ts';

const CLOCK = resolveClock('Asia/Shanghai', new Date('2026-10-26T03:29:00Z'));

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

function clock(over: Partial<ClockInfo> = {}): ClockInfo {
  return { ...CLOCK, ...over };
}

describe('涨跌分档', () => {
  it('活泼档按阈值给表情', () => {
    expect(toneOf(10).emoji).toBe('🀄');
    expect(toneOf(9.8).emoji).toBe('🀄');
    expect(toneOf(6).emoji).toBe('🚀');
    expect(toneOf(2.5).emoji).toBe('📈');
    expect(toneOf(0.5).emoji).toBe('🌤');
    expect(toneOf(0).emoji).toBe('😴');
    expect(toneOf(-0.5).emoji).toBe('🌧');
    expect(toneOf(-3).emoji).toBe('☁️');
    expect(toneOf(-6).emoji).toBe('🩹');
    expect(toneOf(-10).emoji).toBe('🫂');
  });

  it('平盘区间不吃掉微小涨跌', () => {
    expect(toneOf(0.004).phrase).toBe('原地踏步,躺着');
    expect(toneOf(-0.004).phrase).toBe('原地踏步,躺着');
    expect(toneOf(0.006).emoji).toBe('🌤');
    expect(toneOf(-0.006).emoji).toBe('🌧');
  });

  it('克制档不带表情', () => {
    expect(toneOf(6, 'calm').emoji).toBe('');
    expect(toneOf(6, 'calm').phrase).toBe('大幅上涨');
    expect(toneOf(-10, 'calm').phrase).toBe('跌停');
  });
});

describe('追问文案', () => {
  it('带称呼', () => {
    expect(askText('鸿')).toBe('请问鸿,需要查看吗?');
  });

  it('空称呼退回「你」', () => {
    expect(askText('   ')).toBe('请问你,需要查看吗?');
  });
});

describe('播报文案', () => {
  it('窗口播报带标题、时间、大盘与逐只行情', () => {
    const text = composeBrief({
      clock: clock(),
      window: { start: 685, end: 695, label: '11:25-11:35', index: 1 },
      quotes: [
        quote(),
        quote({ code: '000001', name: '平安银行', market: 'sz', price: 11.2, change: -0.2, changePct: -1.75 }),
      ],
      indices: [quote({ code: '000001', name: '上证指数', market: 'sh', price: 3697.52, changePct: 0.42 })],
      account: null,
      user: '鸿',
      style: 'lively',
    });
    expect(text).toContain('🐱 拟股喵喵 · 11:25-11:35 播报');
    expect(text).toContain('🕚 北京时间 2026-10-26 11:29:00(周一)');
    expect(text).toContain('📊 市场状态:早盘进行中');
    expect(text).toContain('📉 大盘:上证指数 3,697.52 +0.42%');
    expect(text).toContain('🔎 关注 2 只:涨 1、跌 1、平 0');
    expect(text).toContain('🌤 贵州茅台 600519 1,350.00 ▲1.12% +14.98 · 微红,还行');
    expect(text).toContain('🌧 平安银行 000001 11.20 ▼1.75% -0.20 · 微绿,正常波动');
    expect(text).toContain('💧 成交额合计');
  });

  it('没有窗口时叫即时播报', () => {
    const text = composeBrief({
      clock: clock(),
      quotes: [quote()],
      indices: [],
      account: null,
      user: '',
      style: 'lively',
    });
    expect(text).toContain('🐱 拟股喵喵 · 即时播报');
    expect(text).not.toContain('📉 大盘');
  });

  it('关注列表为空时给下一步,而不是空白', () => {
    const text = composeBrief({ clock: clock(), quotes: [], indices: [], account: null, user: '', style: 'lively' });
    expect(text).toContain('关注列表是空的');
    expect(text).toContain('stock_watch');
  });

  it('异时区额外写一行当地时刻', () => {
    const ny = resolveClock('America/New_York', new Date('2026-10-26T03:29:00Z'));
    const text = composeBrief({ clock: ny, quotes: [], indices: [], account: null, user: '', style: 'lively' });
    expect(text).toContain('🌏 你那边 America/New_York 2026-10-25 23:29:00');
  });

  it('停牌的行写成停牌,不算涨跌', () => {
    const text = composeBrief({
      clock: clock(),
      quotes: [quote({ suspended: true, price: 0, change: 0, changePct: 0 })],
      indices: [],
      account: null,
      user: '',
      style: 'lively',
    });
    expect(text).toContain('⏸ 贵州茅台 600519 停牌/无报价');
    expect(text).toContain('涨 0、跌 0、平 0');
    expect(text).not.toContain('💧 成交额合计');
  });

  it('持仓只报市值与浮盈,缺成本就说明', () => {
    const withCost = composeBrief({
      clock: clock(),
      quotes: [quote()],
      indices: [],
      account: { positions: [], marketValue: 135000, costValue: 130050, pnl: 4950, pnlPct: 3.81, missing: [] },
      user: '',
      style: 'lively',
    });
    expect(withCost).toContain('💰 持仓 市值 ¥135,000.00 · 浮盈 ¥+4950.00 (+3.81%)');
    const noCost = composeBrief({
      clock: clock(),
      quotes: [quote()],
      indices: [],
      account: { positions: [], marketValue: 135000, costValue: 0, pnl: 0, pnlPct: 0, missing: [] },
      user: '',
      style: 'lively',
    });
    expect(noCost).toContain('未填成本价,只报市值');
  });

  it('取不到的行如实列在末尾', () => {
    const text = composeBrief({
      clock: clock(),
      quotes: [quote()],
      indices: [],
      account: { positions: [], marketValue: 0, costValue: 0, pnl: 0, pnlPct: 0, missing: ['300750'] },
      user: '',
      style: 'lively',
      problems: ['300750 超时'],
    });
    expect(text).toContain('❓ 缺行情:300750');
    expect(text).toContain('⚠️ 没取到:300750 超时');
  });
});