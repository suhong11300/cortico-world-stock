/**
 * 拟股喵喵:确定时区与时间 → 盯 A 股关注列表 → 收盘时段播报 → 追问一句要不要看。
 * 行情只读公开页,账户只读你自己填/导出的持仓;取不到就如实说取不到,不编数字。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import {
  buildBook,
  parseHoldings,
  readHoldingsFile,
  type AccountMode,
  type BookSummary,
  type Holding,
} from './account.ts';
import { askText, composeBrief, marketTimeLabel, signedMoney, wrapForPersona, type BriefScope, type BriefStyle } from './copy.ts';
import { money, percent, signed } from './format.ts';
import {
  fetchQuotes,
  normalizeSymbol,
  parseSymbols,
  type Quote,
  type SymbolRef,
} from './quote.ts';
import {
  DEFAULT_WINDOWS_BY_MARKET,
  dateKeyOf,
  guessMarket,
  matchWindow,
  parseWindows,
  phaseText,
  resolveClock,
  weekdayText,
  windowText,
  zoneParts,
  type BriefWindow,
  type ClockInfo,
  type MarketId,
} from './time.ts';
import { STOCK_CONFIG_GROUP, type BriefTrigger, type StockConfigSection } from './config.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const DEFAULT_TICK_MS = 30000;
/** 配置里没写指数清单时的兜底:沪指/深成/创业板/科创50,道琼斯/纳指 100/标普 500。 */
const FALLBACK_INDEX: Record<MarketId, string> = {
  cn: 'sh000001,sz399001,sz399006,sh000688',
  us: 'DJIA,NDX,SPX',
};

export interface StockState {
  version: 1;
  dateKey: string;
  /** 键是 `日期#窗口序号`,值是播报时刻。 */
  fired: Record<string, string>;
  lastBrief?: { at: string; window: string };
  lastError?: { at: string; message: string };
}

export interface StockWorldOptions {
  /** `worlds.stock` 的活引用。 */
  cfg: StockConfigSection;
  /** 部署给的时区。 */
  timezone: string;
  /** `<botDir>/data`。 */
  dataDir: string;
  /** 部署目录,用来找别的世界的用户称呼;缺席就不找。 */
  botDir?: string;
  /** 写回配置;缺席时工具里的改成只读。 */
  persist?: (patch: Partial<StockConfigSection>) => void;
  /** 注入 fetch,测试用。 */
  fetchImpl?: typeof globalThis.fetch;
  /** 注入时钟,测试用。 */
  now?: () => Date;
  tickMs?: number;
  /** 状态目录,默认 `<dataDir>/stock`。 */
  stateDir?: string;
}

function emptyState(dateKey: string): StockState {
  return { version: 1, dateKey, fired: {} };
}

function readState(file: string, dateKey: string): StockState {
  try {
    if (!existsSync(file)) return emptyState(dateKey);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StockState>;
    const fired =
      raw.fired && typeof raw.fired === 'object' && !Array.isArray(raw.fired)
        ? (raw.fired as Record<string, string>)
        : {};
    return {
      version: 1,
      dateKey: typeof raw.dateKey === 'string' ? raw.dateKey : dateKey,
      fired,
      ...(raw.lastBrief ? { lastBrief: raw.lastBrief } : {}),
      ...(raw.lastError ? { lastError: raw.lastError } : {}),
    };
  } catch {
    return emptyState(dateKey);
  }
}

/** 状态写盘失败不影响播报本身,只是下次进程重启会忘掉今天播过。 */
function writeState(file: string, state: StockState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* 忽略:状态不是数据源 */
  }
}

