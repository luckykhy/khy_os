#!/usr/bin/env python3
# @pattern Command
"""
Alternative Financial Data Sources for A-Share Market.

Provides multi-source fallback when akshare is blocked:
  1. EastMoney (push2his.eastmoney.com)
  2. Tencent Finance (qt.gtimg.cn / web.ifzq.gtimg.cn)
  3. Sina Finance (hq.sinajs.cn)
  4. Netease Finance (api.money.126.net)
  5. Yahoo Finance (query1.finance.yahoo.com)

Usage:
  python alternative_data_sources.py --symbol sh000001 --action kline
  python alternative_data_sources.py --symbol sh000001 --action quote
  python alternative_data_sources.py --action test

Output: JSON to stdout in normalized format:
  { "symbol", "date", "open", "high", "low", "close", "volume", "source" }
"""

import json
import sys
import argparse
import re
from datetime import datetime, timedelta
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from urllib.parse import urlencode


TIMEOUT = 5  # seconds per source


def normalize_symbol(raw):
    """Parse symbol into (code, market). e.g. 'sh000001' -> ('000001', 'SH')"""
    s = re.sub(r'^(sh|sz|SH|SZ)', '', raw)
    if '.' in s:
        code, market = s.split('.', 1)
        return code, market.upper()
    # Detect market from code prefix
    if s.startswith('6') or s.startswith('9') or re.match(r'^(000|880)\d{3}$', s):
        return s, 'SH'
    return s, 'SZ'


def http_get(url, headers=None, timeout=TIMEOUT):
    """Simple HTTP GET returning response text."""
    req = Request(url)
    req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    resp = urlopen(req, timeout=timeout)
    data = resp.read()
    # Try UTF-8 first, fall back to GBK (common for Chinese finance APIs)
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return data.decode('gbk', errors='replace')


# ============================================================
# Source 1: EastMoney
# ============================================================

def fetch_eastmoney_kline(code, market, start_date='19900101', end_date='20301231'):
    """Fetch daily kline from EastMoney."""
    secid = f'1.{code}' if market == 'SH' else f'0.{code}'
    params = urlencode({
        'secid': secid,
        'ut': 'fa5fd1943c7b386f172d6893dbfba10b',
        'fields1': 'f1,f2,f3,f4,f5,f6',
        'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
        'klt': '101',  # daily
        'fqt': '1',    # forward-adjusted
        'beg': start_date,
        'end': end_date,
        'smplmt': '10000',
        'lmt': '1000000',
    })
    url = f'https://push2his.eastmoney.com/api/qt/stock/kline/get?{params}'
    text = http_get(url, headers={'Referer': 'https://quote.eastmoney.com'})
    data = json.loads(text)
    if not data.get('data') or not data['data'].get('klines'):
        return None
    result = []
    for line in data['data']['klines']:
        parts = line.split(',')
        if len(parts) < 7:
            continue
        result.append({
            'symbol': f'{code}.{market}',
            'date': parts[0],
            'open': float(parts[1]),
            'close': float(parts[2]),
            'high': float(parts[3]),
            'low': float(parts[4]),
            'volume': int(parts[5]),
            'source': 'EastMoney',
        })
    return result


def fetch_eastmoney_quote(code, market):
    """Fetch realtime quote from EastMoney."""
    secid = f'1.{code}' if market == 'SH' else f'0.{code}'
    params = urlencode({
        'secid': secid,
        'ut': 'fa5fd1943c7b386f172d6893dbfba10b',
        'fields': 'f43,f44,f45,f46,f47,f48,f50,f51,f52,f55,f57,f58,f60,f170',
    })
    url = f'https://push2.eastmoney.com/api/qt/stock/get?{params}'
    text = http_get(url, headers={'Referer': 'https://quote.eastmoney.com'})
    data = json.loads(text)
    if not data.get('data'):
        return None
    d = data['data']
    return {
        'symbol': f'{code}.{market}',
        'date': datetime.now().strftime('%Y-%m-%d'),
        'open': d.get('f46', 0) / 100,
        'high': d.get('f44', 0) / 100,
        'low': d.get('f45', 0) / 100,
        'close': d.get('f43', 0) / 100,
        'volume': d.get('f47', 0),
        'source': 'EastMoney',
    }


# ============================================================
# Source 2: Tencent Finance
# ============================================================

def fetch_tencent_kline(code, market):
    """Fetch daily kline from Tencent Finance."""
    tc_symbol = f'{"sh" if market == "SH" else "sz"}{code}'
    url = f'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={tc_symbol},day,,,320,qfq'
    text = http_get(url, headers={'Referer': 'https://gu.qq.com'})
    data = json.loads(text)
    if not data.get('data'):
        return None
    symbol_key = list(data['data'].keys())[0] if data['data'] else None
    if not symbol_key:
        return None
    day_data = data['data'][symbol_key].get('day') or data['data'][symbol_key].get('qfqday')
    if not day_data:
        return None
    result = []
    for item in day_data:
        if len(item) < 6:
            continue
        result.append({
            'symbol': f'{code}.{market}',
            'date': item[0],
            'open': float(item[1]),
            'close': float(item[2]),
            'high': float(item[3]),
            'low': float(item[4]),
            'volume': int(item[5]) if len(item) > 5 else 0,
            'source': 'Tencent',
        })
    return result


