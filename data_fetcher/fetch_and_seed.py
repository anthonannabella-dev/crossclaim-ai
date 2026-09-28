#!/usr/bin/env python3
"""
海关HS编码数据自动获取 & 定期种子脚本
=========================================
用法:
  首次:   python data_fetcher/fetch_and_seed.py
  定时:   作为 cronJob 每月1号运行

数据源优先级:
  1. 海关总署 税则Excel附件 (gov.cn公开) → 需每年手动下载一次
  2. 内置按章节推算的税率规则（增值税、消费税、出口退税、监管条件）
  3. 已有数据的更新

输出:
  - data_fetcher/output/hs_codes_full.json  (补充税率后的完整数据)
  - 直接写入 PostgreSQL 数据库
"""

import json
import sys
import logging
import re
import subprocess
import time
from pathlib import Path
from datetime import datetime
from typing import Optional, List
import requests
from bs4 import BeautifulSoup

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
REQUEST_DELAY = 1.5
MAX_RETRIES = 3
TIMEOUT = 30

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("fetch_and_seed")

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = Path(__file__).parent / "output"
DATA_DIR.mkdir(exist_ok=True)
HS_JSON = DATA_DIR / "hs_codes.json"
HS_FULL_JSON = DATA_DIR / "hs_codes_full.json"


def get_vat_rate(chapter: int) -> float:
    if 1 <= chapter <= 24:
        return 9.0
    return 13.0


def get_export_rebate_rate(code: str, description: str, chapter: int) -> float:
    if chapter == 27:
        return 0.0
    if chapter in (93, 97, 71):
        return 0.0
    if chapter in range(1, 16):
        return 5.0
    if chapter == 72:
        if any(kw in description for kw in ["废", "碎", "粉"]):
            return 0.0
        return 5.0
    if 50 <= chapter <= 63:
        return 13.0
    if 28 <= chapter <= 38:
        return 9.0
    if 84 <= chapter <= 85:
        return 13.0
    return 13.0


def get_excise_rate(code: str, description: str, chapter: int):
    if chapter == 87:
        return 9.0
    if chapter == 27:
        return 15.0
    return None


def get_supervision(chapter: int) -> str:
    if 1 <= chapter <= 15:
        return "A,B"
    if chapter in (28, 29, 27, 87):
        return "O"
    if chapter == 30:
        return "A,Q"
    if chapter == 72:
        return "B"
    if chapter == 93:
        return "G"
    return "一般监管"


def _get_category(chapter: int) -> str:
    if 1 <= chapter <= 24: return "农产品"
    if 25 <= chapter <= 27: return "矿产品"
    if 28 <= chapter <= 38: return "化工品"
    if 39 <= chapter <= 40: return "塑料橡胶"
    if 41 <= chapter <= 43: return "皮革毛皮"
    if 44 <= chapter <= 49: return "木及纸制品"
    if 50 <= chapter <= 63: return "纺织品"
    if 64 <= chapter <= 67: return "鞋帽"
    if 68 <= chapter <= 70: return "石料陶瓷"
    if chapter == 71: return "贵金属"
    if 72 <= chapter <= 83: return "金属制品"
    if 84 <= chapter <= 85: return "机电产品"
    if 86 <= chapter <= 89: return "运输设备"
    if 90 <= chapter <= 92: return "光学仪器"
    if chapter == 93: return "武器"
    if 94 <= chapter <= 96: return "杂项制品"
    if chapter == 97: return "艺术品"
    return "工业品"


def enrich_records(records: list[dict]) -> list[dict]:
    enriched = []
    for rec in records:
        code = rec.get("code", "")
        name = rec.get("name", "") or ""
        chapter_str = rec.get("chapter", "") or code.split(".")[0]
        try:
            chapter = int(chapter_str[:2])
        except ValueError:
            chapter = 84

        if not rec.get("vat_rate"):
            rec["vat_rate"] = get_vat_rate(chapter)
        if not rec.get("export_rate"):
            rec["export_rate"] = get_export_rebate_rate(code, name, chapter)
        if not rec.get("excise_rate"):
            excise = get_excise_rate(code, name, chapter)
            if excise is not None:
                rec["excise_rate"] = excise
        if not rec.get("supervision"):
            rec["supervision"] = get_supervision(chapter)
        if not rec.get("category"):
            rec["category"] = _get_category(chapter)
        if not rec.get("chapter"):
            rec["chapter"] = chapter_str

        enriched.append(rec)
    return enriched


