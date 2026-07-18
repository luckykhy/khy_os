#!/usr/bin/env python3
# @pattern Template Method
# -*- coding: utf-8 -*-
"""
获取金融标的列表
策略（按优先级）：
  1. 本地缓存 cache/instruments.csv（24h 内有效）
  2. akshare 网络获取（SSL 宽松模式）
  3. 内置静态兜底列表（确保系统始终可启动）
"""
import sys
import json
import os
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR  = os.path.normpath(os.path.join(SCRIPT_DIR, '../../../cache'))
CACHE_FILE = os.path.join(CACHE_DIR, 'instruments.csv')
CACHE_TTL  = 24 * 3600

# 内置兜底列表
BUILTIN = [
    {'code':'000001','name':'上证指数',  'type':'index','market':'SH','category':'指数'},
    {'code':'399001','name':'深证成指',  'type':'index','market':'SZ','category':'指数'},
    {'code':'399006','name':'创业板指',  'type':'index','market':'SZ','category':'指数'},
    {'code':'000300','name':'沪深300',   'type':'index','market':'SH','category':'指数'},
    {'code':'000016','name':'上证50',    'type':'index','market':'SH','category':'指数'},
    {'code':'000905','name':'中证500',   'type':'index','market':'SH','category':'指数'},
    {'code':'000852','name':'中证1000',  'type':'index','market':'SH','category':'指数'},
    {'code':'399005','name':'中小板指',  'type':'index','market':'SZ','category':'指数'},
    {'code':'000688','name':'科创50',    'type':'index','market':'SH','category':'指数'},
    {'code':'600519','name':'贵州茅台',  'type':'stock','market':'SH','category':'股票'},
    {'code':'601318','name':'中国平安',  'type':'stock','market':'SH','category':'股票'},
    {'code':'600036','name':'招商银行',  'type':'stock','market':'SH','category':'股票'},
    {'code':'600276','name':'恒瑞医药',  'type':'stock','market':'SH','category':'股票'},
    {'code':'600900','name':'长江电力',  'type':'stock','market':'SH','category':'股票'},
    {'code':'601888','name':'中国中免',  'type':'stock','market':'SH','category':'股票'},
    {'code':'600887','name':'伊利股份',  'type':'stock','market':'SH','category':'股票'},
    {'code':'601012','name':'隆基绿能',  'type':'stock','market':'SH','category':'股票'},
    {'code':'600309','name':'万华化学',  'type':'stock','market':'SH','category':'股票'},
    {'code':'000858','name':'五粮液',    'type':'stock','market':'SZ','category':'股票'},
    {'code':'000333','name':'美的集团',  'type':'stock','market':'SZ','category':'股票'},
    {'code':'000651','name':'格力电器',  'type':'stock','market':'SZ','category':'股票'},
    {'code':'002415','name':'海康威视',  'type':'stock','market':'SZ','category':'股票'},
    {'code':'002594','name':'比亚迪',    'type':'stock','market':'SZ','category':'股票'},
    {'code':'300750','name':'宁德时代',  'type':'stock','market':'SZ','category':'股票'},
    {'code':'300059','name':'东方财富',  'type':'stock','market':'SZ','category':'股票'},
    {'code':'000725','name':'京东方A',   'type':'stock','market':'SZ','category':'股票'},
    {'code':'002352','name':'顺丰控股',  'type':'stock','market':'SZ','category':'股票'},
    {'code':'600030','name':'中信证券',  'type':'stock','market':'SH','category':'股票'},
    {'code':'601398','name':'工商银行',  'type':'stock','market':'SH','category':'股票'},
    {'code':'601939','name':'建设银行',  'type':'stock','market':'SH','category':'股票'},
    {'code':'IF2406','name':'沪深300股指期货', 'type':'futures','market':'CFFEX','category':'期货'},
    {'code':'IC2406','name':'中证500股指期货', 'type':'futures','market':'CFFEX','category':'期货'},
    {'code':'rb2410','name':'螺纹钢主力合约',   'type':'futures','market':'SHFE','category':'期货'},
]

