/** 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。 */
import { STOCK } from './definition.ts';

export default STOCK;
export { STOCK };
export type { StockConfigSection } from './config.ts';
