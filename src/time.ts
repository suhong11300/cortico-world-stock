/**
 * 时区与交易时段的纯函数:不联网、不读盘,便于逐条测试。
 * 同时支持两个市场:cn(A 股,Asia/Shanghai)与 us(美股,America/New_York)。
 * 市场时区与交易时段一律按市场时区判定,与本机时区无关;本机时区只用于文案里的「你那边几点」。
 */

export type MarketId = 'cn' | 'us';

/** 各市场的交易所时区,固定值。 */
export const MARKET_ZONES: Record<MarketId, string> = {
  cn: 'Asia/Shanghai',
  us: 'America/New_York',
};

/** 兼容旧引用:A 股时区。 */
export const MARKET_ZONE = MARKET_ZONES.cn;

/** 市场中文名,出现在播报与回执里。 */
export const MARKET_LABELS: Record<MarketId, string> = {
  cn: 'A 股',
  us: '美股',
};

/** A 股交易时段:09:30-11:30、13:00-15:00。 */
export const MORNING_OPEN = 9 * 60 + 30;
export const MORNING_CLOSE = 11 * 60 + 30;
export const AFTERNOON_OPEN = 13 * 60;
export const AFTERNOON_CLOSE = 15 * 60;

/** 美股交易时段:09:30-16:00,中午不休息。 */
export const US_OPEN = 9 * 60 + 30;
export const US_CLOSE = 16 * 60;

/** 默认播报窗口:A 股早盘收盘与尾盘收盘前后各留 5 分钟;美股取收盘前后 5 分钟。 */
export const DEFAULT_WINDOWS_BY_MARKET: Record<MarketId, string> = {
  cn: '11:25-11:35,14:55-15:05',
  us: '15:55-16:05',
};

export const DEFAULT_WINDOWS = DEFAULT_WINDOWS_BY_MARKET.cn;

/** trading 只在美股出现(没有午休);A 股仍是 morning/afternoon 两段。 */
export type MarketPhase = 'weekend' | 'pre' | 'trading' | 'morning' | 'lunch' | 'afternoon' | 'closed';

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = 周日,6 = 周六。 */
  weekday: number;
}

const WEEKDAYS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** 时区名是否被运行时认识;认不出就退回市场时区,绝不猜一个错的时区。 */
export function isKnownZone(zone: string): boolean {
  if (!zone) return false;
  try {
    zoneParts(zone, new Date());
    return true;
  } catch {
    return false;
  }
}

/** 把某一时刻换算成给定时区的年月日时分秒。 */
export function zoneParts(zone: string, at: Date): ZoneParts {
  const parts = formatterFor(zone).formatToParts(at);
  const grab = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayIndex = WEEKDAYS.indexOf(grab('weekday'));
  return {
    year: Number(grab('year')),
    month: Number(grab('month')),
    day: Number(grab('day')),
    hour: Number(grab('hour')),
    minute: Number(grab('minute')),
    second: Number(grab('second')),
    weekday: weekdayIndex < 0 ? 0 : weekdayIndex,
  };
}

/** 该时区此刻相对 UTC 的偏移(分钟);东八区是 480。 */
export function zoneOffsetMinutes(zone: string, at: Date): number {
  const p = zoneParts(zone, at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const floored = Math.floor(at.getTime() / 1000) * 1000;
  return Math.round((asUtc - floored) / 60000);
}

export function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return 'UTC' + sign + hh + ':' + mm;
}

export function minutesOfDay(p: ZoneParts): number {
  return p.hour * 60 + p.minute;
}

export function dateKeyOf(p: ZoneParts): string {
  return (
    String(p.year).padStart(4, '0') +
    '-' +
    String(p.month).padStart(2, '0') +
    '-' +
    String(p.day).padStart(2, '0')
  );
}

export function stampOf(p: ZoneParts, withSeconds = true): string {
  const base =
    dateKeyOf(p) +
    ' ' +
    String(p.hour).padStart(2, '0') +
    ':' +
    String(p.minute).padStart(2, '0');
  return withSeconds ? base + ':' + String(p.second).padStart(2, '0') : base;
}

