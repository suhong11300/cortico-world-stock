import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { STOCK_DEFAULTS, type StockConfigSection } from './config.ts';
import { STOCK_TOOL_DECLS, StockWorld } from './world.ts';

export const STOCK: WorldDefinition<StockConfigSection> = {
  id: 'stock',
  label: '拟股喵喵',
  defaults: () => ({ ...STOCK_DEFAULTS }),
  // `ctx.cfg` 是 `worlds.stock` 的活引用:面板上改一个键,下一次播报就吃到新值。
  create: (ctx) =>
    new StockWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      dataDir: ctx.dataDir,
      ...(ctx.botDir ? { botDir: ctx.botDir } : {}),
      persist: (patch) => ctx.persist(patch),
    }),
  // 自描述:可能出现的全部工具与会推出的全部事件,不进提示词。
  describe: {
    tools: describeTools(STOCK_TOOL_DECLS, {
      stock_setup: { zh: '报时区、当前时间、市场状态、播报窗口、关注列表与账户模式。', en: 'Reports the resolved clock, session phase, brief windows, watchlist and account mode.' },
      stock_now: { zh: '立刻取一次行情并给出播报文案,不推送事件。', en: 'Fetches quotes and returns a briefing without pushing an event.' },
      stock_brief: { zh: '完整播报一次:推 stock.brief 与追问事件。', en: 'Runs a full briefing and pushes the brief and follow-up events.' },
      stock_watch: { zh: '查看或增删关注列表。', en: 'Reads or changes the watchlist.' },
      stock_account: { zh: '查看或切换持仓来源(关/手填/文件),不登录任何券商。', en: 'Inspects or switches the holdings source; never logs in to a broker.' },
      stock_schedule: { zh: '报播报窗口、今天播过几次、下一段什么时候。', en: 'Reports brief windows, what fired today and when the next one is due.' },
    }),
    events: [
      {
        type: 'stock.ready',
        description: { zh: '挂载或跨日时先对表:报出时区、北京时间与市场状态。', en: 'On mount or on a new day, fixes the time zone, Beijing time and session phase.' },
      },
      {
        type: 'stock.brief',
        description: { zh: '收盘时段的涨跌播报,正文就是完整文案。', en: 'The closing-window briefing; its text is the whole message.' },
      },
      {
        type: 'stock.ask',
        description: { zh: '播报后的追问「请问(称呼),需要查看吗?」。', en: 'The follow-up question asked right after a briefing.' },
      },
    ],
  },
};
