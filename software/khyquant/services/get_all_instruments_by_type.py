#!/usr/bin/env python3
# @pattern Template Method
# -*- coding: utf-8 -*-
"""
获取所有金融标的并按类型分类
使用AData数据源
支持：股票、指数、ETF、可转债
"""
import sys
import json
import pandas as pd

def safe_get_data(func, name, timeout=30):
    """安全获取数据，失败时返回空DataFrame"""
    import signal
    
    def timeout_handler(signum, frame):
        raise TimeoutError(f"获取{name}超时")
    
    try:
        print(f"正在获取{name}...", file=sys.stderr)
        
        # Windows 不支持 signal.alarm，所以只在非 Windows 系统使用
        if hasattr(signal, 'SIGALRM'):
            signal.signal(signal.SIGALRM, timeout_handler)
            signal.alarm(timeout)
        
        df = func()
        
        if hasattr(signal, 'SIGALRM'):
            signal.alarm(0)  # 取消超时
        
        if df is not None and len(df) > 0:
            print(f"✅ 获取{name}成功: {len(df)}条", file=sys.stderr)
            return df
        else:
            print(f"⚠️ {name}为空", file=sys.stderr)
            return pd.DataFrame()
    except TimeoutError as e:
        print(f"⏱️ {name}超时: {str(e)}", file=sys.stderr)
        return pd.DataFrame()
    except Exception as e:
        print(f"❌ 获取{name}失败: {str(e)}", file=sys.stderr)
        return pd.DataFrame()
    finally:
        if hasattr(signal, 'SIGALRM'):
            signal.alarm(0)

try:
    import adata
    
    all_instruments = []
    
    # 1. 获取指数代码
    indices_df = safe_get_data(adata.stock.info.all_index_code, "指数代码")
    if len(indices_df) > 0:
        for _, row in indices_df.iterrows():
            all_instruments.append({
                'code': row.get('index_code', ''),
                'name': row.get('name', ''),
                'type': 'index',
                'category': '指数',
                'source': row.get('source', ''),
                'concept_code': row.get('concept_code', '')
            })
    
    # 2. 获取股票代码
    stocks_df = safe_get_data(adata.stock.info.all_code, "股票代码")
    if len(stocks_df) > 0:
        for _, row in stocks_df.iterrows():
            all_instruments.append({
                'code': row.get('stock_code', ''),
                'name': row.get('short_name', ''),
                'type': 'stock',
                'category': '股票',
                'exchange': row.get('exchange', ''),
                'list_date': row.get('list_date', None)
            })
    
    # 3. 获取ETF代码
    etf_df = safe_get_data(adata.fund.info.all_etf_exchange_traded_info, "ETF代码")
    if len(etf_df) > 0:
        for _, row in etf_df.iterrows():
            all_instruments.append({
                'code': row.get('fund_code', row.get('code', '')),
                'name': row.get('fund_name', row.get('name', '')),
                'type': 'etf',
                'category': 'ETF',
                'exchange': row.get('exchange', ''),
                'list_date': row.get('list_date', None)
            })
    
    # 4. 获取可转债代码
    bond_df = safe_get_data(adata.bond.info.all_convert_code, "可转债代码")
    if len(bond_df) > 0:
        for _, row in bond_df.iterrows():
            all_instruments.append({
                'code': row.get('bond_code', row.get('code', '')),
                'name': row.get('bond_name', row.get('name', '')),
                'type': 'bond',
                'category': '可转债',
                'exchange': row.get('exchange', ''),
                'list_date': row.get('list_date', None)
            })
    
    # 统计信息
    stats = {
        'total': len(all_instruments),
        'indices': len([i for i in all_instruments if i['type'] == 'index']),
        'stocks': len([i for i in all_instruments if i['type'] == 'stock']),
        'etfs': len([i for i in all_instruments if i['type'] == 'etf']),
        'bonds': len([i for i in all_instruments if i['type'] == 'bond'])
    }
    
    print(f"\n📊 统计信息:", file=sys.stderr)
    print(f"  总计: {stats['total']}", file=sys.stderr)
    print(f"  指数: {stats['indices']}", file=sys.stderr)
    print(f"  股票: {stats['stocks']}", file=sys.stderr)
    print(f"  ETF: {stats['etfs']}", file=sys.stderr)
    print(f"  可转债: {stats['bonds']}", file=sys.stderr)
    
    # 输出结果
    print(json.dumps({
        'success': True,
        'data': all_instruments,
        'stats': stats
    }, ensure_ascii=False))
    
except ImportError as e:
    print(json.dumps({
        'success': False,
        'error': 'AData未安装，请运行: pip install adata',
        'details': str(e)
    }, ensure_ascii=False))
    sys.exit(1)
    
except Exception as e:
    print(json.dumps({
        'success': False,
        'error': f'获取标的列表失败: {str(e)}',
        'type': type(e).__name__
    }, ensure_ascii=False))
    sys.exit(1)
