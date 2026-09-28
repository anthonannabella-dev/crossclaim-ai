# Originally from https://github.com/mmourani/hscode-scraper (MIT License)
# Adapted for 报关合规SaaS — rewritten with renamed identifiers and restructured logic
"""
China Customs HS Code Scraper
==============================
Fetches HS code classifications and tariff data from publicly available
Chinese customs information sources.

License: MIT — see LICENSE.txt for full text and attributions.
"""

import json
import time
import logging
from pathlib import Path
from typing import Optional

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# ── Configuration ──────────────────────────────────────────────
OUTPUT_DIR = Path(__file__).parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

# Public customs tariff data sources (open government data)
# These are publicly accessible information disclosure URLs
TARIFF_SOURCES = [
    {
        "name": "customs_gov_cn",
        "base_url": "http://www.customs.gov.cn",
        "search_path": "/customs/302249/302266/302267/index.html",
        "description": "Customs Tariff Commission public notices",
    },
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; CustomsDataBot/1.0; +https://customs-saas.example.com/bot)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

REQUEST_DELAY = 2.0  # seconds between requests — be respectful
MAX_RETRIES = 3
TIMEOUT = 30


# ── Data Models ────────────────────────────────────────────────
class TariffEntry:
    """Single HS code tariff record."""

    def __init__(self, code: str, name: str, unit: str = "",
                 mfn_rate: float = 0.0, export_rate: float = 0.0,
                 vat_rate: float = 0.0, excise_rate: float = 0.0,
                 supervision: str = "", chapter: str = ""):
        self.code = code
        self.name = name
        self.unit = unit
        self.mfn_rate = mfn_rate
        self.export_rate = export_rate
        self.vat_rate = vat_rate
        self.excise_rate = excise_rate
        self.supervision = supervision
        self.chapter = chapter

    def as_dict(self) -> dict:
        return {
            "code": self.code,
            "name": self.name,
            "unit": self.unit,
            "mfn_rate": self.mfn_rate,
            "export_rate": self.export_rate,
            "vat_rate": self.vat_rate,
            "excise_rate": self.excise_rate,
            "supervision": self.supervision,
            "chapter": self.chapter,
        }


# ── HTTP Client ────────────────────────────────────────────────
class PageFetcher:
    """Fetches HTML pages with retry and polite delays."""

    def __init__(self, delay: float = REQUEST_DELAY):
        self.delay = delay
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._last_request = 0.0

    def _respect_rate(self):
        elapsed = time.monotonic() - self._last_request
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)
        self._last_request = time.monotonic()

    def fetch(self, url: str) -> Optional[str]:
        """Fetch a page with retry logic. Returns HTML text or None."""
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                self._respect_rate()
                logger.info("Fetching %s (attempt %d/%d)", url, attempt, MAX_RETRIES)
                resp = self.session.get(url, timeout=TIMEOUT)
                resp.raise_for_status()
                resp.encoding = resp.apparent_encoding or "utf-8"
                return resp.text
            except requests.RequestException as exc:
                logger.warning("  Request failed: %s", exc)
                if attempt < MAX_RETRIES:
                    time.sleep(2 ** attempt)
        return None


# ── Parsers ────────────────────────────────────────────────────
def parse_hs_table(html: str, chapter: str = "") -> list[TariffEntry]:
    """Extract HS codes from an HTML table on customs pages."""
    entries: list[TariffEntry] = []
    soup = BeautifulSoup(html, "html.parser")

    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        for row in rows:
            cells = row.find_all(["td", "th"])
            if len(cells) < 3:
                continue
            text_cells = [c.get_text(strip=True) for c in cells]

            code = _extract_code(text_cells)
            if not code:
                continue

            name = text_cells[1] if len(text_cells) > 1 else ""
            unit = text_cells[2] if len(text_cells) > 2 else ""
            mfn = _parse_rate(text_cells[3]) if len(text_cells) > 3 else 0.0
            export = _parse_rate(text_cells[4]) if len(text_cells) > 4 else 0.0

            entries.append(TariffEntry(
                code=code, name=name, unit=unit,
                mfn_rate=mfn, export_rate=export,
                chapter=chapter,
            ))

    return entries


def _extract_code(cells: list[str]) -> str:
    """Identify and clean an HS code from table cell text."""
    import re
    for text in cells:
        match = re.search(r"(\d{4,6}[.]\d{2,4})", text)
        if match:
            return match.group(1)
    # Also match 8-10 digit codes without dots
    for text in cells:
        if re.match(r"^\d{8,10}$", text):
            code = text
            if len(code) >= 8:
                return f"{code[:4]}.{code[4:6]}.{code[6:]}"
    return ""


def _parse_rate(text: str) -> float:
    """Parse a tariff rate percentage from text like '6.5%' or '0'."""
    import re
    match = re.search(r"(\d+(?:[.]\d+)?)", str(text))
    if match:
        return float(match.group(1))
    return 0.0


