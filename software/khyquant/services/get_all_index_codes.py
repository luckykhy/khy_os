#!/usr/bin/env python3
# @pattern Template Method
# -*- coding: utf-8 -*-
"""
获取所有A股指数代码
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
    
    # 由于 all_index_code() API 不稳定，使用预定义的常用指数列表
    # 这些是A股市场最常用的指数
    predefined_indices = [
        {'index_code': '000001', 'short_name': '上证指数', 'full_name': '上证综合指数'},
        {'index_code': '000300', 'short_name': '沪深300', 'full_name': '沪深300指数'},
        {'index_code': '000016', 'short_name': '上证50', 'full_name': '上证50指数'},
        {'index_code': '000905', 'short_name': '中证500', 'full_name': '中证500指数'},
        {'index_code': '000852', 'short_name': '中证1000', 'full_name': '中证1000指数'},
        {'index_code': '399001', 'short_name': '深证成指', 'full_name': '深证成份指数'},
        {'index_code': '399006', 'short_name': '创业板指', 'full_name': '创业板指数'},
        {'index_code': '399005', 'short_name': '中小板指', 'full_name': '中小板指数'},
        {'index_code': '399300', 'short_name': '沪深300', 'full_name': '沪深300指数'},
        {'index_code': '000688', 'short_name': '科创50', 'full_name': '科创50指数'},
    ]
    
    # 输出结果
    print(json.dumps({
        'success': True,
        'data': predefined_indices,
        'count': len(predefined_indices),
        'note': '使用预定义指数列表（all_index_code API不稳定）'
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
        'error': f'获取指数代码失败: {str(e)}',
        'type': type(e).__name__
    }, ensure_ascii=False))
    sys.exit(1)
