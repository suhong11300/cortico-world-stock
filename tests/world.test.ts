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

  it('环境提示词给出六个占位符', () => {
    const { world } = rig();
    expect(world.envPromptVars()).toEqual({
      'stock.now': '2026-10-26 11:30:00',
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
    expect(text).toContain('🐱 拟股喵喵 · 即时播报');
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
    expect(text).toContain('🗓 播报窗口:11:25-11:35、14:55-15:05');
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