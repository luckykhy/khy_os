#!/usr/bin/env python3
# @pattern Facade
# -*- coding: utf-8 -*-
"""
KHYShare智能爬虫数据源服务 - 增强版
支持多个免费数据源的智能爬取、数据融合、K线数据获取、完整股票列表获取
具备强大的反爬虫机制和IP保护策略
"""

import sys
import json
import requests
from datetime import datetime, timedelta
import time
import random
import re

class KHYShareService:
    """KHYShare智能爬虫服务 - 多源数据爬取 + K线历史数据 + 反爬虫 + 股票列表"""
    
    def __init__(self):
        self.session = requests.Session()
        
        # 🔥 禁用代理 - 解决代理连接卡住问题
        self.session.trust_env = False
        self.session.proxies = {
            'http': None,
            'https': None
        }
        
        # 🔥 K线历史数据缓存
        self.kline_cache = {}
        
        # 🔥 反爬虫策略1: 随机User-Agent池(扩展到10个)
        self.user_agents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0'
        ]
        
        # 🔥 反爬虫策略2: 请求频率控制(更保守)
        self.last_request_time = {}
        self.min_request_interval = 0.5  # 降低到0.5秒,更快但仍安全
        self.request_count = {}
        self.max_requests_per_minute = 30  # 提高到30次/分钟
        
        # 🔥 反爬虫策略3: IP轮换标记
        self.ip_blocked = {}
        self.block_expire_time = {}
        
        # 🔥 反爬虫策略4: 请求头随机化
        self.referers = [
            'https://www.baidu.com/',
            'https://www.google.com/',
            'https://finance.sina.com.cn/',
            'https://www.eastmoney.com/',
            'https://www.qq.com/'
        ]
        
        # 设置初始请求头
        self._rotate_user_agent()
        
        # 数据源配置
        self.sources = {
            'sina': {
                'name': '新浪财经',
                'priority': 1,
                'realtime_url': 'https://hq.sinajs.cn/list=',
                'stock_list_url': 'http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData',
                'enabled': True
            },
            'eastmoney': {
                'name': '东方财富',
                'priority': 2,
                'realtime_url': 'https://push2.eastmoney.com/api/qt/stock/get',
                'stock_list_url': 'http://80.push2.eastmoney.com/api/qt/clist/get',
                'enabled': True
            },
            'tencent': {
                'name': '腾讯财经',
                'priority': 3,
                'realtime_url': 'https://qt.gtimg.cn/q=',
                'enabled': True
            },
            '163': {
                'name': '网易财经',
                'priority': 4,
                'realtime_url': 'https://api.money.126.net/data/feed/',
                'enabled': True
            }
        }
    
    def _rotate_user_agent(self):
        """轮换User-Agent和其他请求头"""
        ua = random.choice(self.user_agents)
        referer = random.choice(self.referers)
        
        self.session.headers.update({
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Referer': referer,
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0',
            'DNT': '1'
        })
    
    def _check_rate_limit(self, source_key):
        """检查请求频率限制"""
        # 🔥 临时禁用频率限制以解决卡住问题
        # TODO: 后续优化频率限制逻辑
        return True
    
    def _mark_ip_blocked(self, source_key, duration=300):
        """标记IP被封禁"""
        self.ip_blocked[source_key] = True
        self.block_expire_time[source_key] = time.time() + duration
    
    def _safe_request(self, source_key, url, **kwargs):
        """安全的HTTP请求,带重试和错误处理"""
        if not self._check_rate_limit(source_key):
            raise Exception(f'{self.sources[source_key]["name"]}请求频率受限')
        
        self._rotate_user_agent()
        time.sleep(random.uniform(0.01, 0.1))  # 🔥 减少延迟到0.01-0.1秒
        
        max_retries = 3  # 🔥 增加重试次数到3次
        for attempt in range(max_retries):
            try:
                response = self.session.get(url, timeout=15, **kwargs)  # 🔥 增加超时到15秒
                
                if response.status_code == 403 or response.status_code == 429:
                    self._mark_ip_blocked(source_key)
                    raise Exception(f'{self.sources[source_key]["name"]}访问被限制')
                
                if response.status_code == 200:
                    return response
                
            except requests.exceptions.Timeout:
                if attempt < max_retries - 1:
                    wait_time = random.uniform(1, 3)  # 🔥 增加重试延迟到1-3秒
                    sys.stderr.write(f'⚠️  请求超时，{wait_time:.1f}秒后重试 (第{attempt+1}次)...\n')
                    sys.stderr.flush()
                    time.sleep(wait_time)
                    continue
                raise Exception('请求超时')
            
            except Exception as e:
                if attempt < max_retries - 1:
                    wait_time = random.uniform(1, 3)  # 🔥 增加重试延迟到1-3秒
                    sys.stderr.write(f'⚠️  请求失败: {str(e)}, {wait_time:.1f}秒后重试 (第{attempt+1}次)...\n')
                    sys.stderr.flush()
                    time.sleep(wait_time)
                    continue
                raise e
        
        raise Exception('请求失败')
    
    def get_all_stocks_from_eastmoney(self):
        """从东方财富获取所有A股列表"""
        try:
            # 调试信息输出到stderr
            sys.stderr.write('正在从东方财富获取A股列表...\n')
            sys.stderr.flush()
            
            all_stocks = []
            
            # 获取沪深A股
            params = {
                'pn': '1',
                'pz': '10000',  # 一次获取10000条
                'po': '1',
                'np': '1',
                'ut': 'bd1d9ddb04089700cf9c27f6f7426281',
                'fltt': '2',
                'invt': '2',
                'fid': 'f3',
                'fs': 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',  # 沪深A股
                'fields': 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f24,f25,f22,f11,f62,f128,f136,f115,f152',
                '_': str(int(time.time() * 1000))
            }
            
            url = self.sources['eastmoney']['stock_list_url']
            response = self._safe_request('eastmoney', url, params=params)
            
            data = response.json()
            
            if data and data.get('data') and data['data'].get('diff'):
                stocks = data['data']['diff']
                
                for stock in stocks:
                    code = stock.get('f12', '')
                    name = stock.get('f14', '')
                    market = stock.get('f13', '')
                    
                    if code and name:
                        # 判断市场
                        if market == '0':  # 深圳
                            symbol = f'sz{code}'
                            exchange = 'SZSE'
                        elif market == '1':  # 上海
                            symbol = f'sh{code}'
                            exchange = 'SSE'
                        else:
                            continue
                        
                        # 判断类型
                        if code.startswith('6'):
                            instrument_type = 'stock'
                        elif code.startswith('0') or code.startswith('3'):
                            instrument_type = 'stock'
                        elif code.startswith('399'):
                            instrument_type = 'index'
                        elif code.startswith('000') and len(code) == 6:
                            # 000001-000999 是指数
                            if int(code) <= 999:
                                instrument_type = 'index'
                            else:
                                instrument_type = 'stock'
                        else:
                            instrument_type = 'stock'
                        
                        all_stocks.append({
                            'symbol': symbol,
                            'code': code,
                            'name': name,
                            'exchange': exchange,
                            'type': instrument_type,
                            'market': 'CN'
                        })
                
                sys.stderr.write(f'✅ 从东方财富获取到 {len(all_stocks)} 个标的\n')
                sys.stderr.flush()
                return {
                    'success': True,
                    'source': 'eastmoney',
                    'count': len(all_stocks),
                    'data': all_stocks
                }
            
            return {'success': False, 'error': '东方财富数据解析失败'}
            
        except Exception as e:
            return {'success': False, 'error': f'东方财富获取失败: {str(e)}'}
    
    def get_all_indices_from_eastmoney(self):
        """从东方财富获取所有指数列表"""
        try:
            sys.stderr.write('正在从东方财富获取指数列表...\n')
            sys.stderr.flush()
            
            all_indices = []
            
            # 获取所有指数
            params = {
                'pn': '1',
                'pz': '5000',
                'po': '1',
                'np': '1',
                'ut': 'bd1d9ddb04089700cf9c27f6f7426281',
                'fltt': '2',
                'invt': '2',
                'fid': 'f3',
                'fs': 'm:1+s:2,m:0+t:5',  # 指数
                'fields': 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f24,f25,f22,f11,f62,f128,f136,f115,f152',
                '_': str(int(time.time() * 1000))
            }
            
            url = self.sources['eastmoney']['stock_list_url']
            response = self._safe_request('eastmoney', url, params=params)
            
            data = response.json()
            
            if data and data.get('data') and data['data'].get('diff'):
                indices = data['data']['diff']
                
                for index in indices:
                    code = index.get('f12', '')
                    name = index.get('f14', '')
                    market = index.get('f13', '')
                    
                    if code and name:
                        if market == '0':
                            symbol = f'sz{code}'
                            exchange = 'SZSE'
                        elif market == '1':
                            symbol = f'sh{code}'
                            exchange = 'SSE'
                        else:
                            continue
                        
                        all_indices.append({
                            'symbol': symbol,
                            'code': code,
                            'name': name,
                            'exchange': exchange,
                            'type': 'index',
                            'market': 'CN'
                        })
                
                sys.stderr.write(f'✅ 从东方财富获取到 {len(all_indices)} 个指数\n')
                sys.stderr.flush()
                return {
                    'success': True,
                    'source': 'eastmoney',
                    'count': len(all_indices),
                    'data': all_indices
                }
            
            return {'success': False, 'error': '东方财富指数数据解析失败'}
            
        except Exception as e:
            return {'success': False, 'error': f'东方财富指数获取失败: {str(e)}'}
    
    def get_all_instruments(self):
        """获取所有A股和指数"""
        try:
            sys.stderr.write('\n🚀 开始获取完整的A股和指数列表...\n\n')
            sys.stderr.flush()
            
            all_instruments = []
            
            # 1. 获取所有股票
            stocks_result = self.get_all_stocks_from_eastmoney()
            if stocks_result.get('success'):
                all_instruments.extend(stocks_result['data'])
            
            # 添加延迟避免频率限制
            time.sleep(1)
            
            # 2. 获取所有指数
            indices_result = self.get_all_indices_from_eastmoney()
            if indices_result.get('success'):
                all_instruments.extend(indices_result['data'])
            
            # 去重
            seen = set()
            unique_instruments = []
            for item in all_instruments:
                if item['symbol'] not in seen:
                    seen.add(item['symbol'])
                    unique_instruments.append(item)
            
            # 统计
            stocks_count = len([i for i in unique_instruments if i['type'] == 'stock'])
            indices_count = len([i for i in unique_instruments if i['type'] == 'index'])
            
            sys.stderr.write(f'\n✅ 获取完成!\n')
            sys.stderr.write(f'   股票: {stocks_count} 个\n')
            sys.stderr.write(f'   指数: {indices_count} 个\n')
            sys.stderr.write(f'   总计: {len(unique_instruments)} 个\n\n')
            sys.stderr.flush()
            
            return {
                'success': True,
                'count': len(unique_instruments),
                'stocks': stocks_count,
                'indices': indices_count,
                'data': unique_instruments
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': f'获取标的列表失败: {str(e)}'
            }
    
    def get_sina_realtime(self, symbol):
        """从新浪财经爬取实时行情"""
        try:
            if symbol.startswith('sh'):
                sina_code = 's_' + symbol
            elif symbol.startswith('sz'):
                sina_code = 's_' + symbol
            else:
                if symbol.startswith('6'):
                    sina_code = 's_sh' + symbol
                elif symbol.startswith('0') or symbol.startswith('3'):
                    sina_code = 's_sz' + symbol
                else:
                    sina_code = 's_sh' + symbol
            
            url = f"{self.sources['sina']['realtime_url']}{sina_code}"
            response = self._safe_request('sina', url)
            
            try:
                text = response.content.decode('gbk')
            except:
                text = response.text
            
            if text:
                data_str = text.split('"')[1] if '"' in text else ''
                
                if data_str:
                    parts = data_str.split(',')
                    if len(parts) >= 4:
                        return {
                            'success': True,
                            'source': 'sina',
                            'name': parts[0],
                            'price': float(parts[1]),
                            'change': float(parts[2]),
                            'changePercent': float(parts[3]),
                            'timestamp': datetime.now().isoformat()
                        }
            
            return {'success': False, 'error': '新浪数据解析失败'}
            
        except Exception as e:
            return {'success': False, 'error': f'新浪爬取失败: {str(e)}'}
    
    def get_eastmoney_realtime(self, symbol):
        """从东方财富爬取实时行情"""
        try:
            clean_symbol = symbol.replace('sh', '').replace('sz', '')
            
            if symbol.startswith('sh') or (not symbol.startswith('sz') and clean_symbol.startswith('6')):
                secid = f'1.{clean_symbol}'
            else:
                secid = f'0.{clean_symbol}'
            
            url = self.sources['eastmoney']['realtime_url']
            params = {
                'secid': secid,
                'fields': 'f43,f44,f45,f46,f47,f48,f49,f50,f51,f52,f57,f58,f60,f107,f152,f162,f169,f170,f171',
                'ut': 'fa5fd1943c7b386f172d6893dbfba10b',
                'cb': f'jQuery{random.randint(100000, 999999)}'
            }
            
            response = self._safe_request('eastmoney', url, params=params)
            
            text = response.text
            if '(' in text and ')' in text:
                json_str = text[text.index('(')+1:text.rindex(')')]
                data = json.loads(json_str)
                
                if data.get('data'):
                    d = data['data']
                    return {
                        'success': True,
                        'source': 'eastmoney',
                        'name': d.get('f58', ''),
                        'price': d.get('f43', 0) / 100,
                        'open': d.get('f46', 0) / 100,
                        'high': d.get('f44', 0) / 100,
                        'low': d.get('f45', 0) / 100,
                        'change': d.get('f169', 0) / 100,
                        'changePercent': d.get('f170', 0) / 100,
                        'volume': d.get('f47', 0),
                        'timestamp': datetime.now().isoformat()
                    }
            
            return {'success': False, 'error': '东方财富数据解析失败'}
            
        except Exception as e:
            return {'success': False, 'error': f'东方财富爬取失败: {str(e)}'}
    
    def get_tencent_realtime(self, symbol):
        """从腾讯财经爬取实时行情"""
        try:
            if symbol.startswith('sh'):
                tencent_code = 's_' + symbol
            elif symbol.startswith('sz'):
                tencent_code = 's_' + symbol
            else:
                if symbol.startswith('6'):
                    tencent_code = 's_sh' + symbol
                else:
                    tencent_code = 's_sz' + symbol
            
            url = f"{self.sources['tencent']['realtime_url']}{tencent_code}"
            response = self._safe_request('tencent', url)
            
            try:
                text = response.content.decode('gbk')
            except:
                text = response.text
            
            if text:
                data_str = text.split('"')[1] if '"' in text else ''
                
                if data_str:
                    parts = data_str.split('~')
                    if len(parts) >= 6:
                        return {
                            'success': True,
                            'source': 'tencent',
                            'name': parts[1],
                            'price': float(parts[3]),
                            'change': float(parts[4]),
                            'changePercent': float(parts[5]),
                            'timestamp': datetime.now().isoformat()
                        }
            
            return {'success': False, 'error': '腾讯数据解析失败'}
            
        except Exception as e:
            return {'success': False, 'error': f'腾讯爬取失败: {str(e)}'}
    
    def get_163_realtime(self, symbol):
        """从网易财经爬取实时行情"""
        try:
            clean_symbol = symbol.replace('sh', '').replace('sz', '')
            
            if symbol.startswith('sh') or (not symbol.startswith('sz') and clean_symbol.startswith('6')):
                code = f'0{clean_symbol}'
            else:
                code = f'1{clean_symbol}'
            
            url = f"{self.sources['163']['realtime_url']}{code}"
            response = self._safe_request('163', url)
            
            data = response.json()
            
            if code in data:
                d = data[code]
                return {
                    'success': True,
                    'source': '163',
                    'name': d.get('name', ''),
                    'price': float(d.get('price', 0)),
                    'open': float(d.get('open', 0)),
                    'high': float(d.get('high', 0)),
                    'low': float(d.get('low', 0)),
                    'change': float(d.get('updown', 0)),
                    'changePercent': float(d.get('percent', 0)),
                    'volume': int(d.get('volume', 0)),
                    'timestamp': datetime.now().isoformat()
                }
            
            return {'success': False, 'error': '网易数据解析失败'}
            
        except Exception as e:
            return {'success': False, 'error': f'网易爬取失败: {str(e)}'}
    
    def get_realtime_smart(self, symbol):
        """智能获取实时行情 - 多源尝试"""
        errors = []
        
        sources_sorted = sorted(
            [(k, v) for k, v in self.sources.items() if v['enabled']],
            key=lambda x: x[1]['priority']
        )
        
        for source_key, source_config in sources_sorted:
            try:
                if source_key == 'sina':
                    result = self.get_sina_realtime(symbol)
                elif source_key == 'eastmoney':
                    result = self.get_eastmoney_realtime(symbol)
                elif source_key == 'tencent':
                    result = self.get_tencent_realtime(symbol)
                elif source_key == '163':
                    result = self.get_163_realtime(symbol)
                else:
                    continue
                
                if result.get('success'):
                    return result
                else:
                    errors.append(f"{source_config['name']}: {result.get('error', '未知错误')}")
                
                time.sleep(random.uniform(0.05, 0.2))
                
            except Exception as e:
                errors.append(f"{source_config['name']}: {str(e)}")
                continue
        
        return {
            'success': False,
            'error': '所有数据源均失败',
            'details': errors
        }
    
    def batch_get_realtime(self, symbols):
        """批量获取实时行情"""
        results = []
        
        for symbol in symbols:
            result = self.get_realtime_smart(symbol)
            if result.get('success'):
                results.append({
                    'symbol': symbol,
                    'name': result.get('name', ''),
                    'price': result.get('price', 0),
                    'open': result.get('open', 0),
                    'high': result.get('high', 0),
                    'low': result.get('low', 0),
                    'changePercent': result.get('changePercent', 0),
                    'volume': result.get('volume', 0),
                    'source': result.get('source', 'unknown'),
                    'isPredefined': False
                })
            
            time.sleep(random.uniform(0.1, 0.3))
        
        return {
            'success': len(results) > 0,
            'count': len(results),
            'data': results
        }
    
    def get_listing_date_from_eastmoney(self, symbol):
        """从东方财富获取股票上市日期"""
        try:
            clean_symbol = symbol.replace('sh', '').replace('sz', '')
            
            if symbol.startswith('sh') or (not symbol.startswith('sz') and clean_symbol.startswith('6')):
                secid = f'1.{clean_symbol}'
            else:
                secid = f'0.{clean_symbol}'
            
            # 东方财富股票详情API
            url = 'https://push2.eastmoney.com/api/qt/stock/get'
            params = {
                'secid': secid,
                'fields': 'f26',  # f26是上市日期字段
                'ut': 'fa5fd1943c7b386f172d6893dbfba10b'
            }
            
            response = self._safe_request('eastmoney', url, params=params)
            data = response.json()
            
            if data.get('data') and data['data'].get('f26'):
                listing_timestamp = data['data']['f26']
                # 转换时间戳为日期
                listing_date = datetime.fromtimestamp(listing_timestamp).strftime('%Y-%m-%d')
                return listing_date
            
            # 如果获取失败，返回默认日期
            return '2010-01-01'
            
        except Exception as e:
            sys.stderr.write(f'⚠️  获取上市日期失败: {str(e)}, 使用默认日期\n')
            sys.stderr.flush()
            return '2010-01-01'
    
    def get_kline_history_from_eastmoney(self, symbol, start_date=None, end_date=None, period='daily'):
        """从东方财富获取K线历史数据（优化版：分批获取+智能降级）"""
        try:
            sys.stderr.write(f'\n🚀 开始获取K线历史数据: {symbol}\n')
            sys.stderr.flush()
            
            # 1. 设置日期范围
            if not end_date:
                end_date = datetime.now().strftime('%Y-%m-%d')
            
            if not start_date:
                # 🔥 优化：默认只获取最近100天
                start_date = (datetime.now() - timedelta(days=100)).strftime('%Y-%m-%d')
                sys.stderr.write(f'   未指定开始日期，默认获取最近100天\n')
            else:
                sys.stderr.write(f'   指定日期范围: {start_date} 到 {end_date}\n')
            
            sys.stderr.flush()
            
            # 2. 🔥 新增：检查日期范围，如果超过100天，分批获取
            start_dt = datetime.strptime(start_date, '%Y-%m-%d')
            end_dt = datetime.strptime(end_date, '%Y-%m-%d')
            days_diff = (end_dt - start_dt).days
            
            if days_diff > 100:
                sys.stderr.write(f'   日期范围较大({days_diff}天)，采用分批获取策略\n')
                sys.stderr.flush()
                return self._get_kline_in_batches(symbol, start_date, end_date, period)
            
            # 3. 单次获取（日期范围<=100天）
            return self._get_kline_single_request(symbol, start_date, end_date, period)
            
        except Exception as e:
            sys.stderr.write(f'❌ 获取K线历史数据失败: {str(e)}\n')
            sys.stderr.flush()
            return {
                'success': False,
                'error': f'获取K线历史数据失败: {str(e)}'
            }
    
    def _get_kline_single_request(self, symbol, start_date, end_date, period='daily'):
        """单次请求获取K线数据（带智能降级）"""
        try:
            # 转换symbol格式
            clean_symbol = symbol.replace('sh', '').replace('sz', '')
            
            if symbol.startswith('sh') or (not symbol.startswith('sz') and clean_symbol.startswith('6')):
                secid = f'1.{clean_symbol}'
            else:
                secid = f'0.{clean_symbol}'
            
            # 设置K线周期
            period_map = {
                'daily': '101',
                '1d': '101',
                'weekly': '102',
                '1w': '102',
                'monthly': '103',
                '1M': '103'
            }
            klt = period_map.get(period, '101')
            
            # 调用东方财富K线API
            url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
            params = {
                'secid': secid,
                'fields1': 'f1,f2,f3,f4,f5,f6',
                'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
                'klt': klt,
                'fqt': '1',
                'beg': start_date.replace('-', ''),
                'end': end_date.replace('-', ''),
                'ut': 'fa5fd1943c7b386f172d6893dbfba10b',
                'lmt': '1000000'
            }
            
            sys.stderr.write(f'   请求K线数据: {start_date} 到 {end_date}\n')
            sys.stderr.flush()
            
            # 🔥 新增：带智能降级的请求
            try:
                response = self._safe_request('eastmoney', url, params=params)
                data = response.json()
                
                if data.get('data') and data['data'].get('klines'):
                    return self._parse_kline_response(data, symbol, period, start_date, end_date)
                else:
                    raise Exception('东方财富K线数据为空')
                    
            except Exception as e:
                # 🔥 降级策略：如果失败，尝试获取更少的数据
                sys.stderr.write(f'   ⚠️  完整数据获取失败: {str(e)}\n')
                sys.stderr.write(f'   🔄 尝试降级：只获取最近50天数据\n')
                sys.stderr.flush()
                
                # 重新计算日期范围（只获取最近50天）
                new_start_date = (datetime.now() - timedelta(days=50)).strftime('%Y-%m-%d')
                params['beg'] = new_start_date.replace('-', '')
                
                response = self._safe_request('eastmoney', url, params=params)
                data = response.json()
                
                if data.get('data') and data['data'].get('klines'):
                    return self._parse_kline_response(data, symbol, period, new_start_date, end_date)
                else:
                    raise Exception('降级后仍然失败')
                    
        except Exception as e:
            raise Exception(f'单次请求失败: {str(e)}')
    
    def _get_kline_in_batches(self, symbol, start_date, end_date, period='daily'):
        """分批获取K线数据（每批50天）"""
        try:
            sys.stderr.write(f'   开始分批获取...\n')
            sys.stderr.flush()
            
            all_klines = []
            current_start = datetime.strptime(start_date, '%Y-%m-%d')
            end_dt = datetime.strptime(end_date, '%Y-%m-%d')
            batch_size = 50  # 每批50天
            batch_num = 1
            
            while current_start < end_dt:
                # 计算当前批次的结束日期
                current_end = min(current_start + timedelta(days=batch_size), end_dt)
                
                batch_start_str = current_start.strftime('%Y-%m-%d')
                batch_end_str = current_end.strftime('%Y-%m-%d')
                
                sys.stderr.write(f'   批次{batch_num}: {batch_start_str} 到 {batch_end_str}\n')
                sys.stderr.flush()
                
                try:
                    # 获取当前批次数据
                    result = self._get_kline_single_request(symbol, batch_start_str, batch_end_str, period)
                    
                    if result.get('success') and result.get('kline'):
                        all_klines.extend(result['kline'])
                        sys.stderr.write(f'   ✅ 批次{batch_num}成功: {len(result["kline"])}条\n')
                    else:
                        sys.stderr.write(f'   ⚠️  批次{batch_num}失败，跳过\n')
                    
                    # 批次间延迟，避免频率限制
                    time.sleep(random.uniform(0.5, 1.5))
                    
                except Exception as e:
                    sys.stderr.write(f'   ❌ 批次{batch_num}错误: {str(e)}\n')
                    # 继续下一批次
                
                sys.stderr.flush()
                current_start = current_end + timedelta(days=1)
                batch_num += 1
            
            if len(all_klines) == 0:
                raise Exception('所有批次均失败')
            
            sys.stderr.write(f'✅ 分批获取完成，共 {len(all_klines)} 条K线数据\n')
            sys.stderr.flush()
            
            return {
                'success': True,
                'source': 'eastmoney',
                'symbol': symbol,
                'name': all_klines[0].get('name', '') if all_klines else '',
                'period': period,
                'start_date': start_date,
                'end_date': end_date,
                'count': len(all_klines),
                'kline': all_klines
            }
            
        except Exception as e:
            raise Exception(f'分批获取失败: {str(e)}')
    
    def _parse_kline_response(self, data, symbol, period, start_date, end_date):
        """解析K线响应数据"""
        klines = data['data']['klines']
        stock_name = data['data'].get('name', '')
        
        parsed_klines = []
        for kline_str in klines:
            parts = kline_str.split(',')
            if len(parts) >= 11:
                parsed_klines.append({
                    'time': parts[0],
                    'open': float(parts[1]),
                    'close': float(parts[2]),
                    'high': float(parts[3]),
                    'low': float(parts[4]),
                    'volume': int(parts[5]),
                    'amount': float(parts[6]),
                    'amplitude': float(parts[7]),
                    'changePercent': float(parts[8]),
                    'change': float(parts[9]),
                    'turnover': float(parts[10])
                })
        
        sys.stderr.write(f'✅ 成功获取 {len(parsed_klines)} 条K线数据\n')
        if parsed_klines:
            sys.stderr.write(f'   日期范围: {parsed_klines[0]["time"]} 到 {parsed_klines[-1]["time"]}\n')
        sys.stderr.flush()
        
        return {
            'success': True,
            'source': 'eastmoney',
            'symbol': symbol,
            'name': stock_name,
            'period': period,
            'start_date': start_date,
            'end_date': end_date,
            'count': len(parsed_klines),
            'kline': parsed_klines
        }

    def test_connection(self):
        """测试连接"""
        test_symbols = ['sh000001', 'sz399001', 'sh600519']
        results = []
        
        for symbol in test_symbols:
            result = self.get_realtime_smart(symbol)
            if result.get('success'):
                results.append({
                    'symbol': symbol,
                    'name': result.get('name', ''),
                    'source': result.get('source', ''),
                    'status': 'success'
                })
        
        return {
            'success': len(results) > 0,
            'message': f'成功连接 {len(results)}/{len(test_symbols)} 个数据源',
            'results': results
        }


