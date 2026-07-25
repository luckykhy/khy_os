# -*- coding: utf-8 -*-
# @pattern Command
import os
import sys

# 强制禁用所有代理
for proxy_var in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']:
    os.environ[proxy_var] = ''
os.environ['NO_PROXY'] = '*'
os.environ['no_proxy'] = '*'

import akshare as ak
import json
import pandas as pd
from datetime import datetime, timedelta
import urllib3

# 禁用SSL警告
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# 设置请求超时和重试
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

def create_session():
    """创建带重试机制的session"""
    session = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=1,
        status_forcelist=[500, 502, 503, 504]
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount('http://', adapter)
    session.mount('https://', adapter)
    session.verify = False  # 禁用SSL验证
    return session

def get_stock_realtime(symbol):
    """获取股票实时数据"""
    try:
        df = ak.stock_zh_a_spot_em()
        stock_data = df[df['代码'] == symbol]
        
        if stock_data.empty:
            return {"error": "股票代码不存在"}
        
        row = stock_data.iloc[0]
        
        result = {
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
        
        return result
        
    except Exception as e:
        return {"error": f"获取实时数据失败: {str(e)}"}

def get_stock_kline(symbol, period='daily', count=100):
    """获取股票K线数据"""
    try:
        if period == 'daily':
            df = ak.stock_zh_a_hist(symbol=symbol, period="daily", adjust="qfq")
        elif period == 'weekly':
            df = ak.stock_zh_a_hist(symbol=symbol, period="weekly", adjust="qfq")
        elif period == 'monthly':
            df = ak.stock_zh_a_hist(symbol=symbol, period="monthly", adjust="qfq")
        else:
            df = ak.stock_zh_a_hist(symbol=symbol, period="daily", adjust="qfq")
        
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
        
        return {
            "symbol": symbol,
            "kline": kline_data,
            "source": "AKShare历史数据"
        }
        
    except Exception as e:
        return {"error": f"获取K线数据失败: {str(e)}"}

def get_index_realtime(symbol):
    """获取指数实时数据"""
    try:
        df = ak.stock_zh_index_spot_em()
        index_data = df[df['代码'] == symbol]
        
        if index_data.empty:
            return {"error": "指数代码不存在"}
        
        row = index_data.iloc[0]
        
        result = {
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
        
        return result
        
    except Exception as e:
        return {"error": f"获取指数数据失败: {str(e)}"}

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "参数不足"}))
        sys.exit(1)
    
    action = sys.argv[1]
    symbol = sys.argv[2]
    
    try:
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
    except Exception as e:
        result = {"error": f"执行失败: {str(e)}"}
    
    print(json.dumps(result, ensure_ascii=False, default=str))
