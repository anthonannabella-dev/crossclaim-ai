import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { mfnRateAction } from './lib/actions/mfn-rate';
import { ftaCompareAction } from './lib/actions/fta-compare';
import { rcepAnalysisAction } from './lib/actions/rcep-analysis';

export const tariffRate = createPiece({
  displayName: '关税税率查询',
  description: '查询HS编码的MFN税率、FTA优惠税率对比、RCEP深度分析',
  logoUrl: 'https://cdn.activepieces.com/pieces/tariff-rate.png',
  authors: ['TradeFlow'],
  auth: PieceAuth.None(),
  actions: [mfnRateAction, ftaCompareAction, rcepAnalysisAction],
  triggers: [],
});
