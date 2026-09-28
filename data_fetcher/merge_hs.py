"""
HS Code Merger — combines all data sources into final hs_codes.json
Run after: python bulk_scrape_hs.py && python expand_hs_tree.py
"""
import json
import re
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent / "output"
SOURCES = [
    ("hs_codes.json", "bulk_scraper"),           # from bulk_scrape_hs.py + scrape_hs.py
    ("hs_codes_expanded.json", "tree_expander"),  # from expand_hs_tree.py
]

def norm_code(raw: str) -> str:
    """Normalize HS code to 'XXXX.XX.XX.XX' format."""
    digits = re.sub(r'[^0-9]', '', raw)
    if len(digits) <= 4:
        return digits
    elif len(digits) <= 6:
        return f"{digits[:4]}.{digits[4:]}"
    elif len(digits) <= 8:
        return f"{digits[:4]}.{digits[4:6]}.{digits[6:]}"
    else:
        return f"{digits[:4]}.{digits[4:6]}.{digits[6:8]}.{digits[8:10]}"


def main():
    seen = set()
    merged = []

    for filename, source_name in SOURCES:
        path = OUTPUT_DIR / filename
        if not path.exists():
            print(f"SKIP: {path} not found (run the corresponding script first)")
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        added = 0
        for rec in data:
            raw_code = rec.get("code", "")
            code = norm_code(raw_code)
            if code and code not in seen:
                # Normalize fields for seed_hs.ts compatibility
                merged.append({
                    "code": code,
                    "name": rec.get("name", rec.get("description", "")),
                    "unit": rec.get("unit", ""),
                    "mfn_rate": rec.get("mfn_rate", rec.get("tariffRate", 0)),
                    "export_rate": rec.get("export_rate", 0),
                    "vat_rate": rec.get("vat_rate", 0),
                    "excise_rate": rec.get("excise_rate", 0),
                    "supervision": rec.get("supervision", ""),
                    "chapter": rec.get("chapter", code.split(".")[0] if code else ""),
                })
                seen.add(code)
                added += 1
        print(f"  {filename}: {added} new records (source: {source_name})")

    # Sort
    merged.sort(key=lambda r: r["code"])

    # Write final output
    out_path = OUTPUT_DIR / "hs_codes.json"
    out_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nFinal: {len(merged)} HS codes → {out_path}")
    print(f"Next: cd backend && npx tsx ..\\data_fetcher\\seed_hs.ts")


if __name__ == "__main__":
    main()
