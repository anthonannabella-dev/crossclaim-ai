"""
CrossClaim AI · 文档解析 + 智能体编排服务面
=================================================
职责边界（重要）：
  - 本服务是【纯函数式】的解析与推理服务：收文档 → 返回结构化/建议。
  - 它【不写数据库】、【不掌管业务状态】。业务状态归 CrossClaim Core + Temporal。
  - 产出的是「建议 + 草稿 + 置信度」，永远不直接改账本。

依赖是可选的：
  Docling / LangGraph 未安装时，对应端点返回 501 并给出安装指引，
  服务本身仍能启动、/health 仍可用。这样本地没装重依赖也能跑通链路。
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

app = FastAPI(
    title="CrossClaim AI Service",
    version="0.1.0",
    description="文档解析（Docling）+ 智能体编排（LangGraph）。不写库、不管状态。",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------
# 可选依赖探测
# ---------------------------------------------------------------
def _try_import_docling() -> Optional[Any]:
    try:
        from docling.document_converter import DocumentConverter  # type: ignore

        return DocumentConverter
    except Exception:  # noqa: BLE001
        return None


def _try_import_langgraph() -> Optional[Any]:
    try:
        from langgraph.graph import StateGraph  # type: ignore

        return StateGraph
    except Exception:  # noqa: BLE001
        return None


DOCLING_AVAILABLE = _try_import_docling() is not None
LANGGRAPH_AVAILABLE = _try_import_langgraph() is not None


# ---------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------
class ParseResult(BaseModel):
    file_name: str
    format: str = "markdown"
    content: str
    tables_count: int = 0
    pages: int = 0


class AnalyzeRequest(BaseModel):
    """异常/拒赔的分析请求。输入是案件要素，输出是『建议』，不是结论。"""

    case_id: str = Field(..., description="CrossClaim 案件 ID")
    channel: str = Field(..., description="AMAZON / UPS / FEDEX / FREIGHT / INSURANCE / CUSTOMS")
    claimed_amount: Optional[float] = None
    currency: str = "USD"
    context: str = Field("", description="合同条款 / 费率表 / 拒赔函等文本")
    question: str = Field("责任方是谁？证据是否充分？", description="想问的问题")


class AnalyzeResult(BaseModel):
    """注意：这些字段是『建议』，落库前须经规则引擎或人工确认。"""

    responsible_party: Optional[str] = None
    confidence: float = 0.0
    reasons: list[str] = []
    missing_evidence: list[str] = []
    risk_notes: list[str] = []
    appeal_draft: Optional[str] = None
    engine: str = "stub"


# ---------------------------------------------------------------
# 端点
# ---------------------------------------------------------------
@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "docling": DOCLING_AVAILABLE,
        "langgraph": LANGGRAPH_AVAILABLE,
        "writes_database": False,
    }


@app.post("/parse", response_model=ParseResult)
async def parse_document(file: UploadFile = File(...)) -> ParseResult:
    """解析 PDF / DOCX / 扫描件为结构化文本 + 表格。"""
    if not DOCLING_AVAILABLE:
        raise HTTPException(
            status_code=501,
            detail="Docling 未安装。安装: pip install -r ai_service/requirements.txt",
        )

    import tempfile

    suffix = os.path.splitext(file.filename or "upload")[0], os.path.splitext(file.filename or "")[1]
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix[1]) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        converter = _try_import_docling()()
        doc = converter.convert(tmp_path).document
        markdown = doc.export_to_markdown()
        tables = len(getattr(doc, "tables", []) or [])
        pages = len(getattr(doc, "pages", {}) or {})
        return ParseResult(
            file_name=file.filename or "upload",
            content=markdown,
            tables_count=tables,
            pages=pages,
        )
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@app.post("/analyze", response_model=AnalyzeResult)
async def analyze(req: AnalyzeRequest) -> AnalyzeResult:
    """
    对追回案件做辅助分析，返回【建议】。
    未配置 LangGraph 时返回 engine="stub" 的空建议，调用方应视为『未分析』。
    """
    if not LANGGRAPH_AVAILABLE:
        return AnalyzeResult(
            engine="stub",
            risk_notes=["LangGraph 未安装，本次未做智能分析（这不代表没有风险）。"],
        )

    # LangGraph 图的具体节点按渠道逐步补齐；此处保持最小可用，便于先打通链路。
    return AnalyzeResult(
        engine="langgraph",
        risk_notes=["LangGraph 已就绪，但具体分析图尚未接入（阶段 2 实现）。"],
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8003")))

