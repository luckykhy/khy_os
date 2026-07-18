/**
 * Static configuration for ComprehensiveDataService.
 * Extracted to reduce file size and improve maintainability.
 */

function createDataSourcesConfig() {
  return {

      // 1. AKShare — open-source Python finance data

      akshare: {

        name: 'AKShare',

        priority: 1,

        enabled: process.env.ENABLE_AKSHARE !== 'false',

        description: 'AKShare open-source financial data API — stocks, indices, futures',

        coverage: {

          stocks: true,

          indices: true,

          futures: false, // 期货数据获取功能暂未实现

          funds: true,

          bonds: true

        },

        historicalRange: '1990-01-01 to present',

        updateFrequency: 'realtime',

        language: 'Python',

        apiKey: false,

        successRate: 80,

        dependencies: ['akshare', 'pandas']

      },



      // 2. AData — Python finance data library

      adata: {

        name: 'AData',

        priority: 2,

        enabled: process.env.ENABLE_ADATA !== 'false',

        description: 'AData Python finance data library — comprehensive A-share data',

        coverage: {

          stocks: true,

          indices: true,

          futures: false, // 期货数据获取功能暂未实现

          funds: true,

          bonds: true

        },

        historicalRange: '1990-01-01 to present',

        updateFrequency: 'realtime',

        language: 'Python',

        apiKey: false,

        successRate: 95,

        dependencies: ['pandas', 'requests', 'beautifulsoup4', 'tqdm', 'py_mini_racer']

      },



      // 3. EFinance — Eastmoney data interface

      efinance: {

        name: 'EFinance',

        priority: 3,

        enabled: process.env.ENABLE_EFINANCE !== 'false',

        description: 'EFinance — Eastmoney data interface for A-share data',

        coverage: {

          stocks: true,

          indices: true,

          futures: false,

          funds: true,

          bonds: false

        },

        historicalRange: '2000-01-01 to present',

        updateFrequency: 'realtime',

        language: 'Python',

        apiKey: false,

        successRate: 90,

        dependencies: ['efinance', 'pandas']

      },



      // 99. Enhanced Mock — always-on fallback

      mock: {

        name: '增强模拟数据',

        priority: 99,

        enabled: true, // ✅ 始终保留兜底，确保K线接口永不返回空白

        description: '智能混合数据策略：优先使用数据库历史真实数据，用高质量模拟数据补充缺失部分',

        coverage: {

          stocks: true,

          indices: true,

          futures: true,

          funds: true,

          bonds: true

        },

        historicalRange: '1990-01-01至今',

        updateFrequency: '实时',

        language: 'JavaScript',

        apiKey: false,

        successRate: 100,

        dependencies: []

      }

    };
}

