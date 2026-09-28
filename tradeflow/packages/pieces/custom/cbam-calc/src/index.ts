import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { cbamCalculateAction } from './lib/actions/calculate';
import { cbamSectorAction } from './lib/actions/sectors';
import { cbamBatchAction } from './lib/actions/batch';

export const cbamCalc = createPiece({
  displayName: 'CBAM碳关税计算',
  description: '欧盟碳边境调节机制(CBAM)碳关税计算器，支持钢铁/铝/水泥/化肥/电力/氢行业',
  logoUrl: 'https://cdn.activepieces.com/pieces/cbam-calc.png',
  authors: ['TradeFlow'],
  auth: PieceAuth.None(),
  actions: [cbamCalculateAction, cbamSectorAction, cbamBatchAction],
  triggers: [],
});
