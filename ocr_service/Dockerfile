# ============================================================
# Stage 1: Base — system dependencies
# ============================================================
FROM python:3.11-slim AS base

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libgomp1 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ============================================================
# Stage 2: Lightweight Python deps (fastapi, uvicorn)
#   — cached unless requirements-base.txt changes
# ============================================================
FROM base AS deps-base

COPY requirements-base.txt .
RUN pip install --no-cache-dir --default-timeout=120 -r requirements-base.txt \
    && rm -rf ~/.cache/pip

# ============================================================
# Stage 3: PaddlePaddle CPU (large, rarely changes)
# ============================================================
FROM deps-base AS deps-paddle

RUN pip install --no-cache-dir --default-timeout=300 paddlepaddle==3.0.0 \
    && rm -rf ~/.cache/pip

# ============================================================
# Stage 4: PaddleOCR (updated more frequently)
# ============================================================
FROM deps-paddle AS deps-ocr

RUN pip install --no-cache-dir --default-timeout=300 paddleocr==2.9.0 \
    && rm -rf ~/.cache/pip \
    # Pre-download slim models at build time so runtime doesn't fetch
    && python -c "from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=False, lang='ch', show_log=False, det_db_thresh=0.3)" \
    && rm -rf ~/.cache/pip

# ============================================================
# Stage 5: Final — app code
# ============================================================
FROM deps-ocr

COPY main.py .

EXPOSE 8002

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s \
    CMD curl -f http://localhost:8002/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8002"]