/** 全部工具的声明;definition 的 describe 与 `tools()` 都取它。 */
export const STOCK_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'stock_setup',
    description:
      'Report the resolved time zone, current time, which market is in effect (A-share or US), session phase, index list, brief windows, watchlist and account mode. Use it first when you are unsure what time the market clock is at.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'stock_now',
    description:
      'Fetch quotes for the watchlist (plus the configured index list) and return a briefing without pushing any event.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'stock_brief',
    description:
      'Do a full briefing on demand: fetch quotes, push the stock.brief event, then the "want to see it?" follow-up. Same text the scheduled briefing would produce.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'stock_watch',
    description:
      'Read or change the watchlist: list, add, remove, or set it outright. A-share codes and US index codes such as DJIA or NDX are both accepted.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'set'], description: 'What to do.' },
        symbols: {
          type: 'string',
          description: 'Comma separated codes (600519, sz000001, DJIA); required for add, remove and set.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'stock_account',
    description:
      'Inspect or switch how your holdings are supplied: off, hand-filled, or a file exported from a broker. Never logs in anywhere.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['show', 'off', 'manual', 'csv'], description: 'show leaves it unchanged.' },
        holdings: { type: 'string', description: 'For manual: code:shares:cost, comma separated.' },
        file: { type: 'string', description: 'For csv: absolute path of the exported holdings table.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'stock_schedule',
    description:
      'Report the brief windows for the market in effect, what already fired today and when the next one is due.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export class StockWorld implements World {
  readonly id = 'stock';

  private host?: WorldHost;
  private timer?: ReturnType<typeof setInterval>;
  private greetTimer?: ReturnType<typeof setTimeout>;
  private state: StockState;
  private readonly stateFile: string;

  constructor(private readonly opts: StockWorldOptions) {
    const dir = opts.stateDir ?? join(opts.dataDir, 'stock');
    this.stateFile = join(dir, 'state.json');
    this.state = emptyState(dateKeyOf(zoneParts(this.zone(), this.now())).slice(0, 10));
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private zone(): string {
    const own = this.opts.cfg.zone?.trim();
    return own || this.opts.timezone || 'Asia/Shanghai';
  }

  /** 生效市场:配置钉死就用配置,auto 按本机时区猜(美国时区算美股)。 */
  private market(): MarketId {
    const pinned = this.opts.cfg.market;
    if (pinned === 'cn' || pinned === 'us') return pinned;
    return guessMarket(this.zone());
  }

  private clock(): ClockInfo {
    return resolveClock(this.zone(), this.now(), this.market());
  }

  /** 播报范围:关注股 / 持仓 / 两者。 */
  private scope(): BriefScope {
    const scope = this.opts.cfg.briefScope;
    return scope === 'watch' || scope === 'account' ? scope : 'both';
  }

  /** 该市场的播报窗口:美股走 usWindows,其余走 briefWindows。 */
  private windows(): { windows: BriefWindow[]; problems: string[] } {
    const market = this.market();
    const text =
      market === 'us'
        ? this.opts.cfg.usWindows || DEFAULT_WINDOWS_BY_MARKET.us
        : this.opts.cfg.briefWindows || DEFAULT_WINDOWS_BY_MARKET.cn;
    return parseWindows(text);
  }

  /** 指数清单:两个市场各一份,空则回落到兜底值;showIndex 关掉就一条都不取。 */
  private indexRefs(): SymbolRef[] {
    if (!this.opts.cfg.showIndex) return [];
    const market = this.market();
    const raw = (market === 'us' ? this.opts.cfg.usIndex : this.opts.cfg.indexList) || FALLBACK_INDEX[market];
    return parseSymbols(raw).symbols;
  }

  private quiet(level: 'info' | 'warn' | 'error', message: string): void {
    try {
      this.host?.log?.[level]?.(message);
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /** 称呼来源:配置 > 部署 config.json 的 worlds.desktop-pet.user > 部署 displayName。 */
  private user(): string {
    const own = this.opts.cfg.user?.trim();
    if (own) return own;
    const dirs = [this.opts.botDir ?? '', dirname(this.opts.dataDir)];
    for (const dir of dirs) {
      if (!dir) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
        const worlds = raw.worlds as Record<string, Record<string, unknown>> | undefined;
        const fromPet = worlds?.['desktop-pet']?.user;
        if (typeof fromPet === 'string' && fromPet.trim()) return fromPet.trim();
        const display = raw.displayName;
        if (typeof display === 'string' && display.trim()) return display.trim();
      } catch {
        /* 换下一个候选目录 */
      }
    }
    return '';
  }

  /** 关注列表;播报范围含持仓时把持仓代码并进来(去重),账户那一段才有行情可用。 */
  private watchRefs(): { symbols: SymbolRef[]; problems: string[] } {
    const parsed = parseSymbols(this.opts.cfg.watchlist ?? '');
    const limit = Math.max(1, Math.min(Number(this.opts.cfg.maxWatch) || 12, 50));
    if (this.scope() === 'watch' || this.accountMode() === 'none') {
      return { symbols: parsed.symbols.slice(0, limit), problems: parsed.problems };
    }
    const scopeIsAccount = this.scope() === 'account';
    const main = scopeIsAccount ? [] : parsed.symbols.slice(0, limit);
    const seen = new Set(main.map((s) => s.secid));
    const problems = [...parsed.problems];
    const extra: SymbolRef[] = [];
    for (const holding of this.holdings().holdings) {
      const ref = normalizeSymbol(holding.code);
      if (!ref) {
        problems.push(holding.code);
        continue;
      }
      if (seen.has(ref.secid)) continue;
      seen.add(ref.secid);
      extra.push(ref);
    }
    return { symbols: [...main, ...extra].slice(0, 50), problems };
  }

  private accountMode(): AccountMode {
    const mode = this.opts.cfg.accountMode;
    return mode === 'manual' || mode === 'csv' ? mode : 'none';
  }

  /** 读持仓:手填直接解析,文件模式读导出表;读不到就返回 null 并把原因带出去。 */
  private holdings(): { holdings: Holding[]; problems: string[]; from: string } {
    const mode = this.accountMode();
    if (mode === 'none') return { holdings: [], problems: [], from: '关' };
    if (mode === 'manual') {
      const parsed = parseHoldings(this.opts.cfg.holdings ?? '');
      return { holdings: parsed.holdings, problems: parsed.problems, from: '手填' };
    }
    const file = this.opts.cfg.holdingsFile?.trim() ?? '';
    if (!file) return { holdings: [], problems: ['持仓文件路径是空的'], from: '文件' };
    try {
      const parsed = readHoldingsFile(file);
      return { holdings: parsed.holdings, problems: parsed.problems, from: '文件 ' + file };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { holdings: [], problems: ['读取持仓文件失败:' + message], from: '文件 ' + file };
    }
  }

  private book(quotes: readonly Quote[]): { book: BookSummary | null; problems: string[]; from: string } {
    const loaded = this.holdings();
    if (this.accountMode() === 'none') return { book: null, problems: [], from: '关' };
    if (!loaded.holdings.length) return { book: null, problems: loaded.problems, from: loaded.from };
    return { book: buildBook(loaded.holdings, quotes, loaded.from), problems: loaded.problems, from: loaded.from };
  }

  /** 一次取回关注股与指数;指数只认配置开关,不吃关注列表。 */
  private async collect(): Promise<{ quotes: Quote[]; indices: Quote[]; problems: string[] }> {
    const { symbols, problems } = this.watchRefs();
    const indexRefs = this.indexRefs();
    const all = [...symbols, ...indexRefs];
    if (!all.length) return { quotes: [], indices: [], problems };
    const result = await fetchQuotes(all, {
      source: this.opts.cfg.dataSource ?? 'auto',
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
    });
    const watchKeys = new Set(symbols.map((s) => s.market + ':' + s.code));
    const quotes = result.quotes.filter((q) => watchKeys.has(q.market + ':' + q.code));
    const indices = result.quotes.filter((q) => !watchKeys.has(q.market + ':' + q.code));
    return { quotes, indices, problems: [...problems, ...result.errors.map((e) => e.raw + '(' + e.reason + ')')] };
  }

  private async compose(window?: BriefWindow): Promise<{ text: string; quotes: Quote[] }> {
    const clock = this.clock();
    const { quotes, indices, problems } = await this.collect();
    const loaded = this.book(quotes);
    const text = composeBrief({
      clock,
      ...(window ? { window } : {}),
      quotes,
      indices,
      account: loaded.book,
      user: this.user(),
      style: (this.opts.cfg.style === 'calm' ? 'calm' : 'lively') as BriefStyle,
      scope: this.scope(),
      problems: [...problems, ...loaded.problems],
    });
    return { text, quotes };
  }

  /**
   * 人格化:优先走宿主的 cognition 通道(上下文、轮数、模型都归 Persona);
   * 宿主没实现就退回「把素材与改写要求整段推给会话模型」;plain 模式直接用模板文案。
   */
  private async forPersona(host: WorldHost | undefined, text: string): Promise<string> {
    if (this.opts.cfg.personaMode === 'plain') return text;
    const user = this.user();
    const cognition = host?.cognition;
    if (cognition) {
      try {
        const result = await cognition.request({ brief: wrapForPersona(text, user) });
        if ('text' in result && result.text.trim()) return result.text.trim();
        this.quiet('warn', 'cognition 改写没拿到文本,退回素材直推:' + ('error' in result ? result.error : '空结果'));
      } catch (err) {
        this.quiet('warn', 'cognition 改写抛错,退回素材直推:' + (err instanceof Error ? err.message : String(err)));
      }
    }
    return wrapForPersona(text, user);
  }

  /** 播报一次并把结果落盘;取不到行情时不推事件,只记 lastError。 */
  private async broadcast(window?: BriefWindow): Promise<string> {
    const clock = this.clock();
    try {
      const composed = await this.compose(window);
      const host = this.host;
      const text = await this.forPersona(host, composed.text);
      if (host) {
        const trigger = (this.opts.cfg.trigger ?? 'debounce') as BriefTrigger;
        await host.pushEvent(
          {
            type: 'stock.brief',
            ts: nowIso(this.zone()),
            source: this.id,
            origin: 'internal',
            senderKey: this.id,
            text,
          },
          { trigger },
        );
        if (this.opts.cfg.askAfterBrief) {
          await host.pushEvent(
            {
              type: 'stock.ask',
              ts: nowIso(this.zone()),
              source: this.id,
              origin: 'internal',
              senderKey: this.id,
              text: askText(this.user()),
            },
            { trigger: 'flush' },
          );
        }
      }
      if (window) this.state.fired[clock.dateKey + '#' + window.index] = nowIso(this.zone());
      this.state.lastBrief = { at: nowIso(this.zone()), window: window?.label ?? '手动' };
      writeState(this.stateFile, this.state);
      this.quiet('info', '已播报 ' + (window?.label ?? '手动') + ' · ' + text.split('\n').length + ' 行');
      return composed.text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.lastError = { at: nowIso(this.zone()), message };
      writeState(this.stateFile, this.state);
      this.quiet('warn', 'stock 播报失败:' + message);
      return '⚠️ 行情没取到:' + message + '。这次不播报,也不凭记忆编数字。';
    }
  }

  /** 定时检查:跨日重新定时间,窗口命中且当天没播过就播。 */
  private async tick(): Promise<void> {
    try {
      const clock = this.clock();
      if (clock.dateKey !== this.state.dateKey) {
        const lastError = this.state.lastError;
        this.state = { version: 1, dateKey: clock.dateKey, fired: {}, ...(lastError ? { lastError } : {}) };
        writeState(this.stateFile, this.state);
        await this.announce(clock, true);
      }
      if (!this.opts.cfg.autoBrief) return;
      const { windows } = this.windows();
      if (!windows.length || clock.phase === 'weekend') return;
      const hit = matchWindow(windows, clock.minutes);
      if (!hit) return;
      if (this.state.fired[clock.dateKey + '#' + hit.index]) return;
      await this.broadcast(hit);
    } catch (err) {
      this.quiet('error', 'stock tick 出错:' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** 挂载与新的一天各报一次:先把时区与当前时间钉死,后面的播报都以它为准。 */
  private async announce(clock: ClockInfo, freshDay: boolean): Promise<void> {
    const host = this.host;
    if (!host) return;
    const { symbols } = this.watchRefs();
    const lines = [
      freshDay ? '🐱 拟股喵喵 · 新的一天已经对表' : '🐱 拟股喵喵上线',
      '🕚 ' + marketTimeLabel(clock.market) + ' ' + clock.marketText + '(' + weekdayText(clock.weekday) + ')',
      '🌏 时区 ' + clock.zone + '(' + clock.offsetLabel + ')' + (clock.zone === clock.marketZone ? '' : ' · 本机 ' + clock.localText),
      '📊 ' + clock.marketLabel + ' · ' + phaseText(clock.phase) + ' · 窗口 ' + windowText(this.windows().windows) + ' · 关注 ' + symbols.length + ' 只 · 账户 ' + this.accountMode(),
    ];
    if (this.state.lastError) lines.push('⚠️ 上次取数失败:' + this.state.lastError.message);
    await host.pushEvent(
      {
        type: 'stock.ready',
        ts: nowIso(this.zone()),
        source: this.id,
        origin: 'internal',
        senderKey: this.id,
        text: lines.join('\n'),
      },
      { trigger: 'flush' },
    );
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const clock = this.clock();
    this.state = readState(this.stateFile, clock.dateKey);
    // 问候只是打个招呼:事件通道还没就绪时不能连累定时器,失败就过两秒补一次。
    try {
      await this.announce(clock, false);
    } catch (err) {
      this.quiet('warn', '上线问候没投出去,2 秒后补一次:' + (err instanceof Error ? err.message : String(err)));
      this.greetTimer = setTimeout(() => {
        void this.announce(clock, false).catch(() => undefined);
      }, 2000);
      this.greetTimer.unref?.();
    }
    const interval = Math.max(5000, Number(this.opts.tickMs) || DEFAULT_TICK_MS);
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.timer.unref?.();
    const { windows } = this.windows();
    const fired = Object.keys(this.state.fired).filter((k) => k.startsWith(clock.dateKey)).length;
    this.quiet(
      'info',
      '就绪:' + clock.marketLabel + ' ' + clock.marketText + ' · ' + phaseText(clock.phase) + ' · 窗口 ' + windowText(windows) + ' · 今日已播 ' + fired + ' 次',
    );
    await this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.greetTimer) clearTimeout(this.greetTimer);
    this.greetTimer = undefined;
    this.host = undefined;
  }

  envPromptVars(): Record<string, string> {
    const clock = this.clock();
    const { symbols, problems } = this.watchRefs();
    const watch = symbols.length
      ? symbols.map((s) => s.code).join('、') + (problems.length ? '(认不出:' + problems.join('、') + ')' : '')
      : '空';
    const mode = this.accountMode();
    const account = mode === 'none' ? '未接账户' : mode === 'manual' ? '手填持仓' : '持仓文件';
    const indices = this.indexRefs().map((s) => s.code).join('、');
    return {
      'stock.now': clock.marketText,
      'stock.market': clock.marketLabel + '(' + clock.marketZone + ')',
      'stock.index': indices || '未开启',
      'stock.zone': clock.zone,
      'stock.phase': clock.phaseText,
      'stock.watch': watch,
      'stock.user': this.user() || '你',
      'stock.account': account,
    };
  }

  tools(): ToolDef[] {
    return [
      this.setupTool(),
      this.nowTool(),
      this.briefTool(),
      this.watchTool(),
      this.accountTool(),
      this.scheduleTool(),
    ];
  }

  webUi(): WorldWebUiDecl {
    return {
      config: [STOCK_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.stock.envPrompt',
          title: '拟股喵喵 · 环境提示词',
          description: '把当前时区、市场状态与关注列表写进 system 前缀的那一段。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'stock.now', description: '北京时间的当前时刻。' },
            { name: 'stock.zone', description: '本机时区。' },
            { name: 'stock.phase', description: 'A 股此刻的市场状态。' },
            { name: 'stock.watch', description: '关注列表里的代码。' },
            { name: 'stock.user', description: '播报里怎么称呼你。' },
            { name: 'stock.account', description: '账户数据的来源。' },
          ],
        },
      ],
    };
  }

  private writeConfig(patch: Partial<StockConfigSection>): string | null {
    if (!this.opts.persist) return '这个运行环境不允许写配置,请到 WebUI 的拟股喵喵面板里改。';
    try {
      this.opts.persist(patch);
      return null;
    } catch (err) {
      return '写配置失败:' + (err instanceof Error ? err.message : String(err));
    }
  }

  private setupTool(): ToolDef {
    return {
      ...STOCK_TOOL_DECLS[0],
      handler: async () => {
        const clock = this.clock();
        const { symbols, problems } = this.watchRefs();
        const { windows, problems: bad } = this.windows();
        const fired = Object.keys(this.state.fired).filter((k) => k.startsWith(clock.dateKey + '#')).length;
        const lines = [
          '🐱 拟股喵喵 · 环境自检',
          '🕚 现在:北京时间 ' + clock.marketText + '(' + weekdayText(clock.weekday) + ')',
          '🌏 时区:' + clock.zone + '(' + clock.offsetLabel + ')' + (clock.zone === clock.marketZone ? '' : ' · 你那边 ' + clock.localText),
          '📊 ' + clock.marketLabel + ' · 市场状态 ' + clock.phaseText + ' · 时区 ' + clock.marketZone,
          '📡 数据源:' + this.opts.cfg.dataSource + ' · 指数 ' + (this.opts.cfg.showIndex ? this.indexRefs().map((s) => s.code).join('、') : '关') + ' · 人格化 ' + this.opts.cfg.personaMode,
          '🔎 关注:' + (symbols.length ? symbols.map((s) => s.code).join('、') : '空') + (problems.length ? ' · 认不出 ' + problems.join('、') : ''),
          '🗓 播报窗口:' + (windows.length ? windowText(windows) : '未配置') + ' · 今日已播 ' + fired + ' 次',
          '💰 账户:' + this.accountMode() + (this.opts.cfg.holdingsFile ? '(' + this.opts.cfg.holdingsFile + ')' : ''),
        ];
        if (bad.length) lines.push('⚠️ 认不出的窗口:' + bad.join('、'));
        if (this.state.lastError) lines.push('⚠️ 上次取数失败:' + this.state.lastError.at + ' ' + this.state.lastError.message);
        return lines.join('\n');
      },
    };
  }

  private nowTool(): ToolDef {
    return {
      ...STOCK_TOOL_DECLS[1],
      handler: async () => {
        try {
          const { text } = await this.compose();
          return text;
        } catch (err) {
          return '⚠️ 行情没取到:' + (err instanceof Error ? err.message : String(err)) + '。';
        }
      },
    };
  }

  private briefTool(): ToolDef {
    return {
      ...STOCK_TOOL_DECLS[2],
      handler: async () => {
        const text = await this.broadcast();
        const tail = this.opts.cfg.askAfterBrief ? '\n\n(已推送 stock.ask:' + askText(this.user()) + ')' : '';
        return text + tail;
      },
    };
  }

  private watchTool(): ToolDef {
    return {
      ...STOCK_TOOL_DECLS[3],
      handler: async (args) => {
        const action = String(args.action ?? 'list');
        const current = parseSymbols(this.opts.cfg.watchlist ?? '');
        if (action === 'list') {
          const clock = this.clock();
          const lines = ['🔎 关注列表(' + current.symbols.length + ' 只):'];
          if (!current.symbols.length) lines.push('(空)');
          for (const s of current.symbols) lines.push('· ' + s.code + ' ' + s.market.toUpperCase());
          if (current.problems.length) lines.push('⚠️ 认不出:' + current.problems.join('、'));
          lines.push('🗓 现在 ' + clock.marketText + ' · ' + clock.phaseText);
          return lines.join('\n');
        }
        const incoming = parseSymbols(String(args.symbols ?? ''));
        if (!incoming.symbols.length) {
          const bad = incoming.problems.length ? ',认不出:' + incoming.problems.join('、') : '';
          return '没给出可用的股票代码' + bad + ',用法:stock_watch action=' + action + ' symbols=600519,000001';
        }
        const limit = Math.max(1, Math.min(Number(this.opts.cfg.maxWatch) || 12, 50));
        let next: SymbolRef[] = [];
        if (action === 'add') next = [...current.symbols, ...incoming.symbols];
        else if (action === 'remove') {
          const drop = new Set(incoming.symbols.map((s) => s.market + ':' + s.code));
          next = current.symbols.filter((s) => !drop.has(s.market + ':' + s.code));
        } else if (action === 'set') next = [...incoming.symbols];
        else return '不认识的 action:' + action + ';可用 list / add / remove / set。';
        const seen = new Set<string>();
        const deduped: SymbolRef[] = [];
        for (const s of next) {
          const key = s.market + ':' + s.code;
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(s);
        }
        const capped = deduped.slice(0, limit);
        const error = this.writeConfig({ watchlist: capped.map((s) => s.code).join(',') });
        if (error) return error;
        const lines = ['✅ 关注列表现在是 ' + capped.length + ' 只:' + capped.map((s) => s.code).join('、')];
        if (deduped.length > capped.length) lines.push('⚠️ 超过上限 ' + limit + ',多出的没写进去。');
        if (incoming.problems.length) lines.push('⚠️ 认不出:' + incoming.problems.join('、'));
        return lines.join('\n');
      },
    };
  }

  private accountTool(): ToolDef {
    return {
      ...STOCK_TOOL_DECLS[4],
      handler: async (args) => {
        const action = String(args.action ?? 'show');
        if (action === 'off') {
          const error = this.writeConfig({ accountMode: 'none' });
          return error ?? '✅ 已关掉账户数据,以后只报行情不报持仓。';
        }
        if (action === 'manual') {
          const holdings = String(args.holdings ?? '');
          if (!holdings.trim()) return '手填需要 holdings,形如 600519:100:1300.5,000001:2000:10.5';
          const error = this.writeConfig({ accountMode: 'manual', holdings });
          if (error) return error;
          const parsed = parseHoldings(holdings);
          return '✅ 已切到手填持仓,' + parsed.holdings.length + ' 笔' + (parsed.problems.length ? ';认不出:' + parsed.problems.join('、') : '') + '。';
        }
        if (action === 'csv') {
          const file = String(args.file ?? '');
          if (!file.trim()) return '文件模式需要 file,填导出表的绝对路径。';
          const error = this.writeConfig({ accountMode: 'csv', holdingsFile: file });
          if (error) return error;
          return '✅ 已切到文件模式:' + file + '。表头认「代码/数量/成本价」,UTF-8 与 GBK 都能读。';
        }
        if (action !== 'show') return '不认识的 action:' + action + ';可用 show / off / manual / csv。';
        const mode = this.accountMode();
        if (mode === 'none') return '💰 账户数据没接。想接就 stock_account action=manual holdings=600519:100:1300.5,或者 action=csv file=导出表路径。';
        const loaded = this.holdings();
        if (!loaded.holdings.length) {
          return '💰 账户模式 ' + loaded.from + ',但没读到持仓' + (loaded.problems.length ? ':' + loaded.problems.join('、') : '。');
        }
        try {
          const { quotes, problems } = await this.collect();
          const book = buildBook(loaded.holdings, quotes, loaded.from);
          const lines = ['💰 账户:' + loaded.from + ' · ' + book.positions.length + ' 笔'];
          for (const p of book.positions) {
            const pnl = p.pnl === null ? '成本价未填' : signed(p.pnl) + '(' + percent(p.pnlPct ?? 0) + ')';
            lines.push('· ' + p.name + ' ' + p.code + ' ' + p.shares + ' 股 @ ' + money(p.price) + ' 市值 ¥' + money(p.marketValue) + ' ' + pnl);
          }
          lines.push('合计市值 ¥' + money(book.marketValue) + (book.costValue > 0 ? ' · 浮盈 ' + signedMoney('¥', book.pnl) + '(' + percent(book.pnlPct) + ')' : ''));
          if (book.missing.length) lines.push('❓ 缺行情:' + book.missing.join('、'));
          if (problems.length) lines.push('⚠️ ' + problems.join('、'));
          return lines.join('\n');
        } catch (err) {
          return '💰 持仓已读到 ' + loaded.holdings.length + ' 笔,但行情没取到:' + (err instanceof Error ? err.message : String(err));
        }
      },
    };
  }

  private scheduleTool(): ToolDef {
    return {
      ...STOCK_TOOL_DECLS[5],
      handler: async () => {
        const clock = this.clock();
        const { windows, problems } = this.windows();
        const lines = ['🗓 ' + clock.marketLabel + ' 播报窗口:' + (windows.length ? windowText(windows) : '未配置')];
        if (problems.length) lines.push('⚠️ 认不出:' + problems.join('、'));
        for (const w of windows) {
          const key = clock.dateKey + '#' + w.index;
          const at = this.state.fired[key];
          const state = at ? '已播 ' + at.slice(11, 19) : clock.minutes >= w.start ? '待播/已错过' : '还没到';
          lines.push('· ' + w.label + ' → ' + state);
        }
        const pending = windows.filter((w) => !this.state.fired[clock.dateKey + '#' + w.index]);
        const upcoming = pending.find((w) => w.end >= clock.minutes) ?? pending[0];
        lines.push(upcoming ? '⏭ 下一段:' + upcoming.label : '✅ 今天的窗口都播完了');
        lines.push('🕚 现在 ' + marketTimeLabel(clock.market) + ' ' + clock.marketText + ' · ' + clock.phaseText);
        if (!this.opts.cfg.autoBrief) lines.push('⏸ 自动播报是关的,只有手动调用才会播。');
        return lines.join('\n');
      },
    };
  }
}
