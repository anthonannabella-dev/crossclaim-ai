"""
PaddleOCR Document Service — customs document OCR with structured field extraction.
PaddleOCR is Apache-2.0 licensed.
"""

import re
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = FastAPI(
    title="Customs Document OCR Service",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_ocr_engine = None


def get_ocr():
    global _ocr_engine
    if _ocr_engine is None:
        import logging
        logger.info("[PaddleOCR] 正在加载 OCR 模型（首次加载需要 5-15 秒）...")
        from paddleocr import PaddleOCR
        _ocr_engine = PaddleOCR(
            use_angle_cls=False,       # 关掉角度分类（海关文档基本是正的），省 ~200MB
            lang="ch",
            # use_gpu removed in PaddleOCR 3+
            show_log=False,
            det_db_thresh=0.3,         # 降低检测阈值，加快速度
            det_db_box_thresh=0.3,     # 低 box 阈值加快筛选
            det_limit_side_len=960,    # 限制检测图最长边，减少显存/内存占用
        )
        logger.info("[PaddleOCR] 模型加载完成")
    return _ocr_engine


# ── Models ───────────────────────────────────────────────────────
class OcrRequest(BaseModel):
    image: str = Field(..., description="Base64-encoded image or data URL")


class ExtractedField(BaseModel):
    label: str
    value: str
    confidence: float


class OcrResponse(BaseModel):
    success: bool = True
    text: str = ""
    fields: list[ExtractedField] = []


# ── Field extractors ─────────────────────────────────────────────
def parse_invoice_number(text: str) -> Optional[str]:
    for pat in [
        r"发票号码[：:]\s*([\w-]+)",
        r"发票代码[：:]\s*(\d{10,12})",
        r"Invoice\s*(?:No[.:]?|Number)[：:\s]*([\w-]+)",
        r"INV\s*[-:]\s*(\w{6,})",
        r"No[.:]\s*([A-Z]{2,4}[-]\d{6,})",
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return None


def parse_invoice_amount(text: str) -> Optional[str]:
    for pat in [
        r"(?:合计金额|价税合计|金额合计|Total\s*Amount|Grand\s*Total)[^\d]*([\d,]+[.]?\d*)",
        r"(?:Total|Amount)[：:\s]*[A-Z]{3}\s*([\d,]+[.]?\d*)",
        r"[¥￥]\s*([\d,]+[.]?\d{2})",
        r"USD\s*([\d,]+[.]?\d{2})",
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1).replace(",", "")
    return None


def parse_date(text: str) -> Optional[str]:
    for pat in [
        r"(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})[日]?",
        r"(?:Date|日期)[：:\s]*(\d{4}[-/]\d{2}[-/]\d{2})",
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            groups = m.groups()
            if len(groups) == 3:
                return f"{groups[0]}-{groups[1].zfill(2)}-{groups[2].zfill(2)}"
            return groups[0]
    return None


def parse_consignee(text: str) -> Optional[str]:
    for pat in [
        r"(?:收货人|收货单位|Consignee|To)[：:\s]*([^\n]{4,40})",
        r"(?:买方|进口商|Buyer|Importer)[：:\s]*([^\n]{4,40})",
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return None


def parse_hs_code(text: str) -> Optional[str]:
    m = re.search(r"(?:HS|H\.S\.)\s*(?:Code|编码)?[：:\s]*(\d{4,6}[.]\d{2,4})", text, re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(r"\b(\d{4}[.]\d{2,4})\b", text)
    if m:
        return m.group(1)
    return None


POST_PROCESSORS = [
    ("invoice_number", "发票号", parse_invoice_number),
    ("invoice_amount", "金额", parse_invoice_amount),
    ("date", "日期", parse_date),
    ("consignee", "收货人", parse_consignee),
    ("hs_code", "HS编码", parse_hs_code),
]


# ── Routes ───────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "service": "paddleocr"}


@app.post("/ocr", response_model=OcrResponse)
async def ocr_endpoint(req: OcrRequest):
    import base64

    try:
        image_b64 = req.image
        if "," in image_b64:
            image_b64 = image_b64.split(",", 1)[1]

        image_bytes = base64.b64decode(image_b64)
        if len(image_bytes) == 0:
            raise HTTPException(status_code=400, detail="Empty image data")

        ocr = get_ocr()
        result = ocr.ocr(image_bytes, cls=True)

        lines: list[str] = []
        if result and result[0]:
            for line_group in result[0]:
                if line_group and len(line_group) >= 2:
                    text_part = line_group[1][0] if isinstance(line_group[1], (list, tuple)) else str(line_group[1])
                    lines.append(text_part)

        full_text = "\n".join(lines)
        logger.info("OCR produced %d lines, %d chars", len(lines), len(full_text))

        extracted_fields: list[ExtractedField] = []
        for _key, label, processor in POST_PROCESSORS:
            try:
                value = processor(full_text)
                if value:
                    extracted_fields.append(ExtractedField(
                        label=label, value=value,
                        confidence=0.85 if len(lines) > 10 else 0.7,
                    ))
            except Exception as exc:
                logger.debug("Field %s extraction failed: %s", _key, exc)

        return OcrResponse(text=full_text, fields=extracted_fields)

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("OCR failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"OCR processing failed: {str(exc)}")


@app.on_event("startup")
async def preload_ocr():
    """服务启动时预加载 OCR 模型，避免首次请求超时"""
    import asyncio
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, get_ocr)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002, log_level="info")
