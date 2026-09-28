# TradeFlow Pieces

4 custom Activepieces Piece plugins for customs compliance SaaS (报关合规SaaS).

| Piece | Package | Actions | Description |
|-------|---------|---------|-------------|
| HS智能归类 | `@tradeflow/piece-hs-classify` | 1 | AI-powered HS code classification |
| HS批量处理 | `@tradeflow/piece-batch-process` | 2 | Batch classify + batch tariff query |
| 关税税率查询 | `@tradeflow/piece-tariff-rate` | 3 | MFN rates, FTA comparison, RCEP analysis |
| CBAM碳关税计算 | `@tradeflow/piece-cbam-calc` | 3 | EU CBAM carbon cost calculator |

**Total: 9 actions** covering the full customs compliance workflow.

## Installation

### Prerequisites

- [Activepieces](https://github.com/activepieces/activepieces) instance (MIT licensed)
- Node.js 18+ / Bun

### Step 1: Copy pieces into Activepieces

```bash
# Clone Activepieces
git clone https://github.com/activepieces/activepieces.git
cd activepieces

# Copy TradeFlow custom pieces
cp -r /path/to/tradeflow/packages/pieces/custom/* packages/pieces/custom/
```

### Step 2: Register the pieces

Add to `packages/pieces/framework/src/index.ts` or the piece registry:

These pieces use `PieceAuth.None()` — no authentication required. They will be auto-discovered by the Activepieces piece scanner.

### Step 3: Start Activepieces

```bash
bun run dev
# or: npm run dev
```

### Step 4: Verify

1. Open `http://localhost:4200`
2. Create a new Flow
3. Search "HS" in the step selector
4. You should see all 4 TradeFlow pieces:
   - **HS智能归类** — classify products by description
   - **HS批量处理** — batch classify & tariff query
   - **关税税率查询** — MFN + FTA + RCEP rates
   - **CBAM碳关税计算** — carbon border tax calculator

## AI Auto-Flow

Activepieces AI mode can generate complete flows from natural language. Example prompts:

| Prompt | Expected Flow |
|--------|---------------|
| "帮我查询锂电池的HS编码" | HS智能归类 → classify_hs_code |
| "批量归类这些商品：光伏组件、逆变器、电缆" | HS批量处理 → batch_classify |
| "查询8507.60.00的RCEP优惠税率" | 关税税率查询 → rcep_analysis |
| "计算钢铁出口欧盟的CBAM碳关税" | CBAM碳关税计算 → calculate_cbam |
| "对比8507.60.00在所有FTA中的税率" | 关税税率查询 → compare_fta_rates |

## Mock Data

All pieces currently use built-in mock data. The data structure matches what real API calls would return — swap in real API calls by uncommenting the `httpClient.sendRequest()` blocks in each action file.

Real API endpoints (to be connected):
- `POST /api/ai/smart-classify` — AI HS classification
- `GET /api/hscode/public/search?keyword=` — HS code lookup
- `GET /api/tariff/mfn?code=` — MFN tariff rate
- `GET /api/tariff/fta?code=&origin=` — FTA comparison
- `GET /api/cbam/calculate?hsCode=&weight=` — CBAM calculation

Set `TRADEFLOW_API_URL` environment variable to point to your backend.

## Development

```bash
# Install dependencies
npm install

# Type-check all pieces
cd packages/pieces/custom/hs-classify && npx tsc --noEmit
cd packages/pieces/custom/batch-process && npx tsc --noEmit
cd packages/pieces/custom/tariff-rate && npx tsc --noEmit
cd packages/pieces/custom/cbam-calc && npx tsc --noEmit
```

## License

MIT — see [LICENSE.txt](LICENSE.txt)