# ── Static Fallback Data ──────────────────────────────────────
def load_builtin_hs_data() -> list[TariffEntry]:
    """Return built-in HS code data as fallback when scraping is unavailable.

    This covers common chapters for initial testing. Based on publicly
    published MFN tariff schedules available from customs.gov.cn.
    """
    records = [
        # Chapter 85 — Electrical machinery
        ("8507.60.00", "锂离子蓄电池", "个", 10.0, 0.0),
        ("8504.40.13", "逆变器", "个", 0.0, 0.0),
        ("8504.40.99", "其他静止式变流器", "个", 10.0, 0.0),
        ("8541.43.00", "光伏电池", "个", 0.0, 0.0),
        ("8542.31.90", "其他集成电路", "个", 0.0, 0.0),
        ("8501.31.00", "直流电动机≤750W", "台", 12.0, 0.0),
        ("8507.90.90", "蓄电池零件", "千克", 7.0, 0.0),
        ("8537.10.90", "其他电力控制装置≤1000V", "个", 5.0, 0.0),
        ("8544.42.11", "带接头数据线≤80V", "千克", 0.0, 0.0),
        ("8503.00.90", "电动机/发电机零件", "千克", 8.0, 0.0),
        # Chapter 84 — Machinery
        ("8471.30.90", "其他便携式数据处理设备", "台", 0.0, 0.0),
        ("8473.30.90", "IT设备零件", "千克", 0.0, 0.0),
        ("8419.19.00", "其他瞬时热水器", "台", 10.0, 0.0),
        ("8421.39.90", "其他气体过滤机", "台", 5.0, 0.0),
        ("8431.49.99", "工程机械零件", "千克", 5.0, 0.0),
        ("8481.80.90", "其他阀门", "套/千克", 7.0, 0.0),
        # Chapter 72 — Steel
        ("7208.51.00", "热轧钢板≥10mm", "千克", 6.0, 0.0),
        ("7209.16.00", "冷轧钢板1-3mm", "千克", 6.0, 0.0),
        ("7210.49.00", "镀锌钢板", "千克", 4.0, 0.0),
        ("7225.11.00", "取向硅钢片", "千克", 3.0, 0.0),
        # Chapter 73 — Steel articles
        ("7308.90.00", "钢结构件", "千克", 8.0, 0.0),
        ("7326.90.90", "其他钢铁制品", "千克", 8.0, 0.0),
        # Chapter 39 — Plastics
        ("3901.10.00", "聚乙烯<0.94", "千克", 6.5, 0.0),
        ("3902.10.00", "聚丙烯", "千克", 6.5, 0.0),
        ("3907.40.00", "聚碳酸酯", "千克", 6.5, 0.0),
        # Chapter 94 — Furniture
        ("9401.71.00", "金属框架坐具", "件", 0.0, 0.0),
        ("9403.60.99", "其他木家具", "件", 0.0, 0.0),
        ("9405.40.90", "其他电灯及照明装置", "千克", 10.0, 0.0),
        # Chapter 61-62 — Apparel
        ("6110.30.00", "化纤制针织套头衫", "件/千克", 6.0, 0.0),
        ("6204.43.00", "化纤制女式连衣裙", "件/千克", 6.0, 0.0),
    ]
    return [TariffEntry(code=c, name=n, unit=u, mfn_rate=m, export_rate=e) for c, n, u, m, e in records]


# ── Main Scraper ───────────────────────────────────────────────
class HsCodeScraper:
    """Orchestrates HS code data collection from multiple sources."""

    def __init__(self):
        self.fetcher = PageFetcher()
        self.records: list[TariffEntry] = []

    def collect(self) -> list[TariffEntry]:
        """Run the full collection pipeline."""
        logger.info("Starting HS code collection from %d source(s)...", len(TARIFF_SOURCES))

        scraped_count = 0
        for source in TARIFF_SOURCES:
            url = source["base_url"] + source["search_path"]
            html = self.fetcher.fetch(url)
            if html:
                entries = parse_hs_table(html, chapter=source["name"])
                self.records.extend(entries)
                scraped_count += len(entries)
                logger.info("  %s: %d entries parsed", source["name"], len(entries))
            else:
                logger.warning("  %s: failed to fetch", source["name"])

        # Fallback: use built-in data if scraping yielded insufficient results
        if scraped_count < 10:
            logger.info("Scraped %d entries (< 10). Loading built-in fallback data.", scraped_count)
            fallback = load_builtin_hs_data()
            self.records.extend(fallback)
            # Deduplicate by HS code
            seen = set()
            deduped: list[TariffEntry] = []
            for r in self.records:
                if r.code not in seen:
                    seen.add(r.code)
                    deduped.append(r)
            self.records = deduped

        logger.info("Total collected: %d HS code entries", len(self.records))
        return self.records

    def export_json(self, filename: str = "hs_codes.json") -> Path:
        """Export collected records to JSON."""
        path = OUTPUT_DIR / filename
        data = [r.as_dict() for r in self.records]
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info("Exported %d records to %s", len(data), path)
        return path

    def export_csv(self, filename: str = "hs_codes.csv") -> Path:
        """Export collected records to CSV."""
        import csv
        path = OUTPUT_DIR / filename
        if not self.records:
            logger.warning("No records to export.")
            return path
        fieldnames = ["code", "name", "unit", "mfn_rate", "export_rate", "vat_rate", "excise_rate", "supervision", "chapter"]
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for r in self.records:
                writer.writerow(r.as_dict())
        logger.info("Exported %d records to %s", len(self.records), path)
        return path


# ── CLI ────────────────────────────────────────────────────────
def main():
    logger.info("=" * 50)
    logger.info("  China Customs HS Code Data Fetcher")
    logger.info("  Target: customs.gov.cn public pages")
    logger.info("=" * 50)

    scraper = HsCodeScraper()
    records = scraper.collect()

    json_path = scraper.export_json()
    csv_path = scraper.export_csv()

    print(f"\nDone. {len(records)} HS codes saved:")
    print(f"  JSON: {json_path}")
    print(f"  CSV:  {csv_path}")
    print(f"\nSample entries:")
    for r in records[:10]:
        print(f"  {r.code}  {r.name[:40]:40s}  MFN:{r.mfn_rate:>5.1f}%  Unit:{r.unit}")


if __name__ == "__main__":
    main()
