/** 时间戳与数字的显示格式化:只做字符串拼装,便于测试。 */

/** `20261026` + 可选 `HHMM` 拼成毫秒时间戳(按北京时间);拼不出就返回 null。 */
export function formatQuoteTime(dateText: string, hhmm?: string): number | null {
  if (!/^\d{8}$/.test(dateText)) return null;
  const year = Number(dateText.slice(0, 4));
  const month = Number(dateText.slice(4, 6));
  const day = Number(dateText.slice(6, 8));
  let hour = 0;
  let minute = 0;
  if (hhmm && /^\d{4}$/.test(hhmm)) {
    hour = Number(hhmm.slice(0, 2));
    minute = Number(hhmm.slice(2, 4));
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute) - 8 * 60 * 60 * 1000;
  return Number.isFinite(utc) ? utc : null;
}

/** 价格保留两位(基金/债也够用);涨跌幅保留两位带符号。 */
export function money(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function signed(value: number, digits = 2): string {
  if (!Number.isFinite(value) || value === 0) return digits === 2 ? '0.00' : '0';
  return (value > 0 ? '+' : '') + value.toFixed(digits);
}

export function percent(value: number): string {
  return signed(value, 2) + '%';
}

/** 大额成交额换算成「亿 / 万」,文案里更好读。 */
export function amountText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1e8) return (value / 1e8).toFixed(2) + ' 亿';
  if (value >= 1e4) return (value / 1e4).toFixed(2) + ' 万';
  return value.toFixed(0);
}
