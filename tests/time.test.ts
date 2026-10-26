import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOWS,
  MARKET_ZONE,
  marketPhase,
  matchWindow,
  offsetLabel,
  parseWindows,
  resolveClock,
  weekdayText,
} from '../src/time.ts';

/** 2026-10-26 是周一。UTC 03:29 = 北京 11:29,03:30 = 11:30。 */
const MON_1129 = new Date('2026-10-26T03:29:00Z');
const MON_1130 = new Date('2026-10-26T03:30:00Z');

describe('市场时钟', () => {
  it('按北京时间给出日期与时刻', () => {
    const clock = resolveClock(MARKET_ZONE, MON_1129);
    expect(clock.marketText).toBe('2026-10-26 11:29:00');
    expect(clock.dateKey).toBe('2026-10-26');
    expect(clock.minutes).toBe(689);
    expect(clock.phase).toBe('morning');
    expect(clock.phaseText).toBe('早盘进行中');
    expect(clock.offsetLabel).toBe('UTC+08:00');
    expect(clock.marketZone).toBe('Asia/Shanghai');
  });

  it('11:30 整已经算午间休市', () => {
    const clock = resolveClock(MARKET_ZONE, MON_1130);
    expect(clock.marketText).toBe('2026-10-26 11:30:00');
    expect(clock.phase).toBe('lunch');
  });

  it('异时区同时给出当地与北京两个时刻', () => {
    const clock = resolveClock('America/New_York', MON_1129);
    expect(clock.zone).toBe('America/New_York');
    expect(clock.marketText).toBe('2026-10-26 11:29:00');
    expect(clock.localText).toBe('2026-10-25 23:29:00');
  });

  it('认不出的时区退回市场时区', () => {
    expect(resolveClock('Mars/Olympus', MON_1129).zone).toBe(MARKET_ZONE);
    expect(resolveClock('', MON_1129).zone).toBe(MARKET_ZONE);
  });

  it('周末一律休市', () => {
    const saturday = new Date('2026-10-24T03:29:00Z');
    expect(resolveClock(MARKET_ZONE, saturday).phase).toBe('weekend');
  });

  it('跨过北京零点时日期跟着翻页', () => {
    const clock = resolveClock(MARKET_ZONE, new Date('2026-10-26T17:00:00Z'));
    expect(clock.dateKey).toBe('2026-10-27');
    expect(clock.marketText).toBe('2026-10-27 01:00:00');
    expect(clock.phase).toBe('pre');
  });
});

describe('交易时段判定', () => {
  it('按分钟数分段', () => {
    expect(marketPhase(569, 1)).toBe('pre');
    expect(marketPhase(570, 1)).toBe('morning');
    expect(marketPhase(689, 1)).toBe('morning');
    expect(marketPhase(690, 1)).toBe('lunch');
    expect(marketPhase(779, 1)).toBe('lunch');
    expect(marketPhase(780, 1)).toBe('afternoon');
    expect(marketPhase(899, 1)).toBe('afternoon');
    expect(marketPhase(900, 1)).toBe('closed');
    expect(marketPhase(600, 6)).toBe('weekend');
    expect(marketPhase(600, 0)).toBe('weekend');
  });

  it('星期文案对上', () => {
    expect(weekdayText(1)).toBe('周一');
    expect(weekdayText(0)).toBe('周日');
    expect(weekdayText(9)).toBe('未知');
  });
});

describe('播报窗口', () => {
  it('默认两段都能解析', () => {
    const { windows, problems } = parseWindows(DEFAULT_WINDOWS);
    expect(problems).toEqual([]);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ start: 685, end: 695, label: '11:25-11:35', index: 1 });
    expect(windows[1]).toEqual({ start: 895, end: 905, label: '14:55-15:05', index: 2 });
  });

  it('中文逗号顿号与波浪号都认', () => {
    const { windows, problems } = parseWindows('9:25-9:35，13:00~13:05、14时');
    expect(problems).toEqual(['14时']);
    expect(windows.map((w) => w.label)).toEqual(['9:25-9:35', '13:00~13:05']);
  });

  it('认不出的段进 problems 而不是被吞掉', () => {
    const { windows, problems } = parseWindows('早盘,11:25-11:35');
    expect(windows).toHaveLength(1);
    expect(problems).toEqual(['早盘']);
  });

  it('超出一天的分钟数算配置错误', () => {
    expect(parseWindows('25:00-26:00').problems).toEqual(['25:00-26:00']);
  });

  it('命中判定含两端', () => {
    const { windows } = parseWindows('11:25-11:35');
    expect(matchWindow(windows, 685)?.index).toBe(1);
    expect(matchWindow(windows, 690)?.index).toBe(1);
    expect(matchWindow(windows, 695)?.index).toBe(1);
    expect(matchWindow(windows, 684)).toBeUndefined();
    expect(matchWindow(windows, 696)).toBeUndefined();
  });

  it('跨午夜的窗口也算命中', () => {
    const { windows } = parseWindows('23:30-00:30');
    expect(windows[0]).toEqual({ start: 1410, end: 30, label: '23:30-00:30', index: 1 });
    expect(matchWindow(windows, 1420)?.index).toBe(1);
    expect(matchWindow(windows, 20)?.index).toBe(1);
    expect(matchWindow(windows, 600)).toBeUndefined();
  });

  it('偏移标签带 UTC 前缀', () => {
    expect(offsetLabel(480)).toBe('UTC+08:00');
    expect(offsetLabel(-300)).toBe('UTC-05:00');
  });
});