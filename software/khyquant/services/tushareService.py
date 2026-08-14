#!/usr/bin/env python
# @pattern Facade
# -*- coding: utf-8 -*-
"""
TuShare 数据源服务
专业金融数据接口 - 需要 token 授权（Pro API）
"""
import sys
import json
import os
from datetime import datetime, timedelta

# Disable proxy to avoid stuck connections (mirrors sibling data source services)
os.environ['NO_PROXY'] = '*'
os.environ['no_proxy'] = '*'
for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']:
    if key in os.environ:
        del os.environ[key]

# Add optional bundled tushare source path (source-integration style, consistent with akshare/efinance)
tushare_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../数据源/tushare-main'))
if os.path.isdir(tushare_path):
    sys.path.insert(0, tushare_path)

try:
    import tushare as ts
    print(f"✅ TuShare版本: {ts.__version__ if hasattr(ts, '__version__') else 'unknown'}", file=sys.stderr)
except ImportError as e:
    # Import failure is fail-soft: emit a non-success JSON so the upstream fallback chain can degrade
    print(json.dumps({
        'success': False,
        'error': 'TuShare库导入失败',
        'message': '请确认已安装 tushare（pip install tushare）或存在数据源/tushare-main目录',
        'path': tushare_path,
        'details': str(e)
    }, ensure_ascii=False))
    sys.exit(1)


def _get_token():
    """Read TuShare token from environment (never hardcode)."""
    return os.getenv('TUSHARE_TOKEN', '').strip()


def _get_pro_api():
    """
    Build a TuShare Pro API client using the env token.

    Returns:
        Pro API client instance, or None when the token is missing.
    """
    token = _get_token()
    if not token:
        print("⚠️ 未配置 TUSHARE_TOKEN，跳过 TuShare 数据源", file=sys.stderr)
        return None
    try:
        ts.set_token(token)
        return ts.pro_api()
    except Exception as init_error:
        print(f"⚠️ TuShare 初始化失败: {str(init_error)}", file=sys.stderr)
        return None


def _to_ts_code(code, instrument_type='stock'):
    """
    Convert a raw code into a TuShare ts_code with market suffix.

    Args:
        code: raw symbol, e.g. '600519', 'SH600519' or '000001'
        instrument_type: 'stock' or 'index'

    Returns:
        str: ts_code such as '600519.SH' or '000001.SH'
    """
    clean = code.strip().upper()
    if clean.startswith('SH'):
        return f"{clean[2:]}.SH"
    if clean.startswith('SZ'):
        return f"{clean[2:]}.SZ"

    if instrument_type == 'index':
        # Shanghai indices start with 000, Shenzhen indices start with 399
        if clean.startswith('399'):
            return f"{clean}.SZ"
        return f"{clean}.SH"

    # Stock market inference
    if clean.startswith('6'):
        return f"{clean}.SH"
    if clean.startswith('0') or clean.startswith('3'):
        return f"{clean}.SZ"
    return f"{clean}.SH"


def _fetch_daily(pro, ts_code, instrument_type, start_date, end_date):
    """
    Fetch daily bars from the appropriate TuShare Pro endpoint.

    Returns:
        DataFrame ordered by trade_date descending (TuShare default), or None on failure.
    """
    try:
        if instrument_type == 'index':
            return pro.index_daily(ts_code=ts_code, start_date=start_date, end_date=end_date)
        return pro.daily(ts_code=ts_code, start_date=start_date, end_date=end_date)
    except Exception as api_error:
        print(f"⚠️ 获取 {ts_code} 失败: {str(api_error)}", file=sys.stderr)
        return None


def get_batch_quotes(symbols, instrument_type='stock'):
    """
    Batch fetch latest quotes using the daily-bar endpoint (Pro API has no free realtime tick).

    Args:
        symbols: comma-separated codes or a list of codes
        instrument_type: 'stock' or 'index'

    Returns:
        dict: quote payload; fail-soft with success=False on any error
    """
    try:
        if isinstance(symbols, str):
            symbol_list = [s.strip() for s in symbols.split(',') if s.strip()]
        else:
            symbol_list = symbols

        if not symbol_list:
            return {
                'success': False,
                'error': '未提供代码',
                'data': []
            }

        pro = _get_pro_api()
        if pro is None:
            # Missing token or init failure: degrade to next priority without raising
            return {
                'success': False,
                'error': '未配置 TUSHARE_TOKEN 或初始化失败',
                'data': []
            }

        # Query a short recent window so the latest bar is available
        end_date = datetime.now().strftime('%Y%m%d')
        start_date = (datetime.now() - timedelta(days=30)).strftime('%Y%m%d')

        quotes = []
        for symbol in symbol_list:
            try:
                ts_code = _to_ts_code(symbol, instrument_type)
                df = _fetch_daily(pro, ts_code, instrument_type, start_date, end_date)
                if df is None or df.empty:
                    continue

                # TuShare returns rows ordered by trade_date descending; first row is latest
                row = df.iloc[0]
                code = ts_code.split('.')[0]
                quotes.append({
                    'symbol': code,
                    'code': code,
                    'name': code,  # daily endpoint does not return the display name
                    'price': float(row['close']),
                    'open': float(row['open']),
                    'high': float(row['high']),
                    'low': float(row['low']),
                    'volume': int(float(row['vol'])) if 'vol' in row else 0,
                    'change': round(float(row['change']), 2) if 'change' in row else 0,
                    'changePercent': round(float(row['pct_chg']), 2) if 'pct_chg' in row else 0,
                    'time': str(row['trade_date']),
                    'type': instrument_type,
                    'isPredefined': False,
                    'dataSource': 'TuShare每日数据'
                })
            except Exception as code_error:
                print(f"⚠️ 处理 {symbol} 失败: {str(code_error)}", file=sys.stderr)
                continue

        if not quotes:
            return {
                'success': False,
                'error': '未获取到行情数据',
                'data': []
            }

        return {
            'success': True,
            'data': quotes,
            'count': len(quotes),
            'dataCount': len(quotes),
            'samples': quotes,
            'responseTime': 0,
            'source': 'tushare'
        }

    except Exception as e:
        # Top-level guard keeps the fallback chain intact
        return {
            'success': False,
            'error': str(e),
            'data': []
        }


def get_kline(symbol, period='daily', start_date=None, end_date=None, instrument_type='stock'):
    """
    Fetch K-line (candlestick) data from the daily-bar endpoint.

    Args:
        symbol: stock/index code
        period: kept for interface parity (Pro daily endpoint returns daily bars)
        start_date: start date (YYYYMMDD)
        end_date: end date (YYYYMMDD)
        instrument_type: 'stock' or 'index'

    Returns:
        dict: kline payload; fail-soft with success=False on any error
    """
    try:
        pro = _get_pro_api()
        if pro is None:
            return {
                'success': False,
                'error': '未配置 TUSHARE_TOKEN 或初始化失败',
                'kline': []
            }

        # Default to the most recent 30 days to bound payload size
        if not end_date:
            end_date = datetime.now().strftime('%Y%m%d')
        if not start_date:
            start_date = (datetime.now() - timedelta(days=30)).strftime('%Y%m%d')

        ts_code = _to_ts_code(symbol, instrument_type)
        print(f"📊 获取K线数据: {ts_code}, 类型: {instrument_type}", file=sys.stderr)

        df = _fetch_daily(pro, ts_code, instrument_type, start_date, end_date)
        if df is None or df.empty:
            return {
                'success': False,
                'error': '未获取到K线数据',
                'kline': []
            }

        # TuShare returns descending by trade_date; reverse to chronological order
        df = df.iloc[::-1]

        kline = []
        for _, row in df.iterrows():
            trade_date = str(row['trade_date'])
            # Normalize YYYYMMDD to YYYY-MM-DD
            formatted = f"{trade_date[0:4]}-{trade_date[4:6]}-{trade_date[6:8]}" if len(trade_date) == 8 else trade_date
            kline.append({
                'date': formatted,
                'time': formatted,
                'open': float(row['open']),
                'high': float(row['high']),
                'low': float(row['low']),
                'close': float(row['close']),
                'volume': int(float(row['vol'])) if 'vol' in row else 0,
                'amount': float(row['amount']) if 'amount' in row else 0
            })

        print(f"✅ 获取到 {len(kline)} 条K线数据", file=sys.stderr)

        return {
            'success': True,
            'kline': kline,
            'count': len(kline),
            'source': 'TuShare每日数据'
        }

    except Exception as e:
        print(f"❌ 获取K线失败: {str(e)}", file=sys.stderr)
        return {
            'success': False,
            'error': str(e),
            'kline': []
        }


def main():
    """CLI entry point mirroring akshareService.py command interface."""
    if len(sys.argv) < 2:
        print(json.dumps({
            'success': False,
            'error': '缺少参数',
            'usage': 'python tushareService.py <command> [args...]'
        }, ensure_ascii=False))
        return

    command = sys.argv[1]

    try:
        if command == 'batch_quotes':
            symbols = sys.argv[2] if len(sys.argv) > 2 else '000001'
            instrument_type = sys.argv[3] if len(sys.argv) > 3 else 'stock'
            result = get_batch_quotes(symbols, instrument_type)
            print(json.dumps(result, ensure_ascii=False))

        elif command == 'kline':
            symbol = sys.argv[2] if len(sys.argv) > 2 else '000001'
            period = sys.argv[3] if len(sys.argv) > 3 else 'daily'
            start_date = sys.argv[4] if len(sys.argv) > 4 else None
            end_date = sys.argv[5] if len(sys.argv) > 5 else None
            instrument_type = sys.argv[6] if len(sys.argv) > 6 else 'stock'
            result = get_kline(symbol, period, start_date, end_date, instrument_type)
            print(json.dumps(result, ensure_ascii=False))

        elif command == 'test':
            # Connectivity check: success only when token is configured and client builds
            pro = _get_pro_api()
            if pro is None:
                result = {
                    'success': False,
                    'message': '未配置 TUSHARE_TOKEN',
                    'version': ts.__version__ if hasattr(ts, '__version__') else 'unknown'
                }
            else:
                result = {
                    'success': True,
                    'message': 'TuShare服务正常',
                    'version': ts.__version__ if hasattr(ts, '__version__') else 'unknown'
                }
            print(json.dumps(result, ensure_ascii=False))

        else:
            print(json.dumps({
                'success': False,
                'error': f'未知命令: {command}'
            }, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': str(e)
        }, ensure_ascii=False))


if __name__ == '__main__':
    main()
