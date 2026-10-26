/**
 * 账户数据接入:只读「你自己填的」或「你自己导出的」持仓,不登录券商、不碰交易接口。
 * 三种模式由配置决定:关、手填、读文件(同花顺/东财导出的 CSV 都认)。
 */
import { readFileSync } from 'node:fs';
import { normalizeSymbol, type Quote, type SymbolRef } from './quote.ts';

export type AccountMode = 'none' | 'manual' | 'csv';

export interface Holding {
  /** 6 位代码。 */
  code: string;
  /** 股数,允许小数以兼容场内基金。 */
  shares: number;
  /** 成本价;0 表示没填,盈亏就只报市值。 */
  cost: number;
}

export interface HoldingParse {
  holdings: Holding[];
  problems: string[];
}

/** `600519:100:1300.5, sz000001:2000:10.5` 或每行一条;也认 制表符/竖线 分隔。 */
export function parseHoldings(text: string): HoldingParse {
  const holdings: Holding[] = [];
  const problems: string[] = [];
  const rows = text.split(/[\n\r;；]+/);
  for (const row of rows) {
    const line = row.trim();
    if (!line) continue;
    for (const piece of line.split(/[,，、|\t]+/)) {
      const cell = piece.trim();
      if (!cell) continue;
      const parts = cell.split(/[:：\s]+/).filter(Boolean);
      if (parts.length < 2) {
        problems.push(cell);
        continue;
      }
      const ref = normalizeSymbol(parts[0]);
      const shares = Number(parts[1]);
      const cost = parts.length > 2 ? Number(parts[2]) : 0;
      if (!ref || !Number.isFinite(shares) || shares <= 0) {
        problems.push(cell);
        continue;
      }
      if (!Number.isFinite(cost) || cost < 0) {
        problems.push(cell);
        continue;
      }
      holdings.push({ code: ref.code, shares, cost });
    }
  }
  return { holdings, problems };
}

/** 同花顺/东财导出的持仓表:有表头就按表头找列,没有就按 代码,数量,成本 的位置。 */
export function parseHoldingsTable(text: string): HoldingParse {
  const holdings: Holding[] = [];
  const problems: string[] = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) return { holdings, problems };
  const splitCells = (line: string): string[] => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch !== '"') {
          cell += ch;
          continue;
        }
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
          continue;
        }
        quoted = false;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        continue;
      }
      if (ch === ',' || ch === '\t' || ch === ';') {
        cells.push(cell.trim());
        cell = '';
        continue;
      }
      cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  };
  const first = splitCells(lines[0]);
  const isHeader = !/^\d{6}$/.test(first[0] ?? '') && !/[0-9]{6}/.test(first[0] ?? '');
  let codeAt = 0;
  let sharesAt = 1;
  let costAt = 2;
  let start = 0;
  if (isHeader) {
    start = 1;
    const find = (patterns: RegExp, fallback: number): number => {
      const index = first.findIndex((cell) => patterns.test(cell));
      return index >= 0 ? index : fallback;
    };
    codeAt = find(/代码|code|证券|symbol/i, 0);
    sharesAt = find(/数量|股数|持仓|shares|qty|amount/i, 1);
    costAt = find(/成本|均价|cost|price/i, 2);
  }
  for (let i = start; i < lines.length; i += 1) {
    const cells = splitCells(lines[i]);
    const ref = normalizeSymbol(cells[codeAt] ?? '');
    const shares = Number(cells[sharesAt] ?? '');
    const cost = Number((cells[costAt] ?? '').replace(/[^\d.\-]/g, ''));
    if (!ref || !Number.isFinite(shares) || shares <= 0) {
      problems.push(lines[i].trim());
      continue;
    }
    holdings.push({ code: ref.code, shares, cost: Number.isFinite(cost) && cost > 0 ? cost : 0 });
  }
  return { holdings, problems };
}

/** 读持仓文件;UTF-8 解出替换字符时按 GBK 再解一次(Windows 导出的表多为 GBK)。 */
export function readHoldingsFile(path: string): HoldingParse {
  const buffer = readFileSync(path);
  let text = buffer.toString('utf8');
  if (text.includes('\uFFFD')) {
    try {
      text = new TextDecoder('gbk').decode(buffer);
    } catch {
      /* 运行时没有 GBK 解码器就保留 UTF-8 结果,坏字符会被 parse 判成 problems */
    }
  }
  return parseHoldingsTable(text);
}

export interface Position extends Holding {
  ref: SymbolRef;
  name: string;
  price: number;
  marketValue: number;
  costValue: number;
  /** 浮动盈亏;成本价为 0 时为 null。 */
  pnl: number | null;
  pnlPct: number | null;
  source: string;
}

export interface BookSummary {
  positions: Position[];
  marketValue: number;
  costValue: number;
  pnl: number;
  /** 成本价为 0 的持仓不参与盈亏,只在 missing 里点名。 */
  pnlPct: number;
  missing: string[];
}

/** 用当前行情把持仓折成市值与浮盈;停牌用昨收,缺行情的进 missing 并保留市值 0。 */
export function buildBook(holdings: readonly Holding[], quotes: readonly Quote[], source: string): BookSummary {
  const byCode = new Map(quotes.map((q) => [q.code, q]));
  const positions: Position[] = [];
  const missing: string[] = [];
  let marketValue = 0;
  let costValue = 0;
  let pnl = 0;
  let pricedCost = 0;
  for (const holding of holdings) {
    const ref = normalizeSymbol(holding.code);
    if (!ref) {
      missing.push(holding.code);
      continue;
    }
    const quote = byCode.get(holding.code);
    if (!quote) {
      missing.push(holding.code);
      continue;
    }
    const price = quote.suspended ? quote.prevClose : quote.price;
    const value = price * holding.shares;
    const cost = holding.cost * holding.shares;
    const own = holding.cost > 0 ? value - cost : null;
    marketValue += value;
    if (holding.cost > 0) {
      costValue += cost;
      pricedCost += cost;
      if (own !== null) pnl += own;
    }
    positions.push({
      ...holding,
      ref,
      name: quote.name,
      price,
      marketValue: value,
      costValue: cost,
      pnl: own,
      pnlPct: own !== null && cost > 0 ? (own / cost) * 100 : null,
      source,
    });
  }
  return {
    positions,
    marketValue,
    costValue,
    pnl,
    pnlPct: pricedCost > 0 ? (pnl / pricedCost) * 100 : 0,
    missing,
  };
}
