/** 播报文案:分档决定表情与口语,数字一律来自行情,不编造。 */
import type { Quote } from './quote.ts';
import type { BookSummary } from './account.ts';
import { amountText, money, percent, signed } from './format.ts';
import { phaseText, weekdayText, type BriefWindow, type ClockInfo } from './time.ts';

export type BriefStyle = 'lively' | 'calm';

export interface Tone {
  emoji: string;
  phrase: string;
}

/** 涨跌幅分档:阈值和口语都在这一处,文案与测试共用。 */
export function toneOf(pct: number, style: BriefStyle = 'lively'): Tone {
  const lively = style === 'lively';
  if (pct >= 9.8) return { emoji: lively ? '🀄' : '', phrase: lively ? '一字封板,牛到冒烟' : '涨停' };
  if (pct >= 5) return { emoji: lively ? '🚀' : '', phrase: lively ? '冲得有点猛' : '大幅上涨' };
  if (pct >= 2) return { emoji: lively ? '📈' : '', phrase: lively ? '稳步往上走' : '上涨' };
  if (pct > 0.005) return { emoji: lively ? '🌤' : '', phrase: lively ? '微红,还行' : '小幅上涨' };
  if (pct < -9.8) return { emoji: lively ? '🫂' : '', phrase: lively ? '跌停…抱抱,别慌' : '跌停' };
  if (pct < -5) return { emoji: lively ? '🩹' : '', phrase: lively ? '跌得有点心疼' : '大幅下跌' };
  if (pct < -2) return { emoji: lively ? '☁️' : '', phrase: lively ? '有点凉,加件外套' : '下跌' };
  if (pct < -0.005) return { emoji: lively ? '🌧' : '', phrase: lively ? '微绿,正常波动' : '小幅下跌' };
  return { emoji: lively ? '😴' : '', phrase: lively ? '原地踏步,躺着' : '平盘' };
}

/** 播报后那句追问,用户名来自配置或部署里的 user 字段。 */
export function askText(user: string): string {
  const name = user.trim() || '你';
  return `请问${name},需要查看吗?`;
}

export interface BriefInput {
  clock: ClockInfo;
  window?: BriefWindow;
  quotes: readonly Quote[];
  indices: readonly Quote[];
  account: BookSummary | null;
  user: string;
  style: BriefStyle;
  /** 取不到的行,如实列出来。 */
  problems?: readonly string[];
}

function ratioLine(quotes: readonly Quote[]): string {
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const q of quotes) {
    if (q.suspended) continue;
    if (q.changePct > 0.005) up += 1;
    else if (q.changePct < -0.005) down += 1;
    else flat += 1;
  }
  return `${quotes.length} 只:涨 ${up}、跌 ${down}、平 ${flat}`;
}

function quoteLine(q: Quote, style: BriefStyle): string {
  const tone = toneOf(q.changePct, style);
  const arrow = q.changePct > 0.005 ? '▲' : q.changePct < -0.005 ? '▼' : '＝';
  const head = tone.emoji ? `${tone.emoji} ` : '';
  return `${head}${q.name} ${q.code} ${money(q.price)} ${arrow}${Math.abs(q.changePct).toFixed(2)}% ${signed(q.change)} · ${tone.phrase}`;
}

function indexLine(indices: readonly Quote[]): string | null {
  if (!indices.length) return null;
  return indices.map((q) => `${q.name} ${money(q.price)} ${percent(q.changePct)}`).join(' · ');
}

function accountLine(account: BookSummary): string {
  const parts = [`市值 ¥${money(account.marketValue)}`];
  if (account.costValue > 0) {
    parts.push(`浮盈 ¥${signed(account.pnl)} (${percent(account.pnlPct)})`);
  } else {
    parts.push('未填成本价,只报市值');
  }
  return parts.join(' · ');
}

/** 一次播报的完整文案:头部时间、大盘、关注个股、账户,末尾写清取不到的行。 */
export function composeBrief(input: BriefInput): string {
  const { clock, quotes, indices, account, style } = input;
  const title = input.window ? `${input.window.label} 播报` : '即时播报';
  const lines: string[] = [];
  lines.push(`🐱 拟股喵喵 · ${title}`);
  lines.push(`🕚 北京时间 ${clock.marketText}(${weekdayText(clock.weekday)})`);
  if (clock.zone !== clock.marketZone) {
    lines.push(`🌏 你那边 ${clock.zone} ${clock.localText}`);
  }
  lines.push(`📊 市场状态:${phaseText(clock.phase)}`);
  const idx = indexLine(indices);
  if (idx) lines.push(`📉 大盘:${idx}`);
  if (!quotes.length) {
    lines.push('🔎 关注列表是空的:先在配置里填关注股票,或者让我用 stock_watch 加几只。');
  } else {
    lines.push(`🔎 关注 ${ratioLine(quotes)}`);
    for (const q of quotes) {
      lines.push(q.suspended ? `⏸ ${q.name} ${q.code} 停牌/无报价` : quoteLine(q, style));
    }
    const total = quotes.reduce((sum, q) => sum + (q.suspended ? 0 : q.amount), 0);
    if (total > 0) lines.push(`💧 成交额合计 ${amountText(total)}`);
  }
  if (account) {
    lines.push(`💰 持仓 ${accountLine(account)}`);
    if (account.missing.length) lines.push(`❓ 缺行情:${account.missing.join('、')}`);
  }
  if (input.problems?.length) {
    lines.push(`⚠️ 没取到:${input.problems.join('、')}`);
  }
  return lines.join('\n');
}