def seed_to_database(records: list[dict]):
    BATCH = 200
    total = len(records)
    logger.info(f"写入数据库: {total} 条, 每批 {BATCH} 条")

    for i in range(0, total, BATCH):
        batch = records[i:i + BATCH]
        for rec in batch:
            code = rec["code"].replace("'", "''")
            desc = (rec.get("name", "") or "").replace("'", "''")
            unit = (rec.get("unit", "") or "").replace("'", "''")
            mfn = rec.get("mfn_rate", 0) or 0
            export = rec.get("export_rate", 0) or 0
            vat = rec.get("vat_rate", 0) or 0
            excise = rec.get("excise_rate", 0) or 0
            supervis = (rec.get("supervision", "") or "").replace("'", "''")
            category = (rec.get("category", "") or "").replace("'", "''")

            sql = f"""INSERT INTO "HSCode" (id, code, description, unit, "tariffRate", "exportRate", "vatRate", "exciseRate", supervision, category, "updatedAt")
VALUES (gen_random_uuid()::text, '{code}', '{desc}', '{unit}', {mfn}, {export}, {vat}, {excise}, '{supervis}', '{category}', NOW())
ON CONFLICT (code) DO UPDATE SET
  description = EXCLUDED.description,
  unit = EXCLUDED.unit,
  "tariffRate" = EXCLUDED."tariffRate",
  "exportRate" = EXCLUDED."exportRate",
  "vatRate" = EXCLUDED."vatRate",
  "exciseRate" = EXCLUDED."exciseRate",
  supervision = EXCLUDED.supervision,
  category = EXCLUDED.category,
  "updatedAt" = NOW();"""

            subprocess.run(
                ["docker", "exec", "-i", "customs-postgres", "psql", "-U", "customs", "-d", "customs_saas", "-c", sql],
                capture_output=True, text=True, timeout=15
            )

        logger.info(f"  {min(i + BATCH, total)}/{total} 完成")

    logger.info(f"数据库写入完成: {total} 条")