function createMarketsConfig() {
  return {

      // 美国市场

      'NYSE': {

        name: '纽约证券交易所',

        code: 'NYSE',

        country: 'US',

        timezone: 'America/New_York',

        tradingHours: '09:30-16:00',

        established: '1792-05-17',

        instruments: ['stocks', 'etfs', 'bonds'],

        currency: 'USD'

      },

      'NASDAQ': {

        name: '纳斯达克',

        code: 'NASDAQ',

        country: 'US',

        timezone: 'America/New_York',

        tradingHours: '09:30-16:00',

        established: '1971-02-08',

        instruments: ['stocks', 'etfs'],

        currency: 'USD'

      },

      'NYMEX': {

        name: '纽约商品交易所',

        code: 'NYMEX',

        country: 'US',

        timezone: 'America/New_York',

        tradingHours: '18:00-17:00+1',

        established: '1872-01-01',

        instruments: ['futures', 'options'],

        currency: 'USD'

      },

      'COMEX': {

        name: '纽约商品交易所金属分部',

        code: 'COMEX',

        country: 'US',

        timezone: 'America/New_York',

        tradingHours: '18:00-17:00+1',

        established: '1933-01-01',

        instruments: ['futures', 'options'],

        currency: 'USD'

      },

      'CBOT': {

        name: '芝加哥期货交易所',

        code: 'CBOT',

        country: 'US',

        timezone: 'America/Chicago',

        tradingHours: '17:00-16:20+1',

        established: '1848-04-03',

        instruments: ['futures', 'options'],

        currency: 'USD'

      },



      // 欧洲市场

      'LSE': {

        name: '伦敦证券交易所',

        code: 'LSE',

        country: 'UK',

        timezone: 'Europe/London',

        tradingHours: '08:00-16:30',

        established: '1801-01-01',

        instruments: ['stocks', 'etfs', 'bonds'],

        currency: 'GBP'

      },

      'XETRA': {

        name: '德国电子交易系统',

        code: 'XETRA',

        country: 'DE',

        timezone: 'Europe/Berlin',

        tradingHours: '09:00-17:30',

        established: '1997-11-28',

        instruments: ['stocks', 'etfs', 'bonds'],

        currency: 'EUR'

      },

      'EPA': {

        name: '巴黎泛欧交易所',

        code: 'EPA',

        country: 'FR',

        timezone: 'Europe/Paris',

        tradingHours: '09:00-17:30',

        established: '2000-09-22',

        instruments: ['stocks', 'etfs', 'bonds'],

        currency: 'EUR'

      },

      'AEX': {

        name: '阿姆斯特丹交易所',

        code: 'AEX',

        country: 'NL',

        timezone: 'Europe/Amsterdam',

        tradingHours: '09:00-17:30',

        established: '1602-01-01',

        instruments: ['stocks', 'etfs', 'bonds'],

        currency: 'EUR'

      },



      // 亚洲市场

      'TSE': {

        name: '东京证券交易所',

        code: 'TSE',

        country: 'JP',

        timezone: 'Asia/Tokyo',

        tradingHours: '09:00-11:30,12:30-15:00',

        established: '1878-05-15',

        instruments: ['stocks', 'etfs', 'bonds'],

        currency: 'JPY'

      },

      'HKEX': {

        name: '香港交易所',

        code: 'HKEX',

        country: 'HK',

        timezone: 'Asia/Hong_Kong',

        tradingHours: '09:30-12:00,13:00-16:00',

        established: '1891-02-03',

        instruments: ['stocks', 'etfs', 'bonds'],

        currency: 'HKD'

      },

      'KRX': {

        name: '韩国交易所',

        code: 'KRX',

        country: 'KR',

        timezone: 'Asia/Seoul',

        tradingHours: '09:00-15:30',

        established: '2005-01-27',

        instruments: ['stocks', 'etfs', 'bonds'],

        currency: 'KRW'

      },

      'TWSE': {

        name: '台湾证券交易所',

        code: 'TWSE',

        country: 'TW',

        timezone: 'Asia/Taipei',

        tradingHours: '09:00-13:30',

        established: '1961-10-23',

        instruments: ['stocks', 'etfs', 'bonds'],

        currency: 'TWD'

      },



      // 中国市场

      'SSE': {

        name: '上海证券交易所',

        code: 'SSE',

        country: 'CN',

        timezone: 'Asia/Shanghai',

        tradingHours: '09:30-11:30,13:00-15:00',

        established: '1990-12-19',

        instruments: ['stocks', 'indices', 'bonds', 'funds'],

        currency: 'CNY'

      },

      'SZSE': {

        name: '深圳证券交易所',

        code: 'SZSE',

        country: 'CN',

        timezone: 'Asia/Shanghai',

        tradingHours: '09:30-11:30,13:00-15:00',

        established: '1991-07-03',

        instruments: ['stocks', 'indices', 'bonds', 'funds'],

        currency: 'CNY'

      },

      'SHFE': {

        name: '上海期货交易所',

        code: 'SHFE',

        country: 'CN',

        timezone: 'Asia/Shanghai',

        tradingHours: '09:00-10:15,10:30-11:30,13:30-15:00,21:00-02:30',

        established: '1999-12-28',

        instruments: ['futures'],

        currency: 'CNY'

      },

      'DCE': {

        name: '大连商品交易所',

        code: 'DCE',

        country: 'CN',

        timezone: 'Asia/Shanghai',

        tradingHours: '09:00-10:15,10:30-11:30,13:30-15:00,21:00-23:00',

        established: '1993-02-28',

        instruments: ['futures'],

        currency: 'CNY'

      },

      'CZCE': {

        name: '郑州商品交易所',

        code: 'CZCE',

        country: 'CN',

        timezone: 'Asia/Shanghai',

        tradingHours: '09:00-10:15,10:30-11:30,13:30-15:00,21:00-23:30',

        established: '1990-10-12',

        instruments: ['futures'],

        currency: 'CNY'

      },

      'CFFEX': {

        name: '中国金融期货交易所',

        code: 'CFFEX',

        country: 'CN',

        timezone: 'Asia/Shanghai',

        tradingHours: '09:30-11:30,13:00-15:00',

        established: '2006-09-08',

        instruments: ['futures'],

        currency: 'CNY'

      },



      // 虚拟市场

      'FOREX': {

        name: '外汇市场',

        code: 'FOREX',

        country: 'GLOBAL',

        timezone: 'UTC',

        tradingHours: '24/7',

        established: '1971-01-01',

        instruments: ['forex'],

        currency: 'VARIOUS'

      },

      'CRYPTO': {

        name: '加密货币市场',

        code: 'CRYPTO',

        country: 'GLOBAL',

        timezone: 'UTC',

        tradingHours: '24/7',

        established: '2009-01-03',

        instruments: ['cryptocurrency'],

        currency: 'VARIOUS'

      }

    };
}