/** 交易时段判定;周末一律 weekend,节假日本函数认不出来,由调用方按「行情未变」兜底说明。 */
export function marketPhase(minutes: number, weekday: number, market: MarketId = 'cn'): MarketPhase {
  if (weekday === 0 || weekday === 6) return 'weekend';
  if (market === 'us') {
    if (minutes < US_OPEN) return 'pre';
    if (minutes < US_CLOSE) return 'trading';
    return 'closed';
  }
  if (minutes < MORNING_OPEN) return 'pre';
  if (minutes < MORNING_CLOSE) return 'morning';
  if (minutes < AFTERNOON_OPEN) return 'lunch';
  if (minutes < AFTERNOON_CLOSE) return 'afternoon';
  return 'closed';
}

export function phaseText(phase: MarketPhase): string {
  switch (phase) {
    case 'weekend':
      return '周末休市';
    case 'pre':
      return '盘前';
    case 'trading':
      return '盘中';
    case 'morning':
      return '早盘进行中';
    case 'lunch':
      return '午间休市';
    case 'afternoon':
      return '午盘进行中';
    case 'closed':
      return '已收盘';
  }
}

export function weekdayText(weekday: number): string {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday] ?? '未知';
}

export interface BriefWindow {
  /** 生效的分钟数范围,含两端。 */
  start: number;
  end: number;
  /** 配置里的原始写法,用于文案与打卡键。 */
  label: string;
  index: number;
}

/** '11:25-11:35,14:55-15:05' 解析成窗口表;认不出的段进 problems,不静默丢掉。 */
export function parseWindows(text: string): { windows: BriefWindow[]; problems: string[] } {
  const windows: BriefWindow[] = [];
  const problems: string[] = [];
  const chunk = text.replace(/[，、;；]/g, ',');
  for (const raw of chunk.split(',')) {
    const piece = raw.trim();
    if (!piece) continue;
    const m = /^(\d{1,2}):?(\d{2})\s*[-~—–至]\s*(\d{1,2}):?(\d{2})$/.exec(piece);
    if (!m) {
      problems.push(piece);
      continue;
    }
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    if (start > 1439 || end > 1439) {
      problems.push(piece);
      continue;
    }
    windows.push({ start, end, label: piece, index: windows.length + 1 });
  }
  return { windows, problems };
}

/** 此刻落在哪个窗口里;跨午夜的窗口(结束早于开始)也算命中。 */
export function matchWindow(windows: readonly BriefWindow[], minutes: number): BriefWindow | undefined {
  return windows.find((w) =>
    w.end >= w.start ? minutes >= w.start && minutes <= w.end : minutes >= w.start || minutes <= w.end,
  );
}

export function windowText(windows: readonly BriefWindow[]): string {
  return windows.map((w) => w.label).join('、');
}

/** 按本机时区猜市场:America/* 视作美股,其余算 A 股。 */
export function guessMarket(zone: string): MarketId {
  return /^America\//.test(zone) ? 'us' : 'cn';
}

export interface ClockInfo {
  /** 本机时区,来自部署配置;认不出时退回市场时区。 */
  zone: string;
  /** 生效市场。 */
  market: MarketId;
  /** 市场中文名。 */
  marketLabel: string;
  /** 市场时区:cn 为 Asia/Shanghai,us 为 America/New_York。 */
  marketZone: string;
  now: Date;
  /** 本机当地的「2026-10-26 15:30:12」。 */
  localText: string;
  /** 市场时区的「2026-10-26 15:30:12」。 */
  marketText: string;
  offsetLabel: string;
  dateKey: string;
  weekday: number;
  minutes: number;
  phase: MarketPhase;
  phaseText: string;
}

/** 每次 start / tick / 工具调用都重算一次:跨日、改时区、换市场都会自然反映出来。 */
export function resolveClock(zone: string, at: Date = new Date(), market: MarketId = 'cn'): ClockInfo {
  const safeMarket: MarketId = market === 'us' ? 'us' : 'cn';
  const marketZone = MARKET_ZONES[safeMarket];
  const safeZone = isKnownZone(zone) ? zone : marketZone;
  const marketParts = zoneParts(marketZone, at);
  const local = zoneParts(safeZone, at);
  const minutes = minutesOfDay(marketParts);
  const phase = marketPhase(minutes, marketParts.weekday, safeMarket);
  return {
    zone: safeZone,
    market: safeMarket,
    marketLabel: MARKET_LABELS[safeMarket],
    marketZone,
    now: at,
    localText: stampOf(local),
    marketText: stampOf(marketParts),
    offsetLabel: offsetLabel(zoneOffsetMinutes(marketZone, at)),
    dateKey: dateKeyOf(marketParts),
    weekday: marketParts.weekday,
    minutes,
    phase,
    phaseText: phaseText(phase),
  };
}