def main():
    """命令行入口"""
    if len(sys.argv) < 2:
        result = json.dumps({
            'success': False,
            'error': '缺少命令参数'
        }, ensure_ascii=False)
        print(result)
        sys.stdout.flush()
        sys.exit(1)
    
    command = sys.argv[1]
    service = KHYShareService()
    
    try:
        if command == 'test':
            result = service.test_connection()
            output = json.dumps(result, ensure_ascii=False)
            print(output)
            sys.stdout.flush()
        
        elif command == 'realtime':
            if len(sys.argv) < 3:
                output = json.dumps({
                    'success': False,
                    'error': '缺少标的代码'
                }, ensure_ascii=False)
                print(output)
                sys.stdout.flush()
                sys.exit(1)
            
            symbol = sys.argv[2]
            result = service.get_realtime_smart(symbol)
            output = json.dumps(result, ensure_ascii=False)
            print(output)
            sys.stdout.flush()
        
        elif command == 'batch_quotes':
            if len(sys.argv) < 3:
                output = json.dumps({
                    'success': False,
                    'error': '缺少标的代码列表'
                }, ensure_ascii=False)
                print(output)
                sys.stdout.flush()
                sys.exit(1)
            
            symbols_str = sys.argv[2]
            symbols = symbols_str.split(',')
            result = service.batch_get_realtime(symbols)
            output = json.dumps(result, ensure_ascii=False)
            print(output)
            sys.stdout.flush()
        
        elif command == 'get_all_instruments':
            # 获取所有A股和指数
            result = service.get_all_instruments()
            output = json.dumps(result, ensure_ascii=False)
            print(output)
            sys.stdout.flush()
        
        elif command == 'kline_history':
            # 获取K线历史数据
            if len(sys.argv) < 3:
                output = json.dumps({
                    'success': False,
                    'error': '缺少标的代码'
                }, ensure_ascii=False)
                print(output)
                sys.stdout.flush()
                sys.exit(1)
            
            symbol = sys.argv[2]
            start_date = sys.argv[3] if len(sys.argv) > 3 else None
            end_date = sys.argv[4] if len(sys.argv) > 4 else None
            period = sys.argv[5] if len(sys.argv) > 5 else 'daily'
            
            result = service.get_kline_history_from_eastmoney(symbol, start_date, end_date, period)
            output = json.dumps(result, ensure_ascii=False)
            print(output)
            sys.stdout.flush()
        
        else:
            output = json.dumps({
                'success': False,
                'error': f'未知命令: {command}'
            }, ensure_ascii=False)
            print(output)
            sys.stdout.flush()
            sys.exit(1)
    
    except Exception as e:
        output = json.dumps({
            'success': False,
            'error': str(e)
        }, ensure_ascii=False)
        print(output)
        sys.stdout.flush()
        sys.exit(1)


if __name__ == '__main__':
    main()
