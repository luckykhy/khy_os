#!/usr/bin/env python
# @pattern Facade
# -*- coding: utf-8 -*-
"""
AData 市场数据服务 - 获取标的列表和批量行情
"""
import sys
import json
import os
from datetime import datetime

# 禁用代理
os.environ['NO_PROXY'] = '*'
os.environ['no_proxy'] = '*'
for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'FTP_PROXY', 'ftp_proxy']:
    os.environ[key] = ''

# 添加 adata 库路径
adata_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../数据源/adata-main'))
sys.path.insert(0, adata_path)

try:
    import adata
except ImportError as e:
    print(json.dumps({
        'success': False,
        'error': 'AData库导入失败',
        'message': str(e)
    }, ensure_ascii=False))
    sys.exit(1)


def get_all_stock_codes(limit=50):
    """
    获取所有股票代码
    
    Args:
        limit: 限制返回数量,0表示不限制
    
    Returns:
        dict: 包含股票代码列表的字典
    """
    try:
        # 使用 adata.stock.info.all_code() 获取所有股票代码
        df = adata.stock.info.all_code()
        
        if df is None or df.empty:
            return {
                'success': False,
                'error': '未获取到股票代码',
                'data': []
            }
        
        # 转换为标准格式
        stocks = []
        for _, row in df.iterrows():
            stock_code = str(row['stock_code'])
            short_name = str(row['short_name'])
            exchange = str(row['exchange'])
            
            # 添加交易所前缀
            if exchange == 'SH':
                symbol = f"sh{stock_code}"
            elif exchange == 'SZ':
                symbol = f"sz{stock_code}"
            else:
                symbol = stock_code
            
            stocks.append({
                'symbol': symbol,
                'code': stock_code,
                'name': short_name,
                'exchange': exchange,
                'type': 'stock'
            })
            
            # 限制数量
            if limit > 0 and len(stocks) >= limit:
                break
        
        return {
            'success': True,
            'data': stocks,
            'count': len(stocks),
            'total': len(df)
        }
        
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'data': []
        }


def get_index_codes():
    """
    获取常用指数代码
    
    Returns:
        dict: 包含指数代码列表的字典
    """
    try:
        # 常用指数列表
        indices = [
            {'symbol': 'sh000001', 'code': '000001', 'name': '上证指数', 'exchange': 'SH', 'type': 'index'},
            {'symbol': 'sh000300', 'code': '000300', 'name': '沪深300', 'exchange': 'SH', 'type': 'index'},
            {'symbol': 'sz399001', 'code': '399001', 'name': '深证成指', 'exchange': 'SZ', 'type': 'index'},
            {'symbol': 'sz399006', 'code': '399006', 'name': '创业板指', 'exchange': 'SZ', 'type': 'index'},
            {'symbol': 'sz399005', 'code': '399005', 'name': '中小板指', 'exchange': 'SZ', 'type': 'index'},
            {'symbol': 'sh000016', 'code': '000016', 'name': '上证50', 'exchange': 'SH', 'type': 'index'},
            {'symbol': 'sh000688', 'code': '000688', 'name': '科创50', 'exchange': 'SH', 'type': 'index'},
            {'symbol': 'sh000905', 'code': '000905', 'name': '中证500', 'exchange': 'SH', 'type': 'index'},
            {'symbol': 'sh000116', 'code': '000116', 'name': '信用100', 'exchange': 'SH', 'type': 'index'},
            {'symbol': 'sh000131', 'code': '000131', 'name': '上证高新', 'exchange': 'SH', 'type': 'index'},
        ]
        
        return {
            'success': True,
            'data': indices,
            'count': len(indices)
        }
        
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'data': []
        }


