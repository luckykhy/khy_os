#!/usr/bin/env python3
# @pattern Template Method
# -*- coding: utf-8 -*-
"""
获取股票和指数标的（简化版）
只获取已验证可用的数据源
"""
import sys
import json
import pandas as pd

try:
    import adata
    
    all_instruments = []
    
    # 1. 获取指数代码
    print("正在获取指数代码...", file=sys.stderr)
    try:
        indices_df = adata.stock.info.all_index_code()
        if indices_df is not None and len(indices_df) > 0:
            print(f"✅ 获取指数成功: {len(indices_df)}条", file=sys.stderr)
            for _, row in indices_df.iterrows():
                all_instruments.append({
                    'code': row.get('index_code', ''),
                    'name': row.get('name', ''),
                    'type': 'index',
                    'category': '指数',
                    'source': row.get('source', ''),
                    'concept_code': row.get('concept_code', '')
                })
    except Exception as e:
        print(f"❌ 获取指数失败: {str(e)}", file=sys.stderr)
    
    # 2. 获取股票代码
    print("正在获取股票代码...", file=sys.stderr)
    try:
        stocks_df = adata.stock.info.all_code()
        if stocks_df is not None and len(stocks_df) > 0:
            print(f"✅ 获取股票成功: {len(stocks_df)}条", file=sys.stderr)
            for _, row in stocks_df.iterrows():
                all_instruments.append({
                    'code': row.get('stock_code', ''),
                    'name': row.get('short_name', ''),
                    'type': 'stock',
                    'category': '股票',
                    'exchange': row.get('exchange', ''),
                    'list_date': row.get('list_date', None)
                })
    except Exception as e:
        print(f"❌ 获取股票失败: {str(e)}", file=sys.stderr)
    
    # 统计信息
    stats = {
        'total': len(all_instruments),
        'indices': len([i for i in all_instruments if i['type'] == 'index']),
        'stocks': len([i for i in all_instruments if i['type'] == 'stock']),
        'etfs': 0,
        'bonds': 0
    }
    
    print(f"\n📊 统计信息:", file=sys.stderr)
    print(f"  总计: {stats['total']}", file=sys.stderr)
    print(f"  指数: {stats['indices']}", file=sys.stderr)
    print(f"  股票: {stats['stocks']}", file=sys.stderr)
    
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