def load_from_cache():
    if not os.path.exists(CACHE_FILE):
        return None
    age = time.time() - os.path.getmtime(CACHE_FILE)
    if age > CACHE_TTL:
        print(f"缓存已过期({int(age/3600)}h)，将重新获取", file=sys.stderr)
        return None
    try:
        import pandas as pd
        df = pd.read_csv(CACHE_FILE, dtype=str).fillna('')
        instruments = df.to_dict('records')
        print(f"从本地缓存读取 {len(instruments)} 个标的", file=sys.stderr)
        return instruments
    except Exception as e:
        print(f"读取缓存失败: {e}", file=sys.stderr)
        return None

def patch_ssl():
    try:
        import ssl
        ssl._create_default_https_context = ssl._create_unverified_context
    except Exception:
        pass
    try:
        import urllib3
        urllib3.disable_warnings()
    except Exception:
        pass
    try:
        import requests
        _orig = requests.Session.request
        def _patched(self, *a, **kw):
            kw.setdefault('verify', False)
            return _orig(self, *a, **kw)
        requests.Session.request = _patched
    except Exception:
        pass

def fetch_from_akshare():
    patch_ssl()
    import akshare as ak
    instruments = []

    for method_name, func_call in [
        ('stock_info_a_code_name', lambda: ak.stock_info_a_code_name()),
    ]:
        try:
            print(f"akshare: {method_name}...", file=sys.stderr)
            df = func_call()
            code_col = next((c for c in df.columns if 'code' in c.lower() or '代码' in c), df.columns[0])
            name_col = next((c for c in df.columns if 'name' in c.lower() or '名称' in c), df.columns[1])
            for _, row in df.iterrows():
                code = str(row[code_col]).strip().zfill(6)
                name = str(row[name_col]).strip()
                if not code or code == '000000':
                    continue
                market = 'SH' if code.startswith(('6', '9')) else 'SZ'
                instruments.append({'code':code,'symbol':code,'name':name,
                                     'type':'stock','market':market,'category':'股票'})
            if instruments:
                print(f"获取到 {len(instruments)} 只 A 股", file=sys.stderr)
                return instruments
        except Exception as e:
            print(f"{method_name} 失败: {e}", file=sys.stderr)

    return instruments

def save_cache(instruments):
    try:
        import pandas as pd
        os.makedirs(CACHE_DIR, exist_ok=True)
        df = pd.DataFrame(instruments)
        if 'symbol' not in df.columns:
            df['symbol'] = df['code']
        df.to_csv(CACHE_FILE, index=False)
        print(f"已缓存 {len(instruments)} 个标的", file=sys.stderr)
    except Exception as e:
        print(f"保存缓存失败: {e}", file=sys.stderr)

# ── 主流程 ────────────────────────────────────────────────────────────────────
try:
    instruments = load_from_cache()

    if instruments is None:
        try:
            fetched = fetch_from_akshare()
        except Exception as e:
            print(f"akshare 获取失败: {e}", file=sys.stderr)
            fetched = []

        if fetched:
            # 追加内置指数和期货标的
            existing = {i['code'] for i in fetched}
            for item in BUILTIN:
                if item['type'] in ('index', 'futures') and item['code'] not in existing:
                    fetched.append({**item, 'symbol': item['code']})
            instruments = fetched
        else:
            print("网络不可用，使用内置兜底列表", file=sys.stderr)
            instruments = [{**i, 'symbol': i['code']} for i in BUILTIN]

        save_cache(instruments)

    stocks  = [i for i in instruments if i.get('type') == 'stock']
    indices = [i for i in instruments if i.get('type') == 'index']
    futures = [i for i in instruments if i.get('type') == 'futures']

    print(json.dumps({
        'success': True,
        'data': instruments,
        'stats': {'total': len(instruments), 'stocks': len(stocks), 'indices': len(indices), 'futures': len(futures)}
    }, ensure_ascii=False))

except Exception as e:
    print(json.dumps({'success': False, 'error': str(e), 'type': type(e).__name__},
                     ensure_ascii=False))
    sys.exit(1)
