import {
  createPiece,
  PieceAuth,
  Property,
} from '@activepieces/pieces-framework';
import { hsClassifyAction } from './lib/actions/classify';

export const hsClassify = createPiece({
  displayName: 'HS智能归类',
  description: 'AI驱动的海关HS编码智能分类，支持商品描述和图片识别',
  logoUrl: 'https://cdn.activepieces.com/pieces/hs-classify.png',
  authors: ['TradeFlow'],
  auth: PieceAuth.None(),
  actions: [hsClassifyAction],
  triggers: [],
});
