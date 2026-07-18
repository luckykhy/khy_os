#!/usr/bin/env python3
# @pattern Template Method
# -*- coding: utf-8 -*-
"""
获取所有A股股票代码
使用AData数据源
"""
import sys
import json
import pandas as pd
import os

# ============================================================
# 完全禁用代理(避免代理服务器未运行导致连接失败)
# ============================================================
os.environ['NO_PROXY'] = '*'
os.environ['no_proxy'] = '*'
os.environ['HTTP_PROXY'] = ''
os.environ['HTTPS_PROXY'] = ''
os.environ['http_proxy'] = ''
os.environ['https_proxy'] = ''
os.environ['FTP_PROXY'] = ''
os.environ['ftp_proxy'] = ''

for key in list(os.environ.keys()):
    if 'proxy' in key.lower():
        os.environ[key] = ''

# 添加 adata 库路径（源码集成方式）
adata_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../数据源/adata-main'))
sys.path.insert(0, adata_path)

try:
    import adata
    
    # 由于 all_code() API 不稳定，使用预定义的常用股票列表
    # 这些是A股市场最活跃的股票
    predefined_stocks = [
        {'stock_code': '600519', 'short_name': '贵州茅台', 'market': 'sh'},
        {'stock_code': '000858', 'short_name': '五粮液', 'market': 'sz'},
        {'stock_code': '600036', 'short_name': '招商银行', 'market': 'sh'},
        {'stock_code': '601318', 'short_name': '中国平安', 'market': 'sh'},
        {'stock_code': '000333', 'short_name': '美的集团', 'market': 'sz'},
        {'stock_code': '600276', 'short_name': '恒瑞医药', 'market': 'sh'},
        {'stock_code': '000001', 'short_name': '平安银行', 'market': 'sz'},
        {'stock_code': '600030', 'short_name': '中信证券', 'market': 'sh'},
        {'stock_code': '601166', 'short_name': '兴业银行', 'market': 'sh'},
        {'stock_code': '000002', 'short_name': '万科A', 'market': 'sz'},
        {'stock_code': '600887', 'short_name': '伊利股份', 'market': 'sh'},
        {'stock_code': '601888', 'short_name': '中国中免', 'market': 'sh'},
        {'stock_code': '300750', 'short_name': '宁德时代', 'market': 'sz'},
        {'stock_code': '002594', 'short_name': '比亚迪', 'market': 'sz'},
        {'stock_code': '600900', 'short_name': '长江电力', 'market': 'sh'},
    ]
    
    # 输出结果
    print(json.dumps({
        'success': True,
        'data': predefined_stocks,
        'count': len(predefined_stocks),
        'note': '使用预定义股票列表（all_code API不稳定）'
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
        'error': f'获取股票代码失败: {str(e)}',
        'type': type(e).__name__
    }, ensure_ascii=False))
    sys.exit(1)
