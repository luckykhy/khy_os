#!/usr/bin/env python3
"""
fetch_akshare_news.py — Fetch financial news via akshare.

Usage:
    python fetch_akshare_news.py <keyword> <limit>

Outputs JSON to stdout: {"success": true, "data": [...]}
                         or {"success": false, "error": "..."}
"""
import sys
import json
import io

# Force UTF-8 output
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else '000001'
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20

    try:
        import akshare as ak
        # stock_news_em expects a stock code like "000001"
        df = ak.stock_news_em(symbol=keyword)
        records = []
        if df is not None and len(df) > 0:
            df = df.head(limit)
            for _, row in df.iterrows():
                records.append({
                    "title": str(row.get("新闻标题", "")),
                    "content": str(row.get("新闻内容", ""))[:200],
                    "source": str(row.get("文章来源", "")),
                    "url": str(row.get("新闻链接", "")),
                    "time": str(row.get("发布时间", "")),
                })
        print(json.dumps({"success": True, "data": records}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == '__main__':
    main()
