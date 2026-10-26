import type { ConfigGroup, ConfigProperty } from 'cortico/core/types.ts';
import { DEFAULT_WINDOWS } from './time.ts';

/** 播报事件的唤醒口径。 */
export type BriefTrigger = 'flush' | 'debounce' | 'preempt' | 'interrupt';

/** config.json 的 worlds.stock 段。全部键都是热改键,改完下一次播报即生效。 */
export interface StockConfigSection {
  /** 框架总闸:World 定义里恒为 false,装配与否由部署的 config.json 决定,面板不暴露这个键。 */
  enabled: boolean;
  /** 自动播报总开关;关掉只是不按窗口自动播,手动工具照旧能用。 */
  autoBrief: boolean;
  /** 播报里怎么称呼用户;空字符串表示从部署配置的 worlds.desktop-pet.user 取。 */
  user: string;
  /** 行情源:auto 先东财后退同花顺。 */
  dataSource: 'auto' | 'eastmoney' | 'ths';
  /** 关注列表:600519, sz000001 300750 都行。 */
  watchlist: string;
  /** 是否连大盘三个指数一起报。 */
  showIndex: boolean;
  /** 播报窗口,每段一个时间区间,默认早盘收盘与尾盘收盘。 */
  briefWindows: string;
  /** 播报结束后是否追问一句。 */
  askAfterBrief: boolean;
  /** 文案风格:活泼或克制。 */
  style: 'lively' | 'calm';
  /** 播报事件用哪种唤醒口径。 */
  trigger: BriefTrigger;
  /** 账户数据来源:关 / 手填 / 读导出文件。 */
  accountMode: 'none' | 'manual' | 'csv';
  /** 手填持仓,形如 600519:100:1300.5。 */
  holdings: string;
  /** 导出文件路径,CSV/TSV 都认。 */
  holdingsFile: string;
  /** 关注列表上限,防止一次播报刷屏。 */
  maxWatch: number;
  /** 本机时区;留空用部署给的时区。 */
  zone: string;
}

export const STOCK_DEFAULTS: StockConfigSection = {
  enabled: false,
  autoBrief: true,
  user: '',
  dataSource: 'auto',
  watchlist: '600519,000001',
  showIndex: true,
  briefWindows: DEFAULT_WINDOWS,
  askAfterBrief: true,
  style: 'lively',
  trigger: 'debounce',
  accountMode: 'none',
  holdings: '',
  holdingsFile: '',
  maxWatch: 12,
  zone: '',
};

interface Entry {
  key: string;
  title: string;
  description: string;
  prop: Omit<ConfigProperty, 'title' | 'description'>;
}

const ENTRIES: Entry[] = [
  {
    key: 'worlds.stock.autoBrief',
    title: '自动播报',
    description: '关掉后只在被调用时读行情,不再按窗口自动播报。',
    prop: { type: 'boolean' },
  },
  {
    key: 'worlds.stock.user',
    title: '称呼',
    description: '播报与追问里怎么叫你,例如「鸿」;留空则取桌面宠物世界里的用户称呼。',
    prop: { type: 'string' },
  },
  {
    key: 'worlds.stock.dataSource',
    title: '行情源',
    description: 'auto 先东方财富后退同花顺;同花顺单只取数较慢,且不支持指数。',
    prop: { type: 'string', enum: ['auto', 'eastmoney', 'ths'] },
  },
  {
    key: 'worlds.stock.watchlist',
    title: '关注列表',
    description: '逗号分隔的股票代码,可带 sh/sz/bj 前缀,例如 600519,000001,300750。',
    prop: { type: 'string' },
  },
  {
    key: 'worlds.stock.showIndex',
    title: '带大盘',
    description: '播报时连上证、深成、创业板三个指数一起报。',
    prop: { type: 'boolean' },
  },
  {
    key: 'worlds.stock.briefWindows',
    title: '播报窗口',
    description: '默认早盘收盘 11:25-11:35 与尾盘 14:55-15:05;每段每天只播一次。',
    prop: { type: 'string' },
  },
  {
    key: 'worlds.stock.askAfterBrief',
    title: '播报后追问',
    description: '播完再推一句「请问(称呼),需要查看吗?」。',
    prop: { type: 'boolean' },
  },
  {
    key: 'worlds.stock.style',
    title: '文案风格',
    description: '活泼带表情,或克制只报数。',
    prop: { type: 'string', enum: ['lively', 'calm'] },
  },
  {
    key: 'worlds.stock.trigger',
    title: '唤醒口径',
    description: '播报事件怎么叫醒对话:debounce 攒批、flush 立刻、preempt 打断、interrupt 强插。',
    prop: { type: 'string', enum: ['debounce', 'flush', 'preempt', 'interrupt'] },
  },
  {
    key: 'worlds.stock.accountMode',
    title: '账户数据',
    description: 'none 不接;manual 手填持仓;csv 读券商导出的持仓文件。插件不登录任何券商。',
    prop: { type: 'string', enum: ['none', 'manual', 'csv'] },
  },
  {
    key: 'worlds.stock.holdings',
    title: '手填持仓',
    description: '代码:股数:成本价,逗号分隔;成本价可省,例如 600519:100:1300.5,000001:2000:10.5。',
    prop: { type: 'string' },
  },
  {
    key: 'worlds.stock.holdingsFile',
    title: '持仓文件',
    description: '同花顺/东方财富导出的持仓表,UTF-8 与 GBK 都能读。',
    prop: { type: 'string', 'x-path': { kind: 'file', extensions: ['csv', 'tsv', 'txt'] } },
  },
  {
    key: 'worlds.stock.maxWatch',
    title: '关注上限',
    description: '一次最多播报多少只,防止刷屏。',
    prop: { type: 'number', minimum: 1, maximum: 50 },
  },
  {
    key: 'worlds.stock.zone',
    title: '本机时区',
    description: '留空用部署时区;A 股开收盘恒按北京时间判定。',
    prop: { type: 'string' },
  },
];

/** World 配置的 JSON Schema 声明。 */
export const STOCK_CONFIG_GROUP: ConfigGroup = {
  id: 'world:stock',
  owner: 'world:stock',
  schema: {
    type: 'object',
    title: '拟股喵喵',
    properties: Object.fromEntries(
      ENTRIES.map((e) => [e.key, { ...e.prop, title: e.title, description: e.description, 'x-hot': true }]),
    ),
  },
};
