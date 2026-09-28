# Customs Document OCR Service

FastAPI wrapper around PaddleOCR for processing customs-related documents.

## Quick Start

```bash
pip install -r requirements.txt
python main.py
# → http://localhost:8001/docs
```

## API

### POST /ocr

Accepts base64-encoded image, returns OCR text + structured fields.

```json
// Request
{ "image": "base64-encoded-image-data..." }

// Response
{
  "success": true,
  "text": "Full OCR text...",
  "fields": [
    { "label": "发票号", "value": "INV-2024-00123", "confidence": 0.85 },
    { "label": "金额", "value": "12345.67", "confidence": 0.85 }
  ]
}
```

### GET /health

Health check endpoint.

## Post-Processing Fields

Custom post-processors extract:

| Field | Description | Matches |
|-------|-------------|---------|
| invoice_number | Invoice number | 发票号码, Invoice No., INV-xxx |
| invoice_amount | Total amount | 合计金额, Total, Grand Total |
| date | Document date | 2024-01-15, 2024年01月15日 |
| consignee | Consignee name | 收货人, Consignee, Buyer |
| hs_code | HS code | HS Code / HS编码 |
| quantity_weight | Quantity/weight | 毛重, Net Weight, Quantity |

## License & Attribution

**PaddleOCR** is used under the Apache License 2.0.
- Repository: https://github.com/PaddlePaddle/PaddleOCR
- License: https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE

This wrapper service itself is MIT licensed.

## Commercial Use

PaddleOCR's Apache-2.0 license permits commercial use without
restriction. No GPL, AGPL, or SSPL licensed code is included.