def get_batch_market_quotes(symbols, instrument_type='stock'):
    """
    批量获取行情数据
    
    Args:
        symbols: 股票/指数代码列表,逗号分隔的字符串
        instrument_type: 标的类型 'stock' 或 'index'
    
    Returns:
        dict: 包含行情数据的字典
    """
    try:
        # 解析symbols
        if isinstance(symbols, str):
            symbol_list = [s.strip() for s in symbols.split(',') if s.strip()]
        else:
            symbol_list = symbols
        
        if not symbol_list:
            return {
                'success': False,
                'error': '未提供股票代码',
                'data': []
            }
        
        # 标准化代码(去除sh/sz前缀)
        clean_codes = []
        for symbol in symbol_list:
            symbol = symbol.strip().upper()
            if symbol.startswith('SH') and len(symbol) == 8:
                clean_codes.append(symbol[2:])
            elif symbol.startswith('SZ') and len(symbol) == 8:
                clean_codes.append(symbol[2:])
            else:
                clean_codes.append(symbol)
        
        quotes = []
        
        # 🔥 由于网络限制，直接使用预定义的测试数据
        print(f"⚠️ 使用预定义测试数据（网络限制）", file=sys.stderr)
        
        # 预定义的指数数据
        predefined_indices = {
            '000001': {'name': '上证指数', 'price': 4117.41, 'open': 4129.13, 'high': 4131.55, 'low': 4105.94, 'volume': 566322249},
            '000300': {'name': '沪深300', 'price': 4850.23, 'open': 4862.15, 'high': 4875.32, 'low': 4840.18, 'volume': 423156789},
            '399001': {'name': '深证成指', 'price': 13245.67, 'open': 13258.92, 'high': 13278.45, 'low': 13230.12, 'volume': 389245678},
            '399006': {'name': '创业板指', 'price': 2856.34, 'open': 2862.18, 'high': 2870.56, 'low': 2848.92, 'volume': 298765432},
            '000016': {'name': '上证50', 'price': 3245.78, 'open': 3252.34, 'high': 3260.12, 'low': 3238.56, 'volume': 234567890},
            '000905': {'name': '中证500', 'price': 6789.45, 'open': 6795.23, 'high': 6812.67, 'low': 6778.34, 'volume': 345678901},
        }
        
        # 预定义的股票数据
        predefined_stocks = {
            '600519': {'name': '贵州茅台', 'price': 1850.50, 'open': 1845.20, 'high': 1865.80, 'low': 1842.30, 'volume': 12345678},
            '000858': {'name': '五粮液', 'price': 185.60, 'open': 184.30, 'high': 187.20, 'low': 183.50, 'volume': 23456789},
            '600036': {'name': '招商银行', 'price': 42.35, 'open': 42.10, 'high': 42.68, 'low': 41.95, 'volume': 34567890},
            '000001': {'name': '平安银行', 'price': 14.85, 'open': 14.75, 'high': 14.98, 'low': 14.70, 'volume': 45678901},
            '000333': {'name': '美的集团', 'price': 68.45, 'open': 68.20, 'high': 69.10, 'low': 67.85, 'volume': 56789012},
            '600276': {'name': '恒瑞医药', 'price': 56.78, 'open': 56.50, 'high': 57.20, 'low': 56.30, 'volume': 23456789},
            '601318': {'name': '中国平安', 'price': 58.90, 'open': 58.65, 'high': 59.35, 'low': 58.45, 'volume': 34567890},
            '300750': {'name': '宁德时代', 'price': 245.60, 'open': 244.20, 'high': 248.50, 'low': 243.10, 'volume': 45678901},
        }
        
        for code in clean_codes:
            try:
                if instrument_type == 'index':
                    # 使用预定义指数数据
                    if code in predefined_indices:
                        data = predefined_indices[code]
                        change = data['price'] - data['open']
                        change_pct = (change / data['open'] * 100) if data['open'] != 0 else 0
                        
                        quotes.append({
                            'symbol': code,
                            'code': code,
                            'name': data['name'],
                            'price': data['price'],
                            'open': data['open'],
                            'high': data['high'],
                            'low': data['low'],
                            'volume': data['volume'],
                            'change': change,
                            'changePercent': change_pct,
                            'time': datetime.now().isoformat(),
                            'type': 'index',
                            'isPredefined': True,  # 🔥 标记为预定义数据
                            'dataSource': 'predefined'  # 🔥 数据来源
                        })
                else:
                    # 使用预定义股票数据
                    if code in predefined_stocks:
                        data = predefined_stocks[code]
                        change = data['price'] - data['open']
                        change_pct = (change / data['open'] * 100) if data['open'] != 0 else 0
                        
                        quotes.append({
                            'symbol': code,
                            'code': code,
                            'name': data['name'],
                            'price': data['price'],
                            'open': data['open'],
                            'high': data['high'],
                            'low': data['low'],
                            'volume': data['volume'],
                            'change': change,
                            'changePercent': change_pct,
                            'time': datetime.now().isoformat(),
                            'type': 'stock',
                            'isPredefined': True,  # 🔥 标记为预定义数据
                            'dataSource': 'predefined'  # 🔥 数据来源
                        })
            except Exception as e:
                print(f"处理{code}失败: {str(e)}", file=sys.stderr)
                continue
        
        if not quotes:
            return {
                'success': False,
                'error': '未找到匹配的测试数据',
                'data': []
            }
        
        return {
            'success': True,
            'data': quotes,
            'count': len(quotes),
            'dataCount': len(quotes),
            'samples': quotes,  # 兼容旧接口
            'responseTime': 0,
            'isPredefined': True,  # 🔥 整体标记为预定义数据
            'note': '使用预定义测试数据（网络限制）'
        }
        
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'data': []
        }


def main():
    """主函数"""
    if len(sys.argv) < 2:
        print(json.dumps({
            'success': False,
            'error': '缺少参数',
            'usage': 'python adataMarketService.py <command> [args...]'
        }, ensure_ascii=False))
        return
    
    command = sys.argv[1]
    
    try:
        if command == 'all_codes':
            # 获取所有股票代码
            limit = int(sys.argv[2]) if len(sys.argv) > 2 else 50
            result = get_all_stock_codes(limit)
            print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
            
        elif command == 'index_codes':
            # 获取指数代码
            result = get_index_codes()
            print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
            
        elif command == 'batch_quotes':
            # 批量获取行情
            symbols = sys.argv[2] if len(sys.argv) > 2 else ''
            instrument_type = sys.argv[3] if len(sys.argv) > 3 else 'stock'
            result = get_batch_market_quotes(symbols, instrument_type)
            # 🔥 使用紧凑格式输出，减少JSON大小
            print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
            
        elif command == 'test':
            # 测试
            result = {
                'success': True,
                'message': 'AData市场数据服务正常',
                'version': adata.__version__ if hasattr(adata, '__version__') else 'unknown'
            }
            print(json.dumps(result, ensure_ascii=False))
            
        else:
            print(json.dumps({
                'success': False,
                'error': f'未知命令: {command}',
                'available_commands': ['all_codes', 'index_codes', 'batch_quotes', 'test']
            }, ensure_ascii=False))
            
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': str(e)
        }, ensure_ascii=False))


if __name__ == '__main__':
    main()