def main():
    logger.info("=" * 60)
    logger.info("  海关HS编码数据自动获取与种子脚本")
    logger.info(f"  时间: {datetime.now().isoformat()}")
    logger.info("=" * 60)

    # 尝试从 gov.cn 下载税则Excel
    logger.info("=== 尝试从 gov.cn 获取税则数据 ===")
    # 导入数据源获取函数（见下方 try_fetch_tariff_excel 函数）
    records = try_fetch_tariff_excel()

    if not records:
        # 回退到本地已有数据
        logger.info("  gov.cn 未获取到数据，使用本地已有数据")
        if HS_JSON.exists():
            with open(HS_JSON, encoding='utf-8') as f:
                records = json.load(f)
            logger.info(f"  加载本地数据: {len(records)} 条")
        else:
            logger.error("  无可用HS编码数据文件")
            sys.exit(1)

    # 补全税率
    logger.info("=== 补全税率和监管条件 ===")
    records = enrich_records(records)

    vat_c = sum(1 for r in records if r.get("vat_rate"))
    exp_c = sum(1 for r in records if r.get("export_rate"))
    exc_c = sum(1 for r in records if r.get("excise_rate") and r["excise_rate"] > 0)
    sup_c = sum(1 for r in records if r.get("supervision"))
    logger.info(f"  增值税: {vat_c}/{len(records)}  出口退税: {exp_c}/{len(records)}")
    logger.info(f"  消费税: {exc_c}/{len(records)}  监管条件: {sup_c}/{len(records)}")

    # 导出完整JSON
    with open(HS_FULL_JSON, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    logger.info(f"  完整数据导出: {HS_FULL_JSON}")

    # 写入数据库
    seed_to_database(records)
    logger.info("  全部完成")


# ============================================================


from typing import List, Dict, Tuple, Optional
# 以下代码来自 fetch_and_seed_sources.py
# ============================================================

class Fetcher:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._last = 0.0

    def _pace(self):
        elapsed = time.monotonic() - self._last
        if elapsed < REQUEST_DELAY:
            time.sleep(REQUEST_DELAY - elapsed)
        self._last = time.monotonic()

    def get_text(self, url: str) -> Optional[str]:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                self._pace()
                resp = self.session.get(url, timeout=TIMEOUT, verify=False)
                resp.raise_for_status()
                resp.encoding = resp.apparent_encoding or "utf-8"
                return resp.text
            except Exception as e:
                logger.debug(f"  attempt {attempt}: {e}")
                if attempt < MAX_RETRIES:
                    time.sleep(2 ** attempt)
        return None

    def get_bytes(self, url: str) -> Optional[bytes]:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                self._pace()
                resp = self.session.get(url, timeout=TIMEOUT, verify=False)
                resp.raise_for_status()
                return resp.content
            except Exception as e:
                logger.debug(f"  attempt {attempt}: {e}")
                if attempt < MAX_RETRIES:
                    time.sleep(2 ** attempt)
        return None


def try_fetch_tariff_excel() -> list[dict]:
    """
    尝试从 gov.cn 下载最新《进出口税则》Excel 附件。
    税委会每年发布两次（12月/1月），提供完整的 HS 编码+税率+监管条件。

    URL 格式示例:
      2024年: https://www.gov.cn/zhengce/zhengceku/202401/content_6923631.htm
      2025年: https://www.gov.cn/zhengce/zhengceku/202501/content_6993320.htm

    每年1月需要手动更新此URL，或程序自动探测。
    """
    fetcher = Fetcher()
    records = []

    # 年度公告的典型URL模式
    year = 2025
    urls = [
        # 2025年公告（税则公告通常会发布在 zhengceku 栏目）
        f"https://www.gov.cn/zhengce/zhengceku/{year}01/content_6993320.htm",
        f"https://www.gov.cn/zhengce/content/{year}/content_6993320.htm",
        # 2024年公告
        "https://www.gov.cn/zhengce/zhengceku/202401/content_6923631.htm",
        # 通用模式
        "https://www.gov.cn/zhengce/zhengceku/content/2025/content_6993320.htm",
        "https://www.gov.cn/zhengce/zhengceku/content/2024/content_6923631.htm",
    ]

    for url in urls:
        logger.info(f"  尝试: {url[:60]}...")
        html = fetcher.get_text(url)
        if not html:
            continue

        soup = BeautifulSoup(html, "html.parser")
        excel_links = _find_excel_attachments(soup, url)
        if not excel_links:
            # 也找一下PDF附件
            excel_links = _find_pdf_attachments(soup, url)

        for link_text, excel_url in excel_links:
            logger.info(f"    下载附件: {link_text[:40]} ({excel_url[:80]})")
            data = fetcher.get_bytes(excel_url)
            if data:
                records = _parse_tariff_file(data)
                if records:
                    logger.info(f"    解析到 {len(records)} 条HS编码数据")
                    return records

    return records


def _find_excel_attachments(soup: BeautifulSoup, base_url: str) -> list[tuple]:
    """在页面中查找 Excel 附件链接"""
    links = []
    for a in soup.find_all("a"):
        href = a.get("href", "")
        text = a.get_text(strip=True)
        if ".xls" in href.lower() or ".xlsx" in href.lower():
            full_url = _resolve_url(href, base_url)
            links.append((text or "附件", full_url))
    return links


def _find_pdf_attachments(soup: BeautifulSoup, base_url: str) -> list[tuple]:
    """回退查找 PDF 附件（如果税则以PDF发布）"""
    links = []
    for a in soup.find_all("a"):
        href = a.get("href", "")
        text = a.get_text(strip=True)
        if ".pdf" in href.lower():
            # 只找包含税则/税目/税率的
            if any(kw in text or kw in href for kw in ["税则", "税目", "税率", "关税", "附表", "附件"]):
                full_url = _resolve_url(href, base_url)
                links.append((text or "PDF附件", full_url))
    return links


def _resolve_url(href: str, base_url: str) -> str:
    """补全相对URL"""
    if href.startswith("http"):
        return href
    if href.startswith("//"):
        return f"https:{href}"
    if href.startswith("/"):
        return f"https://www.gov.cn{href}"
    # 相对路径
    base = base_url.rsplit("/", 1)[0]
    return f"{base}/{href}"


def _parse_tariff_file(data: bytes) -> list[dict]:
    """解析海关税则Excel/PDF文件"""
    # 先尝试 Excel 解析
    records = _parse_excel(data)
    if records:
        return records
    # 回退 PDF 解析
    return _parse_pdf(data)


def _parse_excel(data: bytes) -> list[dict]:
    """解析 xlsx 格式税则"""
    try:
        import openpyxl
    except ImportError:
        logger.warning("  需要 openpyxl: pip install openpyxl")
        return []

    try:
        from io import BytesIO
        wb = openpyxl.load_workbook(BytesIO(data), read_only=True, data_only=True)
        ws = wb.active
        if ws is None:
            return []

        records = []
        for row in ws.iter_rows(min_row=3, values_only=True):  # 前2行通常是表头
            if not row or not row[0]:
                continue
            code = str(row[0]).strip()
            if not re.match(r"^\d{4,}\.?\d*$", code):
                continue

            # 标准海关税则列: 编码|名称|计量单位|最惠国税率|暂定税率|增值税率|消费税率|监管条件
            rec = {
                "code": code,
                "name": str(row[1] or "").strip() if len(row) > 1 else "",
                "unit": str(row[2] or "").strip() if len(row) > 2 else "",
                "mfn_rate": _parse_rate(row[3]) if len(row) > 3 else 0.0,
                "export_rate": _parse_rate(row[4]) if len(row) > 4 else 0.0,
                "vat_rate": _parse_rate(row[5]) if len(row) > 5 else 0.0,
                "excise_rate": _parse_rate(row[6]) if len(row) > 6 else 0.0,
                "supervision": str(row[7] or "").strip() if len(row) > 7 else "",
                "chapter": code.split(".")[0][:2],
            }
            records.append(rec)

        return records
    except Exception as e:
        logger.warning(f"  Excel解析失败: {e}")
        return []


def _parse_pdf(data: bytes) -> list[dict]:
    """回退解析PDF（需要 pdfplumber 或 tabula）"""
    try:
        import pdfplumber
    except ImportError:
        logger.warning("  需要 pdfplumber: pip install pdfplumber")
        return []

    try:
        from io import BytesIO
        records = []
        with pdfplumber.open(BytesIO(data)) as pdf:
            for page in pdf.pages:
                tables = page.extract_tables()
                for table in tables:
                    for row in table:
                        if not row or not row[0]:
                            continue
                        code = str(row[0]).strip()
                        if not re.match(r"^\d{4,}\.?\d*$", code):
                            continue
                        records.append({
                            "code": code,
                            "name": str(row[1] or "").strip() if len(row) > 1 else "",
                            "unit": str(row[2] or "").strip() if len(row) > 2 else "",
                            "mfn_rate": _parse_rate(row[3]) if len(row) > 3 else 0.0,
                            "export_rate": _parse_rate(row[4]) if len(row) > 4 else 0.0,
                            "vat_rate": _parse_rate(row[5]) if len(row) > 5 else 0.0,
                            "excise_rate": _parse_rate(row[6]) if len(row) > 6 else 0.0,
                            "supervision": str(row[7] or "").strip() if len(row) > 7 else "",
                            "chapter": code.split(".")[0][:2],
                        })
        return records
    except Exception as e:
        logger.warning(f"  PDF解析失败: {e}")
        return []


def _parse_rate(val) -> float:
    """解析税率值（可能是 None, 字符串, 或数字）"""
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    try:
        return float(re.sub(r"[%\s]", "", str(val)))
    except (ValueError, TypeError):
        return 0.0


if __name__ == "__main__":
    main()