def fetch_tencent_quote(code, market):
    """Fetch realtime quote from Tencent."""
    tc_symbol = f'{"sh" if market == "SH" else "sz"}{code}'
    url = f'https://qt.gtimg.cn/q={tc_symbol}'
    text = http_get(url, headers={'Referer': 'https://gu.qq.com'})
    match = re.search(r'="([^"]+)"', text)
    if not match:
        return None
    fields = match.group(1).split('~')
    if len(fields) < 45:
        return None
    return {
        'symbol': f'{code}.{market}',
        'date': datetime.now().strftime('%Y-%m-%d'),
        'open': float(fields[5]) if fields[5] else 0,
        'high': float(fields[33]) if fields[33] else 0,
        'low': float(fields[34]) if fields[34] else 0,
        'close': float(fields[3]) if fields[3] else 0,
        'volume': int(fields[6]) if fields[6] else 0,
        'source': 'Tencent',
    }


# ============================================================
# Source 3: Sina Finance
# ============================================================

def fetch_sina_quote(code, market):
    """Fetch realtime quote from Sina Finance."""
    sina_symbol = f'{"sh" if market == "SH" else "sz"}{code}'
    url = f'https://hq.sinajs.cn/list={sina_symbol}'
    text = http_get(url, headers={'Referer': 'https://finance.sina.com.cn'})
    match = re.search(r'="([^"]+)"', text)
    if not match:
        return None
    fields = match.group(1).split(',')
    if len(fields) < 32:
        return None
    return {
        'symbol': f'{code}.{market}',
        'date': fields[30],
        'open': float(fields[1]),
        'high': float(fields[4]),
        'low': float(fields[5]),
        'close': float(fields[3]),
        'volume': int(float(fields[8])),
        'source': 'Sina',
    }


# ============================================================
# Source 4: Netease Finance
# ============================================================

def fetch_netease_kline(code, market, start_date='20200101', end_date=None):
    """Fetch historical kline from Netease Finance (CSV download)."""
    ne_code = f'0{code}' if market == 'SH' else f'1{code}'
    if not end_date:
        end_date = datetime.now().strftime('%Y%m%d')
    url = (
        f'https://quotes.money.163.com/service/chddata.html'
        f'?code={ne_code}&start={start_date}&end={end_date}'
        f'&fields=TCLOSE;HIGH;LOW;TOPEN;LCLOSE;CHG;PCHG;VOTURNOVER;VATURNOVER'
    )
    text = http_get(url)
    lines = text.strip().split('\n')
    if len(lines) < 2:
        return None
    result = []
    for line in lines[1:]:  # skip header
        parts = line.strip().split(',')
        if len(parts) < 10:
            continue
        try:
            result.append({
                'symbol': f'{code}.{market}',
                'date': parts[0].strip("'"),
                'open': float(parts[6]) if parts[6] != 'None' else 0,
                'high': float(parts[4]) if parts[4] != 'None' else 0,
                'low': float(parts[5]) if parts[5] != 'None' else 0,
                'close': float(parts[3]) if parts[3] != 'None' else 0,
                'volume': int(float(parts[8])) if parts[8] != 'None' else 0,
                'source': 'Netease',
            })
        except (ValueError, IndexError):
            continue
    result.reverse()  # Netease returns newest first
    return result


def fetch_netease_quote(code, market):
    """Fetch realtime quote from Netease."""
    ne_code = f'0{code}' if market == 'SH' else f'1{code}'
    url = f'https://api.money.126.net/data/feed/{ne_code},money.api'
    text = http_get(url)
    # Response is JSONP: _ntes_quote_callback({...})
    match = re.search(r'\((\{.*\})\)', text)
    if not match:
        return None
    data = json.loads(match.group(1))
    stock = list(data.values())[0] if data else None
    if not stock:
        return None
    return {
        'symbol': f'{code}.{market}',
        'date': datetime.now().strftime('%Y-%m-%d'),
        'open': float(stock.get('open', 0)),
        'high': float(stock.get('high', 0)),
        'low': float(stock.get('low', 0)),
        'close': float(stock.get('price', 0)),
        'volume': int(stock.get('volume', 0)),
        'source': 'Netease',
    }


# ============================================================
# Source 5: Yahoo Finance
# ============================================================

