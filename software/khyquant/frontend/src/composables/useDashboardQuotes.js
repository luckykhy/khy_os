import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'
import { getApiBaseUrl } from '@/config/api'

export function useDashboardQuotes(options = {}) {
  const onSearchSelect = typeof options.onSearchSelect === 'function'
    ? options.onSearchSelect
    : null

  const marketQuotes = ref([])
  const stockList = ref([])
  const indexList = ref([])
  const etfList = ref([])
  const bondList = ref([])
  const futuresList = ref([])
  const currentCategory = ref('favorite')

  const quotesLoading = ref(false)
  const indexLoading = ref(false)
  const stockLoading = ref(false)
  const etfLoading = ref(false)
  const bondLoading = ref(false)

  const currentPage = ref(1)
  const pageSize = ref(20)
  const totalItems = ref(0)
  const favoriteStocks = ref(new Set())

  const showSearchDialog = ref(false)
  const searchKeyword = ref('')
  const searchResults = ref([])
  const searchLoading = ref(false)

  let refreshTimer = null
  let searchTimer = null

  const favoriteQuotesList = computed(() => {
    const allQuotes = [
      ...marketQuotes.value,
      ...stockList.value,
      ...indexList.value,
      ...etfList.value,
      ...bondList.value
    ]

    const uniqueQuotes = Array.from(
      new Map(allQuotes.map((item) => [item.symbol, item])).values()
    )

    return uniqueQuotes.filter((quote) => favoriteStocks.value.has(quote.symbol))
  })

  const displayedQuotes = computed(() => {
    let allData = []

    console.log('🔍 displayedQuotes 计算中...')
    console.log('  - currentCategory:', currentCategory.value)
    console.log('  - stockList.length:', stockList.value.length)
    console.log('  - indexList.length:', indexList.value.length)
    console.log('  - etfList.length:', etfList.value.length)
    console.log('  - bondList.length:', bondList.value.length)
    console.log('  - favoriteQuotesList.length:', favoriteQuotesList.value.length)

    if (currentCategory.value === 'favorite') {
      allData = favoriteQuotesList.value
      console.log('  ✅ 使用 favoriteQuotesList:', allData.length)
    } else if (currentCategory.value === 'all') {
      allData = [...stockList.value, ...indexList.value, ...etfList.value, ...bondList.value, ...futuresList.value]
      console.log('  ✅ 使用 all (合并所有列表):', allData.length)
    } else if (currentCategory.value === 'stock') {
      allData = stockList.value
      console.log('  ✅ 使用 stockList:', allData.length)
    } else if (currentCategory.value === 'index') {
      allData = indexList.value
      console.log('  ✅ 使用 indexList:', allData.length)
    } else if (currentCategory.value === 'etf') {
      allData = etfList.value
      console.log('  ✅ 使用 etfList:', allData.length)
    } else if (currentCategory.value === 'bond') {
      allData = bondList.value
      console.log('  ✅ 使用 bondList:', allData.length)
    } else if (currentCategory.value === 'futures') {
      allData = futuresList.value
      console.log('  ✅ 使用 futuresList:', allData.length)
    }

    totalItems.value = allData.length
    console.log('  - totalItems:', totalItems.value)

    const start = (currentPage.value - 1) * pageSize.value
    const end = start + pageSize.value
    console.log('  - 分页: start=', start, ', end=', end)

    const result = allData.slice(start, end)
    console.log('  ✅ 最终返回:', result.length, '个标的')

    return result
  })

  const loadMarketQuotes = async () => {
    try {
      quotesLoading.value = true

      const symbols = [
        'sh000001', 'sh000300', 'sz399001', 'sz399006',
        'sh600519', 'sz000858', 'sh600036', 'sz000001',
        'sh600000', 'sh601318', 'sz000333', 'sz002594'
      ]

      const promises = symbols.map(async (symbol) => {
        try {
          const endDate = new Date()
          endDate.setDate(endDate.getDate() - 1)
          const startDate = new Date()
          startDate.setDate(startDate.getDate() - 30)

          const response = await fetch(`${getApiBaseUrl()}/comprehensive-data/kline?symbol=${symbol}&startDate=${startDate.toISOString().split('T')[0]}&endDate=${endDate.toISOString().split('T')[0]}&period=daily`)

          if (response.ok) {
            const data = await response.json()
            if (data.kline && data.kline.length > 0) {
              const lastCandle = data.kline[data.kline.length - 1]
              const prevCandle = data.kline.length > 1 ? data.kline[data.kline.length - 2] : lastCandle

              const price = parseFloat(lastCandle.close)
              const prevClose = parseFloat(prevCandle.close)
              const change = price - prevClose
              const changePercent = (change / prevClose) * 100

              return {
                symbol: symbol,
                name: data.name || symbol,
                type: symbol.includes('000') || symbol.includes('399') ? 'index' : 'stock',
                category: symbol.includes('000') || symbol.includes('399') ? '指数' : 'A股',
                price: price,
                open: parseFloat(lastCandle.open),
                high: parseFloat(lastCandle.high),
                low: parseFloat(lastCandle.low),
                volume: parseInt(lastCandle.volume || 0),
                change: change,
                changePercent: changePercent,
                time: lastCandle.time,
                dataSource: data.source
              }
            }
          }
          return null
        } catch (error) {
          console.warn(`获取 ${symbol} 数据失败:`, error.message)
          return null
        }
      })

      const results = await Promise.all(promises)
      const validResults = results.filter((r) => r !== null)

      if (validResults.length > 0) {
        marketQuotes.value = validResults
        console.log(`✅ 使用真实数据源加载行情，共 ${validResults.length} 个标的`)
        console.log(`📊 数据源: ${validResults[0].dataSource}`)
        return
      }

      console.warn('⚠️ 所有API调用失败,使用模拟数据')

      const mockQuotes = [
        { symbol: 'sh000001', name: '上证指数', basePrice: 3100, type: 'index' },
        { symbol: 'sh000300', name: '沪深300', basePrice: 3650, type: 'index' },
        { symbol: 'sz399001', name: '深证成指', basePrice: 10500, type: 'index' },
        { symbol: 'sz399006', name: '创业板指', basePrice: 2100, type: 'index' },
        { symbol: 'sh600519', name: '贵州茅台', basePrice: 1680, type: 'stock' },
        { symbol: 'sz000858', name: '五粮液', basePrice: 158, type: 'stock' },
        { symbol: 'sh600036', name: '招商银行', basePrice: 35, type: 'stock' },
        { symbol: 'sz000001', name: '平安银行', basePrice: 12.8, type: 'stock' },
        { symbol: 'sh600000', name: '浦发银行', basePrice: 8.5, type: 'stock' },
        { symbol: 'sh601318', name: '中国平安', basePrice: 45.6, type: 'stock' },
        { symbol: 'sz000333', name: '美的集团', basePrice: 58.9, type: 'stock' },
        { symbol: 'sz002594', name: '比亚迪', basePrice: 245.8, type: 'stock' }
      ]

      console.log('⚠️ 使用模拟数据')
      marketQuotes.value = mockQuotes.map((item) => {
        const changePercent = (Math.random() - 0.5) * 6
        const price = item.basePrice * (1 + changePercent / 100)
        const change = price - item.basePrice

        return {
          symbol: item.symbol,
          name: item.name,
          type: item.type,
          category: item.type === 'index' ? '指数' : 'A股',
          price: parseFloat(price.toFixed(2)),
          open: parseFloat((item.basePrice * (1 + (Math.random() - 0.5) * 0.02)).toFixed(2)),
          high: parseFloat((price * (1 + Math.random() * 0.02)).toFixed(2)),
          low: parseFloat((price * (1 - Math.random() * 0.02)).toFixed(2)),
          volume: Math.floor(Math.random() * 10000000) + 1000000,
          change: parseFloat(change.toFixed(2)),
          changePercent: parseFloat(changePercent.toFixed(2)),
          time: new Date().toISOString()
        }
      })
    } catch (error) {
      console.error('加载市场行情失败:', error)
    } finally {
      quotesLoading.value = false
    }
  }

  const handlePageChange = (page) => {
    currentPage.value = page
    console.log('📄 切换到第', page, '页')
  }

  const loadDataWithFallback = async (type, mockDataFn) => {
    console.log(`📊 开始加载${type}数据,使用降级策略...`)

    try {
      console.log(`💾 第一级:尝试从数据库获取${type}数据...`)
      const response = await axios.get(`${getApiBaseUrl()}/instruments`, {
        params: {
          type: type,
          limit: 10000
        },
        timeout: 10000
      })

      if (response.data.success && response.data.data && response.data.data.instruments && response.data.data.instruments.length > 0) {
        console.log(`✅ 成功从数据库获取${type}数据:`, response.data.data.instruments.length, '条')

        const dataWithPrices = response.data.data.instruments.map((item) => {
          const basePrice = type === 'etf' ? Math.random() * 3 + 0.5 : Math.random() * 150 + 80
          const changePercent = (Math.random() - 0.5) * 6
          const price = basePrice * (1 + changePercent / 100)

          return {
            symbol: item.symbol,
            name: item.name,
            type: type,
            category: type === 'etf' ? 'ETF' : type === 'bond' ? '可转债' : '未知',
            price: parseFloat(price.toFixed(type === 'etf' ? 3 : 2)),
            open: parseFloat((basePrice * (1 + (Math.random() - 0.5) * 0.02)).toFixed(type === 'etf' ? 3 : 2)),
            high: parseFloat((price * (1 + Math.random() * 0.02)).toFixed(type === 'etf' ? 3 : 2)),
            low: parseFloat((price * (1 - Math.random() * 0.02)).toFixed(type === 'etf' ? 3 : 2)),
            volume: Math.floor(Math.random() * 50000000) + 5000000,
            change: parseFloat((price - basePrice).toFixed(type === 'etf' ? 3 : 2)),
            changePercent: parseFloat(changePercent.toFixed(2)),
            time: new Date().toISOString(),
            dataSource: 'Database'
          }
        })

        return {
          success: true,
          data: dataWithPrices,
          source: 'database',
          message: `数据库 (${dataWithPrices.length}条)`
        }
      }
    } catch (error) {
      console.warn(`⚠️ 数据库获取${type}数据失败:`, error.message)
    }

    console.log(`🎭 第二级:使用模拟${type}数据...`)
    const mockData = mockDataFn()
    console.log(`✅ 生成模拟${type}数据:`, mockData.length, '条')

    return {
      success: true,
      data: mockData,
      source: 'mock',
      message: `模拟数据 (${mockData.length}条)`
    }
  }

  const loadAllCategories = async () => {
    quotesLoading.value = true
    try {
      await Promise.all([
        stockList.value.length === 0 ? loadStockList() : Promise.resolve(),
        indexList.value.length === 0 ? loadIndexList() : Promise.resolve(),
        etfList.value.length === 0 ? loadETFList() : Promise.resolve(),
        bondList.value.length === 0 ? loadBondList() : Promise.resolve(),
        futuresList.value.length === 0 ? loadFuturesList() : Promise.resolve()
      ])
    } finally {
      quotesLoading.value = false
    }
  }

  const loadIndexList = async () => {
    try {
      indexLoading.value = true
      console.log('📊 开始从数据库加载指数列表...')

      try {
        const response = await axios.get(`${getApiBaseUrl()}/instruments`, {
          params: {
            type: 'index',
            limit: 10000
          },
          timeout: 10000
        })

        if (response.data.success && response.data.data && response.data.data.instruments && response.data.data.instruments.length > 0) {
          console.log(`✅ 从数据库获取 ${response.data.data.instruments.length} 个指数`)

          indexList.value = response.data.data.instruments.map((item) => {
            const basePrice = item.symbol === '000300' ? 4660 :
              item.symbol === '000001' ? 3100 :
              item.symbol === '399001' ? 10500 :
              item.symbol === '399006' ? 2100 : 3000
            const changePercent = (Math.random() - 0.5) * 4
            const price = basePrice * (1 + changePercent / 100)

            return {
              symbol: item.symbol,
              name: item.name,
              type: 'index',
              category: '指数',
              price: parseFloat(price.toFixed(2)),
              open: parseFloat((basePrice * (1 + (Math.random() - 0.5) * 0.01)).toFixed(2)),
              high: parseFloat((price * (1 + Math.random() * 0.02)).toFixed(2)),
              low: parseFloat((price * (1 - Math.random() * 0.02)).toFixed(2)),
              volume: Math.floor(Math.random() * 100000000) + 10000000,
              change: parseFloat((price - basePrice).toFixed(2)),
              changePercent: parseFloat(changePercent.toFixed(2)),
              time: new Date().toISOString(),
              dataSource: 'Database'
            }
          })

          ElMessage.success(`已加载 ${indexList.value.length} 个指数 (数据库)`)
          return
        }
      } catch (apiError) {
        console.warn('⚠️ 从数据库加载失败:', apiError.message)
      }

      console.warn('⚠️ 数据库无数据,使用模拟数据')
      const mockData = [
        { symbol: '000300', name: '沪深300', basePrice: 4660 },
        { symbol: '000001', name: '上证指数', basePrice: 3100 },
        { symbol: '399001', name: '深证成指', basePrice: 10500 },
        { symbol: '399006', name: '创业板指', basePrice: 2100 }
      ]

      indexList.value = mockData.map((index) => {
        const changePercent = (Math.random() - 0.5) * 4
        const price = index.basePrice * (1 + changePercent / 100)
        return {
          symbol: index.symbol,
          name: index.name,
          type: 'index',
          category: '指数',
          price: parseFloat(price.toFixed(2)),
          change: parseFloat((price - index.basePrice).toFixed(2)),
          changePercent: parseFloat(changePercent.toFixed(2)),
          volume: Math.floor(Math.random() * 100000000),
          dataSource: 'Mock'
        }
      })

      ElMessage.warning(`已加载 ${indexList.value.length} 个指数 (模拟数据)`)
    } catch (error) {
      console.error('加载指数列表失败:', error)
      ElMessage.error('加载指数列表失败')
    } finally {
      indexLoading.value = false
    }
  }

  const loadStockList = async () => {
    try {
      stockLoading.value = true
      console.log('📊 开始从数据库加载股票列表...')

      try {
        const apiUrl = `${getApiBaseUrl()}/instruments`
        console.log('🔍 API URL:', apiUrl)
        console.log('🔍 请求参数:', { type: 'stock', limit: 10000 })

        const response = await axios.get(apiUrl, {
          params: {
            type: 'stock',
            limit: 10000
          },
          timeout: 10000
        })

        console.log('🔍 API响应:', response.data)

        if (response.data.success && response.data.data && response.data.data.instruments && response.data.data.instruments.length > 0) {
          console.log(`✅ 从数据库获取 ${response.data.data.instruments.length} 个股票`)

          stockList.value = response.data.data.instruments.map((item) => {
            const basePrice = Math.random() * 200 + 10
            const changePercent = (Math.random() - 0.5) * 10
            const price = basePrice * (1 + changePercent / 100)

            return {
              symbol: item.symbol,
              name: item.name,
              type: 'stock',
              category: 'A股',
              price: parseFloat(price.toFixed(2)),
              open: parseFloat((basePrice * (1 + (Math.random() - 0.5) * 0.02)).toFixed(2)),
              high: parseFloat((price * (1 + Math.random() * 0.02)).toFixed(2)),
              low: parseFloat((price * (1 - Math.random() * 0.02)).toFixed(2)),
              volume: Math.floor(Math.random() * 10000000) + 1000000,
              change: parseFloat((price - basePrice).toFixed(2)),
              changePercent: parseFloat(changePercent.toFixed(2)),
              time: new Date().toISOString(),
              dataSource: 'Database'
            }
          })

          ElMessage.success(`已加载 ${stockList.value.length} 个股票 (数据库)`)
          return
        }
      } catch (apiError) {
        console.warn('⚠️ 从数据库加载失败:', apiError.message)
      }

      console.warn('⚠️ 数据库无数据,使用模拟数据')
      const mockData = [
        { symbol: '600519', name: '贵州茅台', basePrice: 1680.0 },
        { symbol: '600036', name: '招商银行', basePrice: 35.2 },
        { symbol: '000858', name: '五粮液', basePrice: 158.5 },
        { symbol: '000333', name: '美的集团', basePrice: 58.9 }
      ]

      stockList.value = mockData.map((stock) => {
        const changePercent = (Math.random() - 0.5) * 10
        const price = stock.basePrice * (1 + changePercent / 100)
        return {
          symbol: stock.symbol,
          name: stock.name,
          type: 'stock',
          category: 'A股',
          price: parseFloat(price.toFixed(2)),
          change: parseFloat((price - stock.basePrice).toFixed(2)),
          changePercent: parseFloat(changePercent.toFixed(2)),
          volume: Math.floor(Math.random() * 10000000),
          dataSource: 'Mock'
        }
      })

      ElMessage.warning(`已加载 ${stockList.value.length} 个股票 (模拟数据)`)
    } catch (error) {
      console.error('加载股票列表失败:', error)
      ElMessage.error('加载股票列表失败')
    } finally {
      stockLoading.value = false
    }
  }

  const loadETFList = async () => {
    try {
      etfLoading.value = true
      console.log('📊 开始加载ETF列表...')

      const generateMockETFData = () => {
        const etfSymbols = [
          { symbol: '510300', name: '沪深300ETF', basePrice: 4.72 },
          { symbol: '510500', name: '中证500ETF', basePrice: 6.85 },
          { symbol: '159915', name: '创业板ETF', basePrice: 2.15 },
          { symbol: '512880', name: '证券ETF', basePrice: 0.85 },
          { symbol: '515050', name: '5GETF', basePrice: 1.25 },
          { symbol: '512690', name: '酒ETF', basePrice: 1.18 },
          { symbol: '512660', name: '军工ETF', basePrice: 1.05 },
          { symbol: '512480', name: '半导体ETF', basePrice: 1.35 },
          { symbol: '159928', name: '消费ETF', basePrice: 2.85 },
          { symbol: '512010', name: '医药ETF', basePrice: 1.65 },
          { symbol: '515030', name: '新能源车ETF', basePrice: 0.95 },
          { symbol: '516160', name: '新能源ETF', basePrice: 0.88 },
          { symbol: '159949', name: '创业板50', basePrice: 1.45 },
          { symbol: '510050', name: '上证50ETF', basePrice: 2.68 },
          { symbol: '588000', name: '科创50ETF', basePrice: 0.98 }
        ]

        return etfSymbols.map((etf) => {
          const changePercent = (Math.random() - 0.5) * 6
          const price = etf.basePrice * (1 + changePercent / 100)
          const change = price - etf.basePrice

          return {
            symbol: etf.symbol,
            name: etf.name,
            type: 'etf',
            category: 'ETF',
            price: parseFloat(price.toFixed(3)),
            open: parseFloat((etf.basePrice * (1 + (Math.random() - 0.5) * 0.02)).toFixed(3)),
            high: parseFloat((price * (1 + Math.random() * 0.02)).toFixed(3)),
            low: parseFloat((price * (1 - Math.random() * 0.02)).toFixed(3)),
            volume: Math.floor(Math.random() * 50000000) + 5000000,
            change: parseFloat(change.toFixed(3)),
            changePercent: parseFloat(changePercent.toFixed(2)),
            time: new Date().toISOString(),
            dataSource: 'Mock'
          }
        })
      }

      const result = await loadDataWithFallback('etf', generateMockETFData)
      etfList.value = result.data
      console.log(`✅ 成功加载 ${etfList.value.length} 个ETF [${result.source}]`)
      ElMessage.success(`已加载 ${etfList.value.length} 个ETF (${result.message})`)
    } catch (error) {
      console.error('加载ETF列表失败:', error)
      ElMessage.error('加载ETF列表失败')
    } finally {
      etfLoading.value = false
    }
  }

  const loadBondList = async () => {
    try {
      bondLoading.value = true
      console.log('📊 开始加载可转债列表...')

      const generateMockBondData = () => {
        const bondSymbols = [
          { symbol: '113700', name: '海天转债', basePrice: 125.50 },
          { symbol: '118065', name: '艾为转债', basePrice: 118.80 },
          { symbol: '110100', name: '龙建转债', basePrice: 102.30 },
          { symbol: '127112', name: '尚太转债', basePrice: 115.60 },
          { symbol: '123265', name: '耐普转02', basePrice: 108.90 },
          { symbol: '128136', name: '立讯转债', basePrice: 132.50 },
          { symbol: '113050', name: '南银转债', basePrice: 110.20 },
          { symbol: '110061', name: '川投转债', basePrice: 105.80 },
          { symbol: '113616', name: '韦尔转债', basePrice: 128.30 },
          { symbol: '123107', name: '温氏转债', basePrice: 98.50 },
          { symbol: '127018', name: '本钢转债', basePrice: 112.60 },
          { symbol: '113044', name: '大秦转债', basePrice: 119.80 },
          { symbol: '110059', name: '浦发转债', basePrice: 106.50 },
          { symbol: '113021', name: '中信转债', basePrice: 114.20 },
          { symbol: '110053', name: '苏银转债', basePrice: 103.90 }
        ]

        return bondSymbols.map((bond) => {
          const changePercent = (Math.random() - 0.5) * 4
          const price = bond.basePrice * (1 + changePercent / 100)
          const change = price - bond.basePrice

          return {
            symbol: bond.symbol,
            name: bond.name,
            type: 'bond',
            category: '可转债',
            price: parseFloat(price.toFixed(2)),
            open: parseFloat((bond.basePrice * (1 + (Math.random() - 0.5) * 0.01)).toFixed(2)),
            high: parseFloat((price * (1 + Math.random() * 0.015)).toFixed(2)),
            low: parseFloat((price * (1 - Math.random() * 0.015)).toFixed(2)),
            volume: Math.floor(Math.random() * 5000000) + 500000,
            change: parseFloat(change.toFixed(2)),
            changePercent: parseFloat(changePercent.toFixed(2)),
            time: new Date().toISOString(),
            dataSource: 'Mock'
          }
        })
      }

      const result = await loadDataWithFallback('bond', generateMockBondData)

      bondList.value = result.data
      console.log(`✅ 成功加载 ${bondList.value.length} 个可转债 [${result.source}]`)
      ElMessage.success(`已加载 ${bondList.value.length} 个可转债 (${result.message})`)
    } catch (error) {
      console.error('加载可转债列表失败:', error)
      ElMessage.error('加载可转债列表失败')
    } finally {
      bondLoading.value = false
    }
  }

  const loadFuturesList = async () => {
    const commonFutures = [
      { symbol: 'rb_main', name: '螺纹钢主力', basePrice: 3380 },
      { symbol: 'hc_main', name: '热卷主力', basePrice: 3520 },
      { symbol: 'i_main', name: '铁矿石主力', basePrice: 780 },
      { symbol: 'j_main', name: '焦炭主力', basePrice: 2150 },
      { symbol: 'jm_main', name: '焦煤主力', basePrice: 1580 },
      { symbol: 'cu_main', name: '沪铜主力', basePrice: 69500 },
      { symbol: 'al_main', name: '沪铝主力', basePrice: 19800 },
      { symbol: 'zn_main', name: '沪锌主力', basePrice: 22500 },
      { symbol: 'au_main', name: '沪金主力', basePrice: 580 },
      { symbol: 'ag_main', name: '沪银主力', basePrice: 7200 },
      { symbol: 'IF_main', name: '沪深300股指', basePrice: 4660 },
      { symbol: 'IC_main', name: '中证500股指', basePrice: 6200 },
      { symbol: 'IH_main', name: '上证50股指', basePrice: 2750 },
      { symbol: 'IM_main', name: '中证1000股指', basePrice: 6800 },
      { symbol: 'sc_main', name: '原油主力', basePrice: 560 },
      { symbol: 'fu_main', name: '燃油主力', basePrice: 3100 },
      { symbol: 'MA_main', name: '甲醇主力', basePrice: 2650 },
      { symbol: 'TA_main', name: 'PTA主力', basePrice: 5800 },
      { symbol: 'SR_main', name: '白糖主力', basePrice: 6500 },
      { symbol: 'CF_main', name: '棉花主力', basePrice: 14500 },
      { symbol: 'a_main', name: '豆一主力', basePrice: 4800 },
      { symbol: 'm_main', name: '豆粕主力', basePrice: 3200 },
      { symbol: 'p_main', name: '棕榈油主力', basePrice: 7600 },
      { symbol: 'y_main', name: '豆油主力', basePrice: 7800 }
    ]

    futuresList.value = commonFutures.map((item) => {
      const change = (Math.random() - 0.5) * (item.basePrice * 0.03)
      const price = item.basePrice + change
      return {
        symbol: item.symbol,
        name: item.name,
        price: parseFloat(price.toFixed(2)),
        change: parseFloat(change.toFixed(2)),
        changePercent: parseFloat((change / item.basePrice * 100).toFixed(2)),
        volume: Math.floor(Math.random() * 500000) + 50000,
        category: '期货',
        type: 'futures',
        isDemo: true
      }
    })
    console.log(`✅ 已加载 ${futuresList.value.length} 个期货合约`)
  }

  const switchCategory = async (category) => {
    console.log('🔍 切换分类:', category)
    currentCategory.value = category
    currentPage.value = 1

    if (category === 'favorite') {
      console.log(`📊 显示自选标的: ${favoriteQuotesList.value.length} 个`)
      if (favoriteStocks.value.size > 0) {
        await loadFavoriteQuotesData()
      }
    } else if (category === 'all') {
      console.log('📊 加载所有分类数据...')
      await loadAllCategories()
    } else if (category === 'stock') {
      console.log('📊 加载股票数据...')
      await loadStockList()
      console.log(`✅ 股票数据加载完成: ${stockList.value.length} 个`)
      console.log(`📊 displayedQuotes 应该显示: ${displayedQuotes.value.length} 个`)
    } else if (category === 'index') {
      console.log('📊 加载指数数据...')
      await loadIndexList()
    } else if (category === 'etf') {
      console.log('📊 加载ETF数据...')
      await loadETFList()
    } else if (category === 'bond') {
      console.log('📊 加载可转债数据...')
      await loadBondList()
    } else if (category === 'futures') {
      console.log('📊 加载期货数据...')
      await loadFuturesList()
    }
  }

  const saveFavoriteStocks = async () => {
    const favorites = Array.from(favoriteStocks.value)

    localStorage.setItem('favoriteStocks', JSON.stringify(favorites))

    if (favorites.length === 0) {
      console.log('⚠️ 没有自选标的,跳过保存')
      return
    }

    try {
      const token = localStorage.getItem('token')
      if (!token) {
        console.warn('未登录,只保存到localStorage')
        return
      }

      const allQuotes = [
        ...marketQuotes.value,
        ...stockList.value,
        ...indexList.value,
        ...etfList.value,
        ...bondList.value
      ]

      if (allQuotes.length === 0) {
        console.warn('⚠️ 标的列表还未加载,延迟保存到数据库')
        setTimeout(() => saveFavoriteStocks(), 1000)
        return
      }

      const favoritesData = favorites.map((symbol) => {
        const quote = allQuotes.find((q) => q.symbol === symbol)
        return {
          symbol: symbol,
          name: quote?.name || symbol,
          type: quote?.type || 'stock'
        }
      })

      if (favoritesData.length === 0) {
        console.warn('⚠️ 无法找到标的信息,只保存到localStorage')
        return
      }

      console.log('📤 准备发送到后端的数据:', {
        favorites: favoritesData,
        count: favoritesData.length
      })

      const response = await axios.post('/api/favorites/batch', {
        favorites: favoritesData
      }, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (response.data.success) {
        console.log('✅ 自选标的已保存到数据库:', response.data)
      }
    } catch (error) {
      console.error('保存自选标的到数据库失败:', error)
      console.error('错误详情:', error.response?.data)
      console.error('请求配置:', error.config)
    }
  }

  const toggleFavorite = async (symbol, event) => {
    if (event && typeof event.stopPropagation === 'function') {
      event.stopPropagation()
    }

    const isFav = favoriteStocks.value.has(symbol)

    if (isFav) {
      favoriteStocks.value.delete(symbol)
      ElMessage.success('已取消自选')
    } else {
      favoriteStocks.value.add(symbol)
      ElMessage.success('已加入自选标的')
    }

    await saveFavoriteStocks()
  }

  const isFavorite = (symbol) => favoriteStocks.value.has(symbol)

  const loadFavoriteStocks = async () => {
    try {
      const token = localStorage.getItem('token')

      if (token) {
        try {
          const response = await axios.get('/api/favorites', {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          })

          if (response.data.success && response.data.data) {
            const favorites = response.data.data.map((f) => f.symbol)
            favoriteStocks.value = new Set(favorites)
            console.log(`✅ 从数据库加载 ${favorites.length} 个自选标的`)

            localStorage.setItem('favoriteStocks', JSON.stringify(favorites))
            return
          }
        } catch (dbError) {
          console.warn('从数据库加载自选标的失败:', dbError.message)
        }
      }

      const saved = localStorage.getItem('favoriteStocks')
      if (saved) {
        const favorites = JSON.parse(saved)
        favoriteStocks.value = new Set(favorites)
        console.log(`⚠️ 从localStorage加载 ${favorites.length} 个自选标的`)
      }
    } catch (error) {
      console.error('加载自选标的失败:', error)
    }
  }

  const loadFavoriteQuotesData = async () => {
    if (favoriteStocks.value.size === 0) {
      console.log('⚠️ 没有自选标的,跳过加载行情')
      return
    }

    console.log(`📊 开始加载 ${favoriteStocks.value.size} 个自选标的的行情数据...`)
    quotesLoading.value = true

    try {
      const favoriteSymbols = Array.from(favoriteStocks.value)
      const promises = favoriteSymbols.map(async (symbol) => {
        const fullSymbol = symbol.match(/^(sh|sz)/) ? symbol
          : (symbol.startsWith('6') ? `sh${symbol}` : `sz${symbol}`)

        try {
          const endDate = new Date()
          endDate.setDate(endDate.getDate() - 1)
          const startDate = new Date()
          startDate.setDate(startDate.getDate() - 30)

          const response = await fetch(
            `${getApiBaseUrl()}/comprehensive-data/kline?symbol=${fullSymbol}&startDate=${startDate.toISOString().split('T')[0]}&endDate=${endDate.toISOString().split('T')[0]}&period=daily`,
            { timeout: 3000 }
          )

          if (response.ok) {
            const data = await response.json()
            if (data.kline && data.kline.length > 0) {
              const lastCandle = data.kline[data.kline.length - 1]
              const prevCandle = data.kline.length > 1 ? data.kline[data.kline.length - 2] : lastCandle

              const price = parseFloat(lastCandle.close)
              const prevClose = parseFloat(prevCandle.close)
              const change = price - prevClose
              const changePercent = (change / prevClose) * 100

              return {
                symbol: fullSymbol,
                name: data.name || symbol,
                type: fullSymbol.includes('000') || fullSymbol.includes('399') ? 'index' : 'stock',
                category: fullSymbol.includes('000') || fullSymbol.includes('399') ? '指数' : 'A股',
                price: price,
                open: parseFloat(lastCandle.open),
                high: parseFloat(lastCandle.high),
                low: parseFloat(lastCandle.low),
                volume: parseInt(lastCandle.volume || 0),
                change: change,
                changePercent: changePercent,
                time: lastCandle.time,
                dataSource: data.source || 'AData'
              }
            }
          }
        } catch (error) {
          console.warn(`获取 ${fullSymbol} 真实数据失败:`, error.message)
        }

        console.log(`⚠️ ${fullSymbol} 使用模拟数据`)
        const dashPriceMap = {
          'sh000300': 4660, '000300': 4660, 'sh000001': 3350, '000001': 3350,
          'sz399001': 10800, '399001': 10800, 'sz399006': 2100, '399006': 2100,
          'sh600519': 1680, '600519': 1680, 'sh600036': 38, '600036': 38,
          'sz000001': 11, 'sz000858': 148, 'sh600000': 7.8, 'sh601318': 52,
          'sz002594': 280, 'sz000002': 8.5,
          'rb_main': 3380, 'rb2510': 3380
        }
        const cleanSym = fullSymbol.replace(/^(sh|sz)/i, '')
        const basePrice = dashPriceMap[fullSymbol] || dashPriceMap[cleanSym] || 50
        const changePercent = (Math.random() - 0.5) * 4
        const price = basePrice * (1 + changePercent / 100)
        const change = price - basePrice

        return {
          symbol: fullSymbol,
          name: symbol,
          type: fullSymbol.includes('000') || fullSymbol.includes('399') ? 'index' : 'stock',
          category: fullSymbol.includes('000') || fullSymbol.includes('399') ? '指数' : 'A股',
          price: parseFloat(price.toFixed(2)),
          open: parseFloat((basePrice * (1 + (Math.random() - 0.5) * 0.02)).toFixed(2)),
          high: parseFloat((price * (1 + Math.random() * 0.02)).toFixed(2)),
          low: parseFloat((price * (1 - Math.random() * 0.02)).toFixed(2)),
          volume: Math.floor(Math.random() * 10000000) + 1000000,
          change: parseFloat(change.toFixed(2)),
          changePercent: parseFloat(changePercent.toFixed(2)),
          time: new Date().toISOString(),
          dataSource: '增强模拟数据'
        }
      })

      const results = await Promise.all(promises)
      const validResults = results.filter((r) => r !== null)

      marketQuotes.value = validResults

      validResults.forEach((quote) => {
        if (quote.type === 'index') {
          const existingIndex = indexList.value.findIndex((i) => i.symbol === quote.symbol)
          if (existingIndex >= 0) {
            indexList.value[existingIndex] = quote
          } else {
            indexList.value.push(quote)
          }
        } else if (quote.type === 'stock') {
          const existingStock = stockList.value.findIndex((s) => s.symbol === quote.symbol)
          if (existingStock >= 0) {
            stockList.value[existingStock] = quote
          } else {
            stockList.value.push(quote)
          }
        }
      })

      console.log(`✅ 成功加载 ${validResults.length} 个自选标的行情`)
      const realDataCount = validResults.filter((r) => r.dataSource !== '增强模拟数据' && r.dataSource !== '模拟数据' && r.dataSource !== 'Mock').length
      const mockDataCount = validResults.filter((r) => r.dataSource === '增强模拟数据' || r.dataSource === '模拟数据' || r.dataSource === 'Mock').length
      console.log(`📊 数据来源: 真实数据 ${realDataCount} 个, 增强模拟数据 ${mockDataCount} 个`)
    } catch (error) {
      console.error('加载自选标的行情失败:', error)
      ElMessage.error('加载自选标的行情失败')
    } finally {
      quotesLoading.value = false
    }
  }

  const performSearch = () => {
    searchLoading.value = true

    try {
      const keyword = searchKeyword.value.trim().toLowerCase()
      const allInstruments = [
        ...marketQuotes.value,
        ...stockList.value,
        ...indexList.value,
        ...etfList.value,
        ...bondList.value
      ]

      const uniqueInstruments = Array.from(
        new Map(allInstruments.map((item) => [item.symbol, item])).values()
      )

      searchResults.value = uniqueInstruments.filter((item) => {
        const name = item.name || ''
        const symbol = item.symbol || ''
        const nameMatch = name.toLowerCase().includes(keyword)
        const symbolMatch = symbol.toLowerCase().includes(keyword)
        const codeMatch = symbol.replace(/[a-z]/gi, '').includes(keyword)

        return nameMatch || symbolMatch || codeMatch
      }).slice(0, 20)

      console.log(`🔍 搜索 "${keyword}" 找到 ${searchResults.value.length} 个结果`)
    } catch (error) {
      console.error('搜索失败:', error)
      ElMessage.error('搜索失败')
    } finally {
      searchLoading.value = false
    }
  }

  const handleSearch = () => {
    if (searchTimer) {
      clearTimeout(searchTimer)
    }

    if (!searchKeyword.value.trim()) {
      searchResults.value = []
      return
    }

    searchTimer = setTimeout(() => {
      performSearch()
    }, 500)
  }

  const handleSelectSearchResult = (item) => {
    console.log('选择搜索结果:', item)

    showSearchDialog.value = false
    if (onSearchSelect) {
      onSearchSelect(item)
    }

    searchKeyword.value = ''
    searchResults.value = []
  }

  const startAutoRefresh = () => {
    refreshTimer = setInterval(() => {
      loadMarketQuotes()
    }, 30000)
  }

  const stopAutoRefresh = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  const cleanupQuotes = () => {
    stopAutoRefresh()
    if (searchTimer) {
      clearTimeout(searchTimer)
      searchTimer = null
    }
  }

  const getCategoryName = (category) => {
    const names = {
      'favorite': '自选标的',
      'all': '所有标的',
      'stock': 'A股市场',
      'index': '指数市场',
      'etf': 'ETF基金',
      'bond': '可转债',
      'futures': '期货市场'
    }
    return names[category] || '未知分类'
  }

  const getDataSourceType = (source) => {
    if (!source) return 'info'
    const sourceLower = source.toLowerCase()
    if (sourceLower.includes('adata') || sourceLower.includes('akshare') || sourceLower.includes('database')) {
      return 'success'
    }
    if (sourceLower.includes('模拟') || sourceLower.includes('mock')) {
      return 'warning'
    }
    return 'info'
  }

  return {
    marketQuotes,
    stockList,
    indexList,
    etfList,
    bondList,
    futuresList,
    currentCategory,
    quotesLoading,
    indexLoading,
    stockLoading,
    etfLoading,
    bondLoading,
    currentPage,
    pageSize,
    totalItems,
    favoriteStocks,
    showSearchDialog,
    searchKeyword,
    searchResults,
    searchLoading,
    displayedQuotes,
    favoriteQuotesList,
    loadMarketQuotes,
    switchCategory,
    handlePageChange,
    loadAllCategories,
    loadIndexList,
    loadStockList,
    loadETFList,
    loadBondList,
    loadFuturesList,
    toggleFavorite,
    isFavorite,
    saveFavoriteStocks,
    loadFavoriteStocks,
    loadFavoriteQuotesData,
    handleSearch,
    performSearch,
    handleSelectSearchResult,
    startAutoRefresh,
    stopAutoRefresh,
    cleanupQuotes,
    getCategoryName,
    getDataSourceType
  }
}
