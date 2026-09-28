# ai_service —— CrossClaim AI 服务面

文档解析（Docling）+ 智能体编排（LangGraph）。

## 职责边界（重要）

本服务是**纯函数式**的解析与推理服务：

- 收文档 → 返回结构化文本 + 建议
- **不写数据库**
- **不掌管业务状态**（业务状态归 CrossClaim Core + Temporal）
- 产出的是「建议 + 草稿 + 置信度」，**永远不直接改账本**

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，同时报告 Docling / LangGraph 是否可用 |
| POST | `/parse` | 上传 PDF/DOCX → 返回 Markdown + 表格数（需要 Docling） |
| POST | `/analyze` | 传案件要素 → 返回责任方判断/缺失证据/风险说明（需要 LangGraph） |

未安装重依赖时，`/parse` 与 `/analyze` 返回 501 或 `engine="stub"`，
**服务本身仍能启动**，便于先打通链路。

## 运行

### 方式一：Docker（推荐，本机无需装 Python）

```bash
cd ai_service
docker build -t crossclaim-ai-service .
docker run --rm -p 8003:8003 crossclaim-ai-service
```

> ⚠️ 首次构建会拉取较重的依赖（含 PyTorch），**预留数 GB 磁盘**。

### 方式二：本机 venv

```bash
python -m venv .venv
.venv/Scripts/activate      # Windows
pip install -r requirements.txt
uvicorn main:app --reload --port 8003
```

## 许可证

- 本服务代码：自有
- FastAPI / Uvicorn / Pydantic / Docling / LangGraph：**MIT**
- ⚠️ **Docling 的代码是 MIT，但它加载的模型权重有各自的许可证。**
  在启用任何模型之前，必须先在仓库根 `MODEL_LICENSES.md` 里登记并核实。

