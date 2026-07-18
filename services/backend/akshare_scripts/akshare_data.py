# @pattern Command

import akshare as ak
import json
import sys
import os
import random
import time
import pandas as pd
from datetime import datetime, timedelta

# ── Anti-ban: User-Agent rotation ────────────────────────────────────────
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
]

def setup_session():
    """Configure requests session with random UA and optional proxy."""
    import requests
    session = requests.Session()
    session.headers.update({
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Connection": "keep-alive",
    })

    proxy = os.environ.get("AKSHARE_PROXY", "").strip()
    if proxy:
        session.proxies = {"http": proxy, "https": proxy}

    # Patch requests.get / requests.post used by akshare internally
    _orig_get = requests.get
    _orig_post = requests.post
    def patched_get(url, **kwargs):
        kwargs.setdefault("headers", {}).update({"User-Agent": random.choice(USER_AGENTS)})
        if proxy and "proxies" not in kwargs:
            kwargs["proxies"] = {"http": proxy, "https": proxy}
        return _orig_get(url, **kwargs)
    def patched_post(url, **kwargs):
        kwargs.setdefault("headers", {}).update({"User-Agent": random.choice(USER_AGENTS)})
        if proxy and "proxies" not in kwargs:
            kwargs["proxies"] = {"http": proxy, "https": proxy}
        return _orig_post(url, **kwargs)
    requests.get = patched_get
    requests.post = patched_post

    return session

# Run setup before any akshare calls
setup_session()

def get_stock_realtime(symbol):
    """Get stock realtime quote."""
    try:
        pure_code = symbol.lower().lstrip('sh').lstrip('sz') if symbol[:2].lower() in ('sh', 'sz') else symbol
        df = ak.stock_zh_a_spot_em()
        stock_data = df[df['代码'] == pure_code]

        if stock_data.empty:
            return {"error": "股票代码不存在: " + pure_code}

        row = stock_data.iloc[0]
        return {
            "symbol": symbol,
            "name": row['名称'],
            "current_price": float(row['最新价']),
            "open": float(row['今开']),
            "high": float(row['最高']),
            "low": float(row['最低']),
            "close": float(row['昨收']),
            "volume": int(row['成交量']),
            "amount": float(row['成交额']),
            "change": float(row['涨跌额']),
            "change_percent": float(row['涨跌幅']),
            "source": "AKShare实时数据"
        }
    except Exception as e:
        return {"error": str(e)}

def get_stock_kline(symbol, period='daily', count=100):
    """Get stock K-line (OHLCV) data."""
    try:
        pure_code = symbol.lower().lstrip('sh').lstrip('sz') if symbol[:2].lower() in ('sh', 'sz') else symbol
        period_map = {'daily': 'daily', 'weekly': 'weekly', 'monthly': 'monthly'}
        ak_period = period_map.get(period, 'daily')
        df = ak.stock_zh_a_hist(symbol=pure_code, period=ak_period, adjust="qfq")

        if df.empty:
            return {"error": "无法获取K线数据"}

        df = df.tail(count)
        kline_data = []
        for _, row in df.iterrows():
            kline_data.append({
                "time": row['日期'].strftime('%Y-%m-%d'),
                "open": float(row['开盘']),
                "high": float(row['最高']),
                "low": float(row['最低']),
                "close": float(row['收盘']),
                "volume": int(row['成交量'])
            })

        return {"symbol": symbol, "kline": kline_data, "source": "AKShare历史数据"}
    except Exception as e:
        return {"error": str(e)}

def get_index_realtime(symbol):
    """Get index realtime quote."""
    try:
        pure_code = symbol.lower().lstrip('sh').lstrip('sz') if symbol[:2].lower() in ('sh', 'sz') else symbol
        df = ak.stock_zh_index_spot_em()
        index_data = df[df['代码'] == pure_code]

        if index_data.empty:
            return {"error": "指数代码不存在: " + pure_code}

        row = index_data.iloc[0]
        return {
            "symbol": symbol,
            "name": row['名称'],
            "current_price": float(row['最新价']),
            "open": float(row['今开']),
            "high": float(row['最高']),
            "low": float(row['最低']),
            "close": float(row['昨收']),
            "volume": int(row['成交量']) if '成交量' in row else 0,
            "amount": float(row['成交额']) if '成交额' in row else 0,
            "change": float(row['涨跌额']),
            "change_percent": float(row['涨跌幅']),
            "source": "AKShare指数数据"
        }
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "参数不足"}))
        sys.exit(1)

    action = sys.argv[1]
    symbol = sys.argv[2]

    if action == "realtime":
        result = get_stock_realtime(symbol)
    elif action == "kline":
        count = int(sys.argv[3]) if len(sys.argv) > 3 else 100
        period = sys.argv[4] if len(sys.argv) > 4 else 'daily'
        result = get_stock_kline(symbol, period, count)
    elif action == "index":
        result = get_index_realtime(symbol)
    else:
        result = {"error": "未知操作"}

    print(json.dumps(result, ensure_ascii=False, default=str))
