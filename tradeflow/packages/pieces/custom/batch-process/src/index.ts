import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { batchClassifyAction } from './lib/actions/batch-classify';
import { batchTariffAction } from './lib/actions/batch-tariff';

export const batchProcess = createPiece({
  displayName: 'HS批量处理',
  description: '批量HS编码分类与税率查询，支持CSV导入导出',
  logoUrl: 'https://cdn.activepieces.com/pieces/batch-process.png',
  authors: ['TradeFlow'],
  auth: PieceAuth.None(),
  actions: [batchClassifyAction, batchTariffAction],
  triggers: [],
});
