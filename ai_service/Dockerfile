FROM python:3.12-slim

WORKDIR /app

# Docling 处理 PDF/图片需要这些系统库
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libgomp1 poppler-utils \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
# 首次构建会拉取较重的依赖（含 PyTorch），预留数 GB 磁盘
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py ./

EXPOSE 8003
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003"]

