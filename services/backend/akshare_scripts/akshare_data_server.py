# -*- coding: utf-8 -*-
# @pattern Command
"""
AKShare 数据获取脚本 - 服务器版本
直接使用pip安装的AKShare，不依赖源码路径
"""
import json
import pandas as pd
from datetime import datetime

# SSL 修复
import ssl
import urllib3
urllib3.disable_warnings()
ssl._create_default_https_context = ssl._create_unverified_context

# 导入 AKShare (使用pip安装的版本)
import akshare as ak

def get_stock_kline(symbol, period='daily', start_date=None, end_date=None, instrument_type='stock'):
    """获取K线数据"""
    try:
        print(f"📊 获取K线: symbol={symbol}, type={instrument_type}, period={period}", file=sys.stderr)
        print(f"   日期: {start_date} 至 {end_date}", file=sys.stderr)
        
        # 根据类型选择接口
        if instrument_type == 'index':
            # 指数：使用 stock_zh_index_daily
            print(f"   使用指数接口: stock_zh_index_daily", file=sys.stderr)
            
            # 转换符号格式
            if symbol.startswith('sh') or symbol.startswith('sz'):
                ak_symbol = symbol
            elif symbol.startswith('399'):
                ak_symbol = f"sz{symbol}"
            else:
                ak_symbol = f"sh{symbol}"
            
            print(f"   AKShare符号: {ak_symbol}", file=sys.stderr)
            df = ak.stock_zh_index_daily(symbol=ak_symbol)
            
        else:
            # 股票：使用 stock_zh_a_hist
            print(f"   使用股票接口: stock_zh_a_hist", file=sys.stderr)
            df = ak.stock_zh_a_hist(symbol=symbol, period=period, adjust="qfq")
        
        if df.empty:
            return {"success": False, "error": "无数据"}
        
        print(f"   原始数据: {len(df)} 条", file=sys.stderr)
        
        # 统一列名
        df.columns = df.columns.str.lower()
        
        # 确保有日期列
        if 'date' not in df.columns and '日期' not in df.columns:
            if df.index.name and 'date' in df.index.name.lower():
                df['date'] = df.index
            else:
                return {"success": False, "error": f"找不到日期列: {list(df.columns)}"}
        
        # 统一使用 'date' 列名
        if '日期' in df.columns:
            df.rename(columns={'日期': 'date'}, inplace=True)
        
        # 确保日期是 datetime 类型
        df['date'] = pd.to_datetime(df['date'])
        
        # 日期过滤
        if start_date:
            start_dt = pd.to_datetime(start_date)
            df = df[df['date'] >= start_dt]
            print(f"   开始日期过滤: {start_date}, 剩余 {len(df)} 条", file=sys.stderr)
        
        if end_date:
            end_dt = pd.to_datetime(end_date)
            df = df[df['date'] <= end_dt]
            print(f"   结束日期过滤: {end_date}, 剩余 {len(df)} 条", file=sys.stderr)
        
        print(f"   最终数据: {len(df)} 条", file=sys.stderr)
        
        # 统一列名（中英文兼容）
        column_map = {
            '开盘': 'open',
            '最高': 'high', 
            '最低': 'low',
            '收盘': 'close',
            '成交量': 'volume'
        }
        df.rename(columns=column_map, inplace=True)
        
        # 转换为K线格式
        kline_data = []
        for _, row in df.iterrows():
            kline_data.append({
                "time": row['date'].strftime('%Y-%m-%d'),
                "open": float(row['open']),
                "high": float(row['high']),
                "low": float(row['low']),
                "close": float(row['close']),
                "volume": int(row['volume']) if 'volume' in row and pd.notna(row['volume']) else 0
            })
        
        return {
            "success": True,
            "symbol": symbol,
            "kline": kline_data,
            "count": len(kline_data),
            "source": "AKShare"
        }
        
    except Exception as e:
        print(f"❌ 错误: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 3:
        print(json.dumps({"error": "参数不足"}))
        sys.exit(1)
    
    action = sys.argv[1]
    symbol = sys.argv[2]
    
    if action == "kline":
        # 参数: kline symbol period startDate endDate instrumentType
        period = sys.argv[3] if len(sys.argv) > 3 else 'daily'
        start_date = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
        end_date = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None
        instrument_type = sys.argv[6] if len(sys.argv) > 6 else 'stock'
        
        # 转换日期格式 YYYYMMDD -> YYYY-MM-DD
        if start_date and len(start_date) == 8:
            start_date = f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:8]}"
        if end_date and len(end_date) == 8:
            end_date = f"{end_date[:4]}-{end_date[4:6]}-{end_date[6:8]}"
        
        result = get_stock_kline(symbol, period, start_date, end_date, instrument_type)
    else:
        result = {"error": "仅支持 kline 操作"}
    
    print(json.dumps(result, ensure_ascii=False, default=str))
