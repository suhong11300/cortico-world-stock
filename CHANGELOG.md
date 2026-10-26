# Changelog

## 0.2.0

双市场（A 股 / 美股）、可配指数、播报范围与人格化播报。

- 新增 `market`（`auto` / `cn` / `us`）：`auto` 按本机时区判定，`America/*` 走美股
- 新增 `indexList` / `usIndex` / `usWindows`：指数清单与播报窗口都可配，A 股默认含科创 50，美股默认道指 / 纳指 / 标普 500
- 美股 09:30–16:00 连续成交，新增阶段 `trading`（「盘中」）；`ClockInfo` 加 `market` / `marketLabel` / `marketZone`
- 东财取数加第二条路：批量 `ulist.np/get` 被风控掐断（实测某些网络直接 RST）时逐只走 `stock/get`，两条都带 `fltt=2`；两条都失败才报错
- 行情层支持美股指数（东财 `100.` 前缀，`DJI`→`DJIA`、`IXIC`→`NDX` 别名）；同花顺遇到美股明确报不支持，不静默给错数
- 新增 `briefScope`（`both` / `watch` / `account`）：只播关注、或只播持仓盈亏
- 新增 `personaMode`（`rewrite` / `plain`）：`rewrite` 优先走 `host.cognition`，没有就把真实行情作为素材交给会话模型按人格改写；数字与个股不允许改
- 账户那行币种跟市场走（`¥` / `$`），盈亏带千分位（`¥+4,950.00`）
- `envPromptVars` 从 6 键扩到 8 键（新增 `stock.market` / `stock.index`）
- 新配图两张：`screenshots/us-brief.svg`、`screenshots/persona.svg`
- 真机装上后补的健壮性修复：启动问候投递失败不再拖垮定时器（宿主 core 还没就绪时 `pushEvent` 会抛错，原来它一抛 tick 就根本没起来），改成失败两秒后补投一次；另加「就绪 / 已播报」两条 info 日志，在宿主 core.log 里能直接看出生效市场、窗口与今日播报次数
- 测试 81 → **107** 项（时区 19、行情 26、持仓 12、文案 18、整机 32）

## 0.1.0

首个版本。

- 六个工具：`stock_setup` / `stock_now` / `stock_brief` / `stock_watch` / `stock_account` / `stock_schedule`
- 三个事件：`stock.ready` / `stock.brief` / `stock.ask`
- 双数据源（东方财富批量、同花顺单只分时）加 `auto` 回退；两路都空才报失败
- 播报窗口打卡落在 `state.json`，同一交易日同一窗口只播一次，跨日清空
- 持仓三档：`none` / `manual` / `csv`，CSV 支持引号千分位与 GBK 兜底
- 九档分档文案，`lively` / `calm` 两种风格
- 时区：市场时钟固定 `Asia/Shanghai`，宿主时区不同才补一行「你那边」
- 图标与两张示意图（`cortico.icon` / `cortico.screenshots`）
- 81 项测试覆盖时区、行情解析、持仓、文案与整机装配
