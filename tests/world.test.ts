import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { STOCK_DEFAULTS, type StockConfigSection } from '../src/config.ts';
import { STOCK } from '../src/definition.ts';
import { StockWorld, type StockWorldOptions } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

const EM_BODY = JSON.stringify({
  data: {
    diff: [
      { f2: 1350, f3: 1.12, f4: 14.98, f5: 1000, f6: 200000000, f12: '600519', f13: 1, f14: '贵州茅台', f15: 1360, f16: 1330, f17: 1340, f18: 1335.02, f124: 1761000000 },
    ],
  },
});

/** 2026-10-26 周一 11:30,落在默认窗口 11:25-11:35 里。 */
const MON_1130 = new Date('2026-10-26T03:30:00Z');
const MON_1000 = new Date('2026-10-26T02:00:00Z');
const SAT_1130 = new Date('2026-10-24T03:30:00Z');

const okFetch = (): typeof globalThis.fetch =>
  (async () => new Response(EM_BODY, { status: 200 })) as typeof globalThis.fetch;
const deadFetch = (): typeof globalThis.fetch =>
  (async () => new Response('no', { status: 500 })) as typeof globalThis.fetch;

const dirs: string[] = [];
let scratchDir: string;
beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'stock-scratch-'));
});
afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  world: StockWorld;
  cfg: StockConfigSection;
  host: FakeHost;
  patches: Array<Partial<StockConfigSection>>;
  dir: string;
}

function rig(over: Partial<StockWorldOptions> = {}, cfgOver: Partial<StockConfigSection> = {}): Rig {
  const dir = over.dataDir ?? mkdtempSync(join(tmpdir(), 'stock-world-'));
  if (!dirs.includes(dir)) dirs.push(dir);
  const cfg: StockConfigSection = { ...STOCK_DEFAULTS, ...cfgOver };
  const patches: Array<Partial<StockConfigSection>> = [];
  const world = new StockWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: dir,
    persist: (patch) => {
      Object.assign(cfg, patch);
      patches.push(patch);
    },
    fetchImpl: okFetch(),
    now: () => MON_1130,
    tickMs: 60000,
    ...over,
  });
  return { world, cfg, host: new FakeHost(), patches, dir };
}

async function call(world: StockWorld, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const tool = world.tools().find((t) => t.name === name);
  if (!tool) throw new Error('没有这个工具:' + name);
  const ctx: ToolCallContext = { role: 'test', log: nullLogger() };
  const out = await tool.handler(args, ctx);
  return typeof out === 'string' ? out : out.text;
}