def fetch_yahoo_kline(code, market, days=365):
    """Fetch daily kline from Yahoo Finance."""
    yahoo_symbol = f'{code}.SS' if market == 'SH' else f'{code}.SZ'
    end_ts = int(datetime.now().timestamp())
    start_ts = int((datetime.now() - timedelta(days=days)).timestamp())
    url = (
        f'https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_symbol}'
        f'?period1={start_ts}&period2={end_ts}&interval=1d'
    )
    text = http_get(url)
    data = json.loads(text)
    chart = data.get('chart', {}).get('result', [{}])[0]
    timestamps = chart.get('timestamp', [])
    indicators = chart.get('indicators', {}).get('quote', [{}])[0]
    if not timestamps:
        return None
    result = []
    for i, ts in enumerate(timestamps):
        try:
            result.append({
                'symbol': f'{code}.{market}',
                'date': datetime.fromtimestamp(ts).strftime('%Y-%m-%d'),
                'open': round(indicators['open'][i] or 0, 2),
                'high': round(indicators['high'][i] or 0, 2),
                'low': round(indicators['low'][i] or 0, 2),
                'close': round(indicators['close'][i] or 0, 2),
                'volume': int(indicators['volume'][i] or 0),
                'source': 'Yahoo',
            })
        except (TypeError, IndexError, KeyError):
            continue
    return result


# ============================================================
# Orchestration
# ============================================================

KLINE_SOURCES = [
    ('EastMoney', fetch_eastmoney_kline),
    ('Tencent', fetch_tencent_kline),
    ('Netease', fetch_netease_kline),
    ('Yahoo', fetch_yahoo_kline),
]

QUOTE_SOURCES = [
    ('Tencent', fetch_tencent_quote),
    ('Sina', fetch_sina_quote),
    ('Netease', fetch_netease_quote),
    ('EastMoney', fetch_eastmoney_quote),
]


def fetch_kline_with_fallback(raw_symbol):
    """Try all kline sources in order, return first success."""
    code, market = normalize_symbol(raw_symbol)
    for name, fn in KLINE_SOURCES:
        try:
            result = fn(code, market)
            if result and len(result) > 0:
                return {'source': name, 'count': len(result), 'data': result}
        except Exception as e:
            sys.stderr.write(f'{name} kline failed: {e}\n')
    return None


def fetch_quote_with_fallback(raw_symbol):
    """Try all quote sources in order, return first success."""
    code, market = normalize_symbol(raw_symbol)
    for name, fn in QUOTE_SOURCES:
        try:
            result = fn(code, market)
            if result and result.get('close', 0) > 0:
                return result
        except Exception as e:
            sys.stderr.write(f'{name} quote failed: {e}\n')
    return None


def test_all_sources():
    """Test connectivity to all sources, return report."""
    code, market = '000001', 'SH'
    results = {}

    all_sources = [
        ('EastMoney_kline', lambda: fetch_eastmoney_kline(code, market)),
        ('Tencent_kline', lambda: fetch_tencent_kline(code, market)),
        ('Tencent_quote', lambda: fetch_tencent_quote(code, market)),
        ('Sina_quote', lambda: fetch_sina_quote(code, market)),
        ('Netease_kline', lambda: fetch_netease_kline(code, market)),
        ('Netease_quote', lambda: fetch_netease_quote(code, market)),
        ('Yahoo_kline', lambda: fetch_yahoo_kline(code, market, days=30)),
    ]

    for name, fn in all_sources:
        start = datetime.now()
        try:
            result = fn()
            ok = bool(result)
            count = len(result) if isinstance(result, list) else (1 if result else 0)
            results[name] = {
                'accessible': ok,
                'latency_ms': int((datetime.now() - start).total_seconds() * 1000),
                'records': count,
                'error': None,
            }
        except Exception as e:
            results[name] = {
                'accessible': False,
                'latency_ms': int((datetime.now() - start).total_seconds() * 1000),
                'records': 0,
                'error': str(e),
            }

    return results


def main():
    parser = argparse.ArgumentParser(description='Alternative financial data sources')
    parser.add_argument('--symbol', default='sh000001', help='Stock symbol (e.g. sh000001, 000001.SH)')
    parser.add_argument('--action', choices=['kline', 'quote', 'test'], default='kline',
                        help='Action to perform')
    args = parser.parse_args()

    if args.action == 'test':
        result = test_all_sources()
        print(json.dumps(result, indent=2, ensure_ascii=False))
    elif args.action == 'kline':
        result = fetch_kline_with_fallback(args.symbol)
        if result:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(json.dumps({'error': 'All kline sources failed'}, ensure_ascii=False))
            sys.exit(1)
    elif args.action == 'quote':
        result = fetch_quote_with_fallback(args.symbol)
        if result:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(json.dumps({'error': 'All quote sources failed'}, ensure_ascii=False))
            sys.exit(1)


if __name__ == '__main__':
    main()
