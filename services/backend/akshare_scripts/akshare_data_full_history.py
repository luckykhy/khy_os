# -*- coding: utf-8 -*-
# @pattern Command
"""
AKShare数据获取脚本 - 支持完整历史数据
修复：支持从上市日期开始获取完整历史数据
"""

import akshare as ak
import json
import sys
import pandas as pd
from datetime import datetime, timedelta

def get_stock_realtime(symbol):
    """获取股票实时数据"""
    try:
        # 获取实时数据
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
        return {"error": str(e)}

def get_stock_kline(symbol, period='daily', start_date=None, end_date=None, count=None, instrument_type='stock'):
    """获取K线数据 - 支持股票和指数，支持完整历史数据"""
    try:
        print(f"📊 获取K线数据: symbol={symbol}, type={instrument_type}, period={period}", file=sys.stderr)
        print(f"   日期范围: {start_date} 至 {end_date}, count={count}", file=sys.stderr)
        
        # 根据标的类型选择不同的接口
        if instrument_type == 'index':
            # 指数使用 stock_zh_index_daily - 返回完整历史数据
            print(f"   使用指数接口: stock_zh_index_daily", file=sys.stderr)
            df = ak.stock_zh_index_daily(symbol=symbol)
            
            # 打印列名以便调试
            print(f"   返回的列名: {list(df.columns)}", file=sys.stderr)
            
        else:
            # 股票使用 stock_zh_a_hist
            print(f"   使用股票接口: stock_zh_a_hist", file=sys.stderr)
            if period == 'daily':
                df = ak.stock_zh_a_hist(symbol=symbol, period="daily", adjust="qfq")
            elif period == 'weekly':
                df = ak.stock_zh_a_hist(symbol=symbol, period="weekly", adjust="qfq")
            elif period == 'monthly':
                df = ak.stock_zh_a_hist(symbol=symbol, period="monthly", adjust="qfq")
            else:
                df = ak.stock_zh_a_hist(symbol=symbol, period="daily", adjust="qfq")
        
        if df.empty:
            return {"success": False, "error": "无法获取K线数据"}
        
        print(f"   原始数据量: {len(df)} 条", file=sys.stderr)
        
        # 统一列名（指数和股票的列名可能不同）
        # AKShare的stock_zh_index_daily返回的列名可能是中文
        date_col = None
        for col in df.columns:
            if col in ['date', '日期', 'Date', 'DATE']:
                date_col = col
                break
        
        if date_col and date_col != '日期':
            df.rename(columns={date_col: '日期'}, inplace=True)
            print(f"   列名转换: {date_col} → 日期", file=sys.stderr)
        
        # 确保日期列是datetime类型
        if '日期' in df.columns:
            df['日期'] = pd.to_datetime(df['日期'])
        else:
            # 如果没有日期列，尝试使用索引
            if df.index.name in ['date', 'Date', 'DATE']:
                df['日期'] = pd.to_datetime(df.index)
            else:
                return {"success": False, "error": f"找不到日期列，可用列: {list(df.columns)}"}
        
        # 根据日期范围过滤
        if start_date:
            try:
                start_dt = pd.to_datetime(start_date)
                df = df[df['日期'] >= start_dt]
                print(f"   应用开始日期过滤: {start_date}, 剩余 {len(df)} 条", file=sys.stderr)
            except Exception as e:
                print(f"   ⚠️ 开始日期解析失败: {e}", file=sys.stderr)
        
        if end_date:
            try:
                end_dt = pd.to_datetime(end_date)
                df = df[df['日期'] <= end_dt]
                print(f"   应用结束日期过滤: {end_date}, 剩余 {len(df)} 条", file=sys.stderr)
            except Exception as e:
                print(f"   ⚠️ 结束日期解析失败: {e}", file=sys.stderr)
        
        # 如果指定了count，取最后count条
        if count and count > 0:
            df = df.tail(count)
            print(f"   应用count限制: {count}, 最终 {len(df)} 条", file=sys.stderr)
        
        print(f"   最终数据量: {len(df)} 条", file=sys.stderr)
        
        # 转换为K线格式
        kline_data = []
        for _, row in df.iterrows():
            kline_data.append({
                "time": row['日期'].strftime('%Y-%m-%d'),
                "open": float(row['开盘']),
                "high": float(row['最高']),
                "low": float(row['最低']),
                "close": float(row['收盘']),
                "volume": int(row['成交量']) if '成交量' in row and pd.notna(row['成交量']) else 0
            })
        
        return {
            "success": True,
            "symbol": symbol,
            "kline": kline_data,
            "count": len(kline_data),
            "source": "AKShare每日数据"
        }
        
    except Exception as e:
        print(f"❌ 获取K线数据失败: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {"success": False, "error": str(e)}

def get_index_realtime(symbol):
    """获取指数实时数据"""
    try:
        # 获取指数实时数据
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
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "参数不足"}))
        sys.exit(1)
    
    action = sys.argv[1]
    symbol = sys.argv[2]
    
    if action == "realtime":
        result = get_stock_realtime(symbol)
    elif action == "kline":
        # 解析参数: kline symbol period startDate [endDate] [instrumentType]
        period = sys.argv[3] if len(sys.argv) > 3 else 'daily'
        start_date = sys.argv[4] if len(sys.argv) > 4 else None
        end_date = sys.argv[5] if len(sys.argv) > 5 else None
        instrument_type = sys.argv[6] if len(sys.argv) > 6 else 'stock'
        
        # 转换日期格式 (YYYYMMDD -> YYYY-MM-DD)
        if start_date and len(start_date) == 8:
            start_date = f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:8]}"
        if end_date and len(end_date) == 8:
            end_date = f"{end_date[:4]}-{end_date[4:6]}-{end_date[6:8]}"
        
        result = get_stock_kline(symbol, period, start_date, end_date, None, instrument_type)
    elif action == "index":
        result = get_index_realtime(symbol)
    else:
        result = {"error": "未知操作"}
    
    print(json.dumps(result, ensure_ascii=False, default=str))