describe('装配契约', () => {
  it('干装载零失败,且不触发 enabled 告警', async () => {
    const report = await dryMountWorld(STOCK, { scratchDir });
    expect(report.failures).toEqual([]);
    expect(report.warnings.filter((w) => w.includes('enabled is not false'))).toEqual([]);
  });

  it('定义默认 enabled=false:装配与否交给部署', () => {
    expect(STOCK_DEFAULTS.enabled).toBe(false);
    expect(STOCK_DEFAULTS.autoBrief).toBe(true);
  });

  it('实例 id 与定义 id 一致', () => {
    expect(STOCK.create(fakeWorldContext(STOCK, { scratchDir })).id).toBe('stock');
  });

  it('六个工具都带前缀与标签', () => {
    const { world } = rig();
    const tools = world.tools();
    expect(tools.map((t) => t.name)).toEqual([
      'stock_setup',
      'stock_now',
      'stock_brief',
      'stock_watch',
      'stock_account',
      'stock_schedule',
    ]);
    for (const tool of tools) {
      expect(tool.tags.length).toBeGreaterThan(0);
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('环境提示词给出八个占位符', () => {
    const { world } = rig();
    expect(world.envPromptVars()).toEqual({
      'stock.now': '2026-10-26 11:30:00',
      'stock.market': 'A 股(Asia/Shanghai)',
      'stock.index': '000001、399001、399006、000688',
      'stock.zone': 'Asia/Shanghai',
      'stock.phase': '午间休市',
      'stock.watch': '600519、000001',
      'stock.user': '你',
      'stock.account': '未接账户',
    });
  });

  it('WebUI 声明的配置段与提示词文件都落到实处', () => {
    const { world } = rig();
    const decl = world.webUi();
    expect(decl.config?.[0]?.owner).toBe('world:stock');
    const doc = decl.promptDocs?.[0];
    expect(doc?.key).toBe('worlds.stock.envPrompt');
    expect(doc?.vars).toHaveLength(6);
    expect(existsSync(doc?.path ?? '')).toBe(true);
  });
});

describe('挂载与自动播报', () => {
  it('挂载先钉住时区与当前时间', async () => {
    const { world, host } = rig();
    await world.start(host);
    await world.stop();
    expect(host.events[0]?.type).toBe('stock.ready');
    expect(host.events[0]?.origin).toBe('internal');
    expect(host.pushOpts[0]?.trigger).toBe('flush');
    expect(host.events[0]?.text).toContain('🐱 拟股喵喵上线');
    expect(host.events[0]?.text).toContain('北京时间 2026-10-26 11:30:00(周一)');
  });

  it('命中窗口就播报,并追问一句', async () => {
    const { world, host, dir } = rig({}, { user: '鸿' });
    await world.start(host);
    await world.stop();
    expect(host.events.map((e) => e.type)).toEqual(['stock.ready', 'stock.brief', 'stock.ask']);
    expect(host.pushOpts[1]?.trigger).toBe('debounce');
    expect(host.pushOpts[2]?.trigger).toBe('flush');
    expect(host.events[1]?.text).toContain('11:25-11:35 播报');
    expect(host.events[1]?.text).toContain('贵州茅台 600519');
    expect(host.events[2]?.text).toBe('请问鸿,需要查看吗?');
    const state = JSON.parse(readFileSync(join(dir, 'stock', 'state.json'), 'utf8'));
    expect(Object.keys(state.fired)).toEqual(['2026-10-26#1']);
    expect(state.lastBrief.window).toBe('11:25-11:35');
  });

  it('同一天重启不会重复播', async () => {
    const first = rig();
    await first.world.start(first.host);
    await first.world.stop();
    const second = rig({ dataDir: first.dir });
    await second.world.start(second.host);
    await second.world.stop();
    expect(second.host.events.map((e) => e.type)).toEqual(['stock.ready']);
  });

  it('关掉自动播报就只在被调用时说话', async () => {
    const { world, host } = rig({}, { autoBrief: false });
    await world.start(host);
    await world.stop();
    expect(host.events.map((e) => e.type)).toEqual(['stock.ready']);
  });

  it('周末不播报', async () => {
    const { world, host } = rig({ now: () => SAT_1130 });
    await world.start(host);
    await world.stop();
    expect(host.events.map((e) => e.type)).toEqual(['stock.ready']);
    expect(host.events[0]?.text).toContain('周末休市');
  });

  it('不在窗口里就不播', async () => {
    const { world, host } = rig({ now: () => MON_1000 });
    await world.start(host);
    await world.stop();
    expect(host.events.map((e) => e.type)).toEqual(['stock.ready']);
  });

  it('取不到行情就如实说,不推播报事件', async () => {
    const { world, host } = rig({ fetchImpl: deadFetch() });
    await world.start(host);
    const text = await call(world, 'stock_brief');
    await world.stop();
    expect(host.events.map((e) => e.type)).toEqual(['stock.ready']);
    expect(text).toContain('⚠️ 行情没取到');
    expect(text).toContain('不凭记忆编数字');
  });
});

describe('手动工具', () => {
  it('环境自检报出时区、市场状态与窗口', async () => {
    const { world } = rig();
    const text = await call(world, 'stock_setup');
    expect(text).toContain('🐱 拟股喵喵 · 环境自检');
    expect(text).toContain('北京时间 2026-10-26 11:30:00');
    expect(text).toContain('Asia/Shanghai(UTC+08:00)');
    expect(text).toContain('午间休市');
    expect(text).toContain('11:25-11:35');
  });

  it('即时播报只看不推', async () => {
    const { world, host } = rig({}, { autoBrief: false });
    const text = await call(world, 'stock_now');
    expect(text).toContain('🐱 拟股喵喵 · A 股 · 即时播报');
    expect(text).toContain('🔎 关注');
    expect(host.events).toEqual([]);
  });

  it('手动播报会推两条事件', async () => {
    const { world, host } = rig({}, { autoBrief: false });
    await world.start(host);
    host.events.length = 0;
    const text = await call(world, 'stock_brief');
    await world.stop();
    expect(host.events.map((e) => e.type)).toEqual(['stock.brief', 'stock.ask']);
    expect(text).toContain('已推送 stock.ask');
  });

  it('关掉追问就只推播报', async () => {
    const { world, host } = rig({}, { autoBrief: false, askAfterBrief: false });
    await world.start(host);
    host.events.length = 0;
    await call(world, 'stock_brief');
    await world.stop();
    expect(host.events.map((e) => e.type)).toEqual(['stock.brief']);
  });

  it('关注列表能增删改查', async () => {
    const { world, cfg, patches } = rig();
    expect(await call(world, 'stock_watch', { action: 'list' })).toContain('600519');
    await call(world, 'stock_watch', { action: 'add', symbols: '300750' });
    expect(cfg.watchlist).toBe('600519,000001,300750');
    await call(world, 'stock_watch', { action: 'remove', symbols: '600519' });
    expect(cfg.watchlist).toBe('000001,300750');
    await call(world, 'stock_watch', { action: 'set', symbols: 'sh600519 000001' });
    expect(cfg.watchlist).toBe('600519,000001');
    expect(patches.length).toBe(3);
  });

  it('加不认识的代码会说出来', async () => {
    const { world, cfg } = rig();
    const text = await call(world, 'stock_watch', { action: 'add', symbols: '乱码' });
    expect(cfg.watchlist).toBe('600519,000001');
    expect(text).toContain('乱码');
  });

  it('没有写配置的权限时明说', async () => {
    const { world } = rig({ persist: undefined });
    const text = await call(world, 'stock_watch', { action: 'add', symbols: '300750' });
    expect(text).toContain('不允许写配置');
  });

  it('账户在关/手填/文件之间切换', async () => {
    const { world, cfg } = rig();
    expect(await call(world, 'stock_account', { action: 'show' })).toContain('账户数据没接');
    await call(world, 'stock_account', { action: 'manual', holdings: '600519:100:1300' });
    expect(cfg.accountMode).toBe('manual');
    expect(cfg.holdings).toBe('600519:100:1300');
    expect(await call(world, 'stock_account', { action: 'show' })).toContain('💰 账户:');
    await call(world, 'stock_account', { action: 'csv', file: 'C:/tmp/holdings.csv' });
    expect(cfg.accountMode).toBe('csv');
    await call(world, 'stock_account', { action: 'off' });
    expect(cfg.accountMode).toBe('none');
  });

  it('手填格式不对会退回提示', async () => {
    const { world, cfg } = rig();
    const text = await call(world, 'stock_account', { action: 'manual', holdings: '   ' });
    expect(text).toContain('手填需要 holdings');
    expect(cfg.accountMode).toBe('none');
  });

  it('日程表报出窗口与下一段', async () => {
    const { world } = rig();
    const text = await call(world, 'stock_schedule');
    expect(text).toContain('🗓 A 股 播报窗口:11:25-11:35、14:55-15:05');
    expect(text).toContain('下一段:11:25-11:35');
  });

  it('手动播报不占用窗口打卡', async () => {
    const { world, host } = rig({}, { autoBrief: false });
    await world.start(host);
    await call(world, 'stock_brief');
    const text = await call(world, 'stock_schedule');
    await world.stop();
    expect(text).toContain('· 11:25-11:35 → 待播/已错过');
    expect(text).not.toContain('已播 ');
  });
});
describe('境外市场、持仓范围与人格化', () => {
  /** 2026-10-26 20:00Z = 美东 16:00 周一,正好落在美股窗口 15:55-16:05 里。 */
  const US_CLOSE = new Date('2026-10-26T20:00:00Z');

  const recordingFetch = (urls: string[]): typeof globalThis.fetch =>
    (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      const secids = new URL(url).searchParams.get('secids') ?? '';
      const diff = secids
        .split(
          ',',
        )
        .filter(Boolean)
        .map((secid) => {
          const [mkt, code] = secid.split('.');
          return {
            f2: 100,
            f3: 0.5,
            f4: 0.5,
            f5: 1,
            f6: 1000,
            f12: code,
            f13: Number(mkt),
            f14: code,
            f15: 101,
            f16: 98,
            f17: 99,
            f18: 99.5,
            f124: 1761000000,
          };
        });
      return new Response(JSON.stringify({ data: { diff } }), { status: 200 });
    }) as typeof globalThis.fetch;

  it('本机在美国时区就按美股窗口播报', async () => {
    const urls: string[] = [];
    const { world, host } = rig(
      { timezone: 'America/New_York', now: () => US_CLOSE, fetchImpl: recordingFetch(urls) },
      { watchlist: 'AAPL', indexList: 'sh000001' },
    );
    await world.start(host);
    await world.stop();
    expect(host.events.map((e) => e.type)).toEqual(['stock.ready', 'stock.brief', 'stock.ask']);
    expect(host.events[0]?.text).toContain('美股');
    expect(host.events[1]?.text).toContain('15:55-16:05 播报');
    expect(host.events[1]?.text).toContain('美东时间');
    const secids = urls.map((u) => new URL(u).searchParams.get('secids') ?? '').join('|');
    expect(secids).toContain('100.DJIA');
    expect(secids).not.toContain('1.000001');
  });

  it('市场钉死 cn 时指数清单走 A 股并含科创 50', async () => {
    const urls: string[] = [];
    const { world } = rig({ fetchImpl: recordingFetch(urls) }, { market: 'cn' });
    await call(world, 'stock_now');
    const secids = urls.map((u) => new URL(u).searchParams.get('secids') ?? '').join('|');
    expect(secids).toContain('1.000688');
    expect(secids).not.toContain('100.');
  });

  it('关注列表里写美股代码也能取到', async () => {
    const urls: string[] = [];
    const { world } = rig({ fetchImpl: recordingFetch(urls) }, { market: 'us', watchlist: 'AAPL,DJIA' });
    await call(world, 'stock_now');
    const secids = urls.map((u) => new URL(u).searchParams.get('secids') ?? '').join('|');
    expect(secids).toContain('100.AAPL');
  });

  it('播报范围选持仓时只播盈亏', async () => {
    const { world } = rig(
      {},
      { autoBrief: false, briefScope: 'account', accountMode: 'manual', holdings: '600519:100:1300' },
    );
    const text = await call(world, 'stock_now');
    expect(text).toContain('💰 持仓');
    expect(text).not.toContain('🔎');
  });

  it('没接账户时选了持仓范围就直说没接', async () => {
    const { world } = rig({}, { autoBrief: false, briefScope: 'account' });
    const text = await call(world, 'stock_now');
    expect(text).toContain('还没接账户数据');
  });

  it('人格化改写:宿主没有 cognition 就带着素材与要求推给会话模型', async () => {
    const { world, host } = rig({}, { autoBrief: false });
    await world.start(host);
    host.events.length = 0;
    await call(world, 'stock_brief');
    await world.stop();
    const text = host.events[0]?.text ?? '';
    expect(text).toContain('真实行情素材');
    expect(text).toContain('贵州茅台 600519');
    expect(text).toContain('不要编造');
  });

  it('人格化改写:宿主有 cognition 就用它返回的文本', async () => {
    const { world, host } = rig({}, { autoBrief: false });
    const asks: string[] = [];
    Object.assign(host, {
      cognition: {
        request: async (req: { brief: string }) => {
          asks.push(req.brief);
          return { text: '鸿酱版播报:茅台今天微红' };
        },
      },
    });
    await world.start(host);
    host.events.length = 0;
    await call(world, 'stock_brief');
    await world.stop();
    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain('贵州茅台 600519');
    expect(host.events[0]?.text).toBe('鸿酱版播报:茅台今天微红');
  });

  it('人格化关掉就发模板文案', async () => {
    const { world, host } = rig({}, { autoBrief: false, personaMode: 'plain' });
    await world.start(host);
    host.events.length = 0;
    await call(world, 'stock_brief');
    await world.stop();
    const text = host.events[0]?.text ?? '';
    expect(text).toContain('🐱 拟股喵喵 · A 股 · 即时播报');
    expect(text).not.toContain('真实行情素材');
  });
});
