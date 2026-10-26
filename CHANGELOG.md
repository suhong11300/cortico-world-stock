# Changelog

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