function createImportantInstrumentsConfig() {
    return {

      // 全球主要指数

      globalIndices: [

        // 美国指数

        {

          symbol: '^GSPC',

          name: 'S&P 500',

          market: 'NYSE',

          country: 'US',

          type: 'index',

          established: '1957-03-04',

          baseDate: '1941-1943',

          baseValue: 10,

          description: '美国标准普尔500指数，代表美国大盘股'

        },

        {

          symbol: '^DJI',

          name: 'Dow Jones Industrial Average',

          market: 'NYSE',

          country: 'US',

          type: 'index',

          established: '1896-05-26',

          baseDate: '1896-05-26',

          baseValue: 40.94,

          description: '道琼斯工业平均指数，美国最古老的股票指数'

        },

        {

          symbol: '^IXIC',

          name: 'NASDAQ Composite',

          market: 'NASDAQ',

          country: 'US',

          type: 'index',

          established: '1971-02-05',

          baseDate: '1971-02-05',

          baseValue: 100,

          description: '纳斯达克综合指数，科技股为主'

        },

        

        // 欧洲指数

        {

          symbol: '^FTSE',

          name: 'FTSE 100',

          market: 'LSE',

          country: 'UK',

          type: 'index',

          established: '1984-01-03',

          baseDate: '1983-12-30',

          baseValue: 1000,

          description: '英国富时100指数'

        },

        {

          symbol: '^GDAXI',

          name: 'DAX',

          market: 'XETRA',

          country: 'DE',

          type: 'index',

          established: '1988-07-01',

          baseDate: '1987-12-30',

          baseValue: 1000,

          description: '德国DAX指数'

        },

        {

          symbol: '^FCHI',

          name: 'CAC 40',

          market: 'EPA',

          country: 'FR',

          type: 'index',

          established: '1987-07-15',

          baseDate: '1987-12-31',

          baseValue: 1000,

          description: '法国CAC40指数'

        },

        

        // 亚洲指数

        {

          symbol: '^N225',

          name: 'Nikkei 225',

          market: 'TSE',

          country: 'JP',

          type: 'index',

          established: '1950-09-07',

          baseDate: '1949-05-16',

          baseValue: 176.21,

          description: '日经225指数'

        },

        {

          symbol: '^HSI',

          name: 'Hang Seng Index',

          market: 'HKEX',

          country: 'HK',

          type: 'index',

          established: '1969-11-24',

          baseDate: '1964-07-31',

          baseValue: 100,

          description: '香港恒生指数'

        },

        {

          symbol: '^KS11',

          name: 'KOSPI',

          market: 'KRX',

          country: 'KR',

          type: 'index',

          established: '1983-01-04',

          baseDate: '1980-01-04',

          baseValue: 100,

          description: '韩国综合股价指数'

        },

        

        // 中国指数

        {

          symbol: '000001.SS',

          name: '上证指数',

          market: 'SSE',

          country: 'CN',

          type: 'index',

          established: '1991-07-15',

          baseDate: '1990-12-19',

          baseValue: 100,

          description: '反映上海证券交易所上市股票价格的综合变动情况'

        },

        {

          symbol: '000300.SS',

          name: '沪深300',

          market: 'SSE',

          country: 'CN',

          type: 'index',

          established: '2005-04-08',

          baseDate: '2004-12-31',

          baseValue: 1000,

          description: '沪深两市300只A股的综合指数'

        },

        {

          symbol: '399001.SZ',

          name: '深证成指',

          market: 'SZSE',

          country: 'CN',

          type: 'index',

          established: '1995-01-23',

          baseDate: '1994-07-20',

          baseValue: 1000,

          description: '反映深圳证券市场的整体走势'

        },

        {

          symbol: '399006.SZ',

          name: '创业板指',

          market: 'SZSE',

          country: 'CN',

          type: 'index',

          established: '2010-06-01',

          baseDate: '2010-05-31',

          baseValue: 1000,

          description: '反映创业板市场走势'

        }

      ],



      // 全球知名股票

      globalStocks: [

        // 美国科技股

        {

          symbol: 'AAPL',

          name: 'Apple Inc.',

          market: 'NASDAQ',

          country: 'US',

          type: 'stock',

          established: '1980-12-12',

          industry: 'Technology',

          sector: 'Consumer Electronics',

          description: '苹果公司，全球最大的科技公司之一'

        },

        {

          symbol: 'MSFT',

          name: 'Microsoft Corporation',

          market: 'NASDAQ',

          country: 'US',

          type: 'stock',

          established: '1986-03-13',

          industry: 'Technology',

          sector: 'Software',

          description: '微软公司，全球领先的软件公司'

        },

        {

          symbol: 'GOOGL',

          name: 'Alphabet Inc.',

          market: 'NASDAQ',

          country: 'US',

          type: 'stock',

          established: '2004-08-19',

          industry: 'Technology',

          sector: 'Internet Services',

          description: '谷歌母公司Alphabet'

        },

        {

          symbol: 'AMZN',

          name: 'Amazon.com Inc.',

          market: 'NASDAQ',

          country: 'US',

          type: 'stock',

          established: '1997-05-15',

          industry: 'Technology',

          sector: 'E-commerce',

          description: '亚马逊公司，全球最大的电商和云服务提供商'

        },

        {

          symbol: 'TSLA',

          name: 'Tesla Inc.',

          market: 'NASDAQ',

          country: 'US',

          type: 'stock',

          established: '2010-06-29',

          industry: 'Automotive',

          sector: 'Electric Vehicles',

          description: '特斯拉公司，电动汽车和清洁能源公司'

        },

        

        // 美国传统股票

        {

          symbol: 'BRK-A',

          name: 'Berkshire Hathaway Inc.',

          market: 'NYSE',

          country: 'US',

          type: 'stock',

          established: '1980-12-30',

          industry: 'Financial Services',

          sector: 'Diversified Investments',

          description: '伯克希尔·哈撒韦公司，巴菲特的投资公司'

        },

        {

          symbol: 'JPM',

          name: 'JPMorgan Chase & Co.',

          market: 'NYSE',

          country: 'US',

          type: 'stock',

          established: '1969-03-05',

          industry: 'Financial Services',

          sector: 'Banking',

          description: '摩根大通，美国最大的银行之一'

        },

        

        // 欧洲股票

        {

          symbol: 'ASML.AS',

          name: 'ASML Holding N.V.',

          market: 'AEX',

          country: 'NL',

          type: 'stock',

          established: '1995-03-30',

          industry: 'Technology',

          sector: 'Semiconductor Equipment',

          description: '阿斯麦公司，全球领先的光刻机制造商'

        },

        {

          symbol: 'SAP.DE',

          name: 'SAP SE',

          market: 'XETRA',

          country: 'DE',

          type: 'stock',

          established: '1988-08-04',

          industry: 'Technology',

          sector: 'Enterprise Software',

          description: 'SAP公司，全球最大的企业软件公司之一'

        },

        

        // 亚洲股票

        {

          symbol: '7203.T',

          name: 'Toyota Motor Corporation',

          market: 'TSE',

          country: 'JP',

          type: 'stock',

          established: '1949-05-16',

          industry: 'Automotive',

          sector: 'Automobile Manufacturing',

          description: '丰田汽车公司，全球最大的汽车制造商之一'

        },

        {

          symbol: '005930.KS',

          name: 'Samsung Electronics Co., Ltd.',

          market: 'KRX',

          country: 'KR',

          type: 'stock',

          established: '1975-06-11',

          industry: 'Technology',

          sector: 'Consumer Electronics',

          description: '三星电子，全球最大的电子产品制造商之一'

        },

        {

          symbol: '2330.TW',

          name: 'Taiwan Semiconductor Manufacturing Company',

          market: 'TWSE',

          country: 'TW',

          type: 'stock',

          established: '1994-09-05',

          industry: 'Technology',

          sector: 'Semiconductors',

          description: '台积电，全球最大的半导体代工厂'

        },

        

        // 中国股票

        {

          symbol: '600519.SS',

          name: '贵州茅台',

          market: 'SSE',

          country: 'CN',

          type: 'stock',

          established: '2001-08-27',

          industry: '白酒制造',

          sector: 'Beverages',

          description: '中国白酒行业龙头企业'

        },

        {

          symbol: '000858.SZ',

          name: '五粮液',

          market: 'SZSE',

          country: 'CN',

          type: 'stock',

          established: '1998-04-27',

          industry: '白酒制造',

          sector: 'Beverages',

          description: '中国白酒行业知名企业'

        },

        {

          symbol: '000001.SZ',

          name: '平安银行',

          market: 'SZSE',

          country: 'CN',

          type: 'stock',

          established: '1991-04-03',

          industry: '银行业',

          sector: 'Banking',

          description: '全国性股份制商业银行'

        }

      ],



      // 全球ETF

      globalETFs: [

        {

          symbol: 'SPY',

          name: 'SPDR S&P 500 ETF Trust',

          market: 'NYSE',

          country: 'US',

          type: 'etf',

          established: '1993-01-22',

          underlying: 'S&P 500 Index',

          description: '跟踪标普500指数的ETF'

        },

        {

          symbol: 'QQQ',

          name: 'Invesco QQQ Trust',

          market: 'NASDAQ',

          country: 'US',

          type: 'etf',

          established: '1999-03-10',

          underlying: 'NASDAQ-100 Index',

          description: '跟踪纳斯达克100指数的ETF'

        },

        {

          symbol: 'VTI',

          name: 'Vanguard Total Stock Market ETF',

          market: 'NYSE',

          country: 'US',

          type: 'etf',

          established: '2001-05-24',

          underlying: 'CRSP US Total Market Index',

          description: '跟踪美国全市场股票指数的ETF'

        }

      ],



      // 全球商品期货

      globalCommodities: [

        // 贵金属

        {

          symbol: 'GC=F',

          name: '黄金期货',

          market: 'COMEX',

          country: 'US',

          type: 'futures',

          established: '1974-12-31',

          underlying: '黄金',

          contractSize: '100盎司',

          tickSize: '0.10美元/盎司',

          description: 'COMEX黄金期货合约'

        },

        {

          symbol: 'SI=F',

          name: '白银期货',

          market: 'COMEX',

          country: 'US',

          type: 'futures',

          established: '1963-07-01',

          underlying: '白银',

          contractSize: '5000盎司',

          tickSize: '0.005美元/盎司',

          description: 'COMEX白银期货合约'

        },

        

        // 能源

        {

          symbol: 'CL=F',

          name: '原油期货',

          market: 'NYMEX',

          country: 'US',

          type: 'futures',

          established: '1983-03-30',

          underlying: 'WTI原油',

          contractSize: '1000桶',

          tickSize: '0.01美元/桶',

          description: 'NYMEX WTI原油期货合约'

        },

        {

          symbol: 'NG=F',

          name: '天然气期货',

          market: 'NYMEX',

          country: 'US',

          type: 'futures',

          established: '1990-04-03',

          underlying: '天然气',

          contractSize: '10000MMBtu',

          tickSize: '0.001美元/MMBtu',

          description: 'NYMEX天然气期货合约'

        },

        

        // 农产品

        {

          symbol: 'ZC=F',

          name: '玉米期货',

          market: 'CBOT',

          country: 'US',

          type: 'futures',

          established: '1877-10-01',

          underlying: '玉米',

          contractSize: '5000蒲式耳',

          tickSize: '0.25美分/蒲式耳',

          description: 'CBOT玉米期货合约'

        },

        {

          symbol: 'ZS=F',

          name: '大豆期货',

          market: 'CBOT',

          country: 'US',

          type: 'futures',

          established: '1936-10-05',

          underlying: '大豆',

          contractSize: '5000蒲式耳',

          tickSize: '0.25美分/蒲式耳',

          description: 'CBOT大豆期货合约'

        }

      ],



      // 全球外汇

      globalForex: [

        {

          symbol: 'EURUSD=X',

          name: '欧元/美元',

          market: 'FOREX',

          country: 'GLOBAL',

          type: 'forex',

          established: '1999-01-01',

          baseCurrency: 'EUR',

          quoteCurrency: 'USD',

          description: '欧元兑美元汇率'

        },

        {

          symbol: 'GBPUSD=X',

          name: '英镑/美元',

          market: 'FOREX',

          country: 'GLOBAL',

          type: 'forex',

          established: '1971-08-15',

          baseCurrency: 'GBP',

          quoteCurrency: 'USD',

          description: '英镑兑美元汇率'

        },

        {

          symbol: 'USDJPY=X',

          name: '美元/日元',

          market: 'FOREX',

          country: 'GLOBAL',

          type: 'forex',

          established: '1971-08-15',

          baseCurrency: 'USD',

          quoteCurrency: 'JPY',

          description: '美元兑日元汇率'

        },

        {

          symbol: 'USDCNY=X',

          name: '美元/人民币',

          market: 'FOREX',

          country: 'GLOBAL',

          type: 'forex',

          established: '1994-01-01',

          baseCurrency: 'USD',

          quoteCurrency: 'CNY',

          description: '美元兑人民币汇率'

        }

      ],



      // 全球加密货币

      globalCrypto: [

        {

          symbol: 'BTC-USD',

          name: 'Bitcoin',

          market: 'CRYPTO',

          country: 'GLOBAL',

          type: 'cryptocurrency',

          established: '2009-01-03',

          description: '比特币，第一个也是最大的加密货币'

        },

        {

          symbol: 'ETH-USD',

          name: 'Ethereum',

          market: 'CRYPTO',

          country: 'GLOBAL',

          type: 'cryptocurrency',

          established: '2015-07-30',

          description: '以太坊，智能合约平台的原生代币'

        },

        {

          symbol: 'BNB-USD',

          name: 'Binance Coin',

          market: 'CRYPTO',

          country: 'GLOBAL',

          type: 'cryptocurrency',

          established: '2017-07-25',

          description: '币安币，币安交易所的平台代币'

        }

      ]

    };
}

module.exports = {
  createDataSourcesConfig,
  createMarketsConfig,
  createImportantInstrumentsConfig
};
