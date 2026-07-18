/**
 * 全面的金融工具数据库
 * 包括股票、指数、期货等各类交易品种
 * @pattern Command
 */

// 完整的金融工具列表
const COMPREHENSIVE_INSTRUMENTS = {
  
  // ==================== 股票 ====================
  stocks: [
    // === 银行业 ===
    { code: 'sh600000', name: '浦发银行', basePrice: 8.5, sector: '银行', market: '上海主板', type: 'stock' },
    { code: 'sh600036', name: '招商银行', basePrice: 35, sector: '银行', market: '上海主板', type: 'stock' },
    { code: 'sh601166', name: '兴业银行', basePrice: 18, sector: '银行', market: '上海主板', type: 'stock' },
    { code: 'sh601398', name: '工商银行', basePrice: 5.2, sector: '银行', market: '上海主板', type: 'stock' },
    { code: 'sh601939', name: '建设银行', basePrice: 6.8, sector: '银行', market: '上海主板', type: 'stock' },
    { code: 'sh601988', name: '中国银行', basePrice: 3.6, sector: '银行', market: '上海主板', type: 'stock' },
    { code: 'sh601328', name: '交通银行', basePrice: 4.8, sector: '银行', market: '上海主板', type: 'stock' },
    { code: 'sz000001', name: '平安银行', basePrice: 12, sector: '银行', market: '深圳主板', type: 'stock' },
    { code: 'sz002142', name: '宁波银行', basePrice: 35, sector: '银行', market: '深圳主板', type: 'stock' },
    { code: 'sh600015', name: '华夏银行', basePrice: 6.5, sector: '银行', market: '上海主板', type: 'stock' },
    { code: 'sh600016', name: '民生银行', basePrice: 4.2, sector: '银行', market: '上海主板', type: 'stock' },
    
    // === 白酒食品 ===
    { code: 'sh600519', name: '贵州茅台', basePrice: 1800, sector: '白酒', market: '上海主板', type: 'stock' },
    { code: 'sz000858', name: '五粮液', basePrice: 150, sector: '白酒', market: '深圳主板', type: 'stock' },
    { code: 'sz000568', name: '泸州老窖', basePrice: 180, sector: '白酒', market: '深圳主板', type: 'stock' },
    { code: 'sh600809', name: '山西汾酒', basePrice: 200, sector: '白酒', market: '上海主板', type: 'stock' },
    { code: 'sz000596', name: '古井贡酒', basePrice: 120, sector: '白酒', market: '深圳主板', type: 'stock' },
    { code: 'sh600779', name: '水井坊', basePrice: 80, sector: '白酒', market: '上海主板', type: 'stock' },
    { code: 'sh600887', name: '伊利股份', basePrice: 30, sector: '食品', market: '上海主板', type: 'stock' },
    { code: 'sz000876', name: '新希望', basePrice: 15, sector: '食品', market: '深圳主板', type: 'stock' },
    { code: 'sz002714', name: '牧原股份', basePrice: 45, sector: '农业', market: '深圳主板', type: 'stock' },
    
    // === 科技互联网 ===
    { code: 'sz002415', name: '海康威视', basePrice: 35, sector: '安防', market: '深圳主板', type: 'stock' },
    { code: 'sz300059', name: '东方财富', basePrice: 18, sector: '金融科技', market: '创业板', type: 'stock' },
    { code: 'sz300142', name: '沃森生物', basePrice: 35, sector: '生物医药', market: '创业板', type: 'stock' },
    { code: 'sh688111', name: '金山办公', basePrice: 280, sector: '软件', market: '科创板', type: 'stock' },
    { code: 'sh688981', name: '中芯国际', basePrice: 45, sector: '半导体', market: '科创板', type: 'stock' },
    { code: 'sh688599', name: '天合光能', basePrice: 35, sector: '光伏', market: '科创板', type: 'stock' },
    { code: 'sz000063', name: '中兴通讯', basePrice: 28, sector: '通信设备', market: '深圳主板', type: 'stock' },
    { code: 'sz002230', name: '科大讯飞', basePrice: 45, sector: 'AI', market: '深圳主板', type: 'stock' },
    { code: 'sz300496', name: '中科创达', basePrice: 85, sector: '软件', market: '创业板', type: 'stock' },
    
    // === 新能源汽车 ===
    { code: 'sz002594', name: '比亚迪', basePrice: 250, sector: '新能源汽车', market: '深圳主板', type: 'stock' },
    { code: 'sz300750', name: '宁德时代', basePrice: 180, sector: '电池', market: '创业板', type: 'stock' },
    { code: 'sh600104', name: '上汽集团', basePrice: 15, sector: '汽车', market: '上海主板', type: 'stock' },
    { code: 'sz000625', name: '长安汽车', basePrice: 12, sector: '汽车', market: '深圳主板', type: 'stock' },
    { code: 'sz002460', name: '赣锋锂业', basePrice: 45, sector: '锂电池', market: '深圳主板', type: 'stock' },
    { code: 'sh688005', name: '容百科技', basePrice: 35, sector: '电池材料', market: '科创板', type: 'stock' },
    
    // === 医药医疗 ===
    { code: 'sh600276', name: '恒瑞医药', basePrice: 45, sector: '医药', market: '上海主板', type: 'stock' },
    { code: 'sz300015', name: '爱尔眼科', basePrice: 25, sector: '医疗服务', market: '创业板', type: 'stock' },
    { code: 'sz000661', name: '长春高新', basePrice: 150, sector: '生物医药', market: '深圳主板', type: 'stock' },
    { code: 'sh600085', name: '同仁堂', basePrice: 35, sector: '中药', market: '上海主板', type: 'stock' },
    { code: 'sz300760', name: '迈瑞医疗', basePrice: 280, sector: '医疗器械', market: '创业板', type: 'stock' },
    { code: 'sh688180', name: '君实生物', basePrice: 45, sector: '生物制药', market: '科创板', type: 'stock' },
    
    // === 保险 ===
    { code: 'sh601318', name: '中国平安', basePrice: 50, sector: '保险', market: '上海主板', type: 'stock' },
    { code: 'sh601601', name: '中国太保', basePrice: 28, sector: '保险', market: '上海主板', type: 'stock' },
    { code: 'sh601319', name: '中国人保', basePrice: 4.5, sector: '保险', market: '上海主板', type: 'stock' },
    { code: 'sh601336', name: '新华保险', basePrice: 35, sector: '保险', market: '上海主板', type: 'stock' },
    
    // === 房地产 ===
    { code: 'sz000002', name: '万科A', basePrice: 18, sector: '房地产', market: '深圳主板', type: 'stock' },
    { code: 'sh600048', name: '保利发展', basePrice: 12, sector: '房地产', market: '上海主板', type: 'stock' },
    { code: 'sz000069', name: '华侨城A', basePrice: 6.5, sector: '房地产', market: '深圳主板', type: 'stock' },
    { code: 'sh600340', name: '华夏幸福', basePrice: 8.2, sector: '房地产', market: '上海主板', type: 'stock' },
    
    // === 基建材料 ===
    { code: 'sh600585', name: '海螺水泥', basePrice: 35, sector: '建材', market: '上海主板', type: 'stock' },
    { code: 'sz000895', name: '双汇发展', basePrice: 28, sector: '食品', market: '深圳主板', type: 'stock' },
    { code: 'sh600031', name: '三一重工', basePrice: 18, sector: '机械', market: '上海主板', type: 'stock' },
    { code: 'sz000425', name: '徐工机械', basePrice: 6.8, sector: '机械', market: '深圳主板', type: 'stock' },
    
    // === 消费电子 ===
    { code: 'sz002475', name: '立讯精密', basePrice: 35, sector: '电子', market: '深圳主板', type: 'stock' },
    { code: 'sz000725', name: '京东方A', basePrice: 4.2, sector: '显示面板', market: '深圳主板', type: 'stock' },
    { code: 'sz002241', name: '歌尔股份', basePrice: 25, sector: '电子', market: '深圳主板', type: 'stock' },
    { code: 'sz000100', name: 'TCL科技', basePrice: 4.5, sector: '显示面板', market: '深圳主板', type: 'stock' },
    
    // === 能源化工 ===
    { code: 'sh600028', name: '中国石化', basePrice: 5.5, sector: '石化', market: '上海主板', type: 'stock' },
    { code: 'sh601857', name: '中国石油', basePrice: 6.2, sector: '石油', market: '上海主板', type: 'stock' },
    { code: 'sh600309', name: '万华化学', basePrice: 85, sector: '化工', market: '上海主板', type: 'stock' },
    { code: 'sh601088', name: '中国神华', basePrice: 25, sector: '煤炭', market: '上海主板', type: 'stock' },
    
    // === 钢铁有色 ===
    { code: 'sh600019', name: '宝钢股份', basePrice: 6.8, sector: '钢铁', market: '上海主板', type: 'stock' },
    { code: 'sz000630', name: '铜陵有色', basePrice: 3.2, sector: '有色金属', market: '深圳主板', type: 'stock' },
    { code: 'sh600362', name: '江西铜业', basePrice: 18, sector: '有色金属', market: '上海主板', type: 'stock' },
    { code: 'sh601899', name: '紫金矿业', basePrice: 12, sector: '有色金属', market: '上海主板', type: 'stock' },
    
    // === 航空航天 ===
    { code: 'sh600115', name: '东方航空', basePrice: 4.8, sector: '航空', market: '上海主板', type: 'stock' },
    { code: 'sh600029', name: '南方航空', basePrice: 6.5, sector: '航空', market: '上海主板', type: 'stock' },
    { code: 'sh601111', name: '中国国航', basePrice: 8.2, sector: '航空', market: '上海主板', type: 'stock' },
    { code: 'sh600009', name: '上海机场', basePrice: 45, sector: '机场', market: '上海主板', type: 'stock' },
    
    // === 电力公用 ===
    { code: 'sh600886', name: '国投电力', basePrice: 12, sector: '电力', market: '上海主板', type: 'stock' },
    { code: 'sh600795', name: '国电电力', basePrice: 3.8, sector: '电力', market: '上海主板', type: 'stock' },
    { code: 'sz000027', name: '深圳能源', basePrice: 6.5, sector: '电力', market: '深圳主板', type: 'stock' },
    { code: 'sh600900', name: '长江电力', basePrice: 22, sector: '水电', market: '上海主板', type: 'stock' },
    
    // === 通信 ===
    { code: 'sh600050', name: '中国联通', basePrice: 4.2, sector: '通信', market: '上海主板', type: 'stock' },
    { code: 'sh600941', name: '中国移动', basePrice: 65, sector: '通信', market: '上海主板', type: 'stock' },
    { code: 'sh600745', name: '中茵股份', basePrice: 8.5, sector: '通信', market: '上海主板', type: 'stock' },
    { code: 'sh600776', name: '东方通信', basePrice: 15, sector: '通信设备', market: '上海主板', type: 'stock' }
  ],

  // ==================== 指数 ====================
  indices: [
    // === 主要指数 ===
    { code: 'sh000001', name: '上证指数', basePrice: 3200, sector: '综合指数', market: '上海', type: 'index' },
    { code: 'sz399001', name: '深证成指', basePrice: 12000, sector: '综合指数', market: '深圳', type: 'index' },
    { code: 'sz399006', name: '创业板指', basePrice: 2800, sector: '创业板指数', market: '深圳', type: 'index' },
    { code: 'sh000300', name: '沪深300', basePrice: 4200, sector: '大盘指数', market: '沪深', type: 'index' },
    { code: 'sh000016', name: '上证50', basePrice: 2800, sector: '大盘指数', market: '上海', type: 'index' },
    { code: 'sz399905', name: '中证500', basePrice: 6500, sector: '中盘指数', market: '沪深', type: 'index' },
    { code: 'sz399102', name: '创业板综', basePrice: 3200, sector: '创业板指数', market: '深圳', type: 'index' },
    { code: 'sh000688', name: '科创50', basePrice: 1200, sector: '科创板指数', market: '上海', type: 'index' },
    
    // === 行业指数 ===
    { code: 'sh000037', name: '上证医药', basePrice: 8500, sector: '医药指数', market: '上海', type: 'index' },
    { code: 'sh000036', name: '上证消费', basePrice: 12000, sector: '消费指数', market: '上海', type: 'index' },
    { code: 'sh000038', name: '上证信息', basePrice: 4500, sector: '科技指数', market: '上海', type: 'index' },
    { code: 'sh000039', name: '上证金融', basePrice: 4200, sector: '金融指数', market: '上海', type: 'index' },
    { code: 'sz399975', name: '证券公司', basePrice: 4800, sector: '券商指数', market: '深圳', type: 'index' },
    { code: 'sz399441', name: '生物医药', basePrice: 6200, sector: '医药指数', market: '深圳', type: 'index' },
    { code: 'sz399006', name: '新能源车', basePrice: 8500, sector: '新能源指数', market: '深圳', type: 'index' },
    { code: 'sz399808', name: '中证新能', basePrice: 3200, sector: '新能源指数', market: '深圳', type: 'index' },
    
    // === 主题指数 ===
    { code: 'sz399550', name: '央视50', basePrice: 4500, sector: '主题指数', market: '深圳', type: 'index' },
    { code: 'sz399324', name: '深证红利', basePrice: 3800, sector: '红利指数', market: '深圳', type: 'index' },
    { code: 'sh000015', name: '红利指数', basePrice: 4200, sector: '红利指数', market: '上海', type: 'index' },
    { code: 'sz399997', name: '中证白酒', basePrice: 15000, sector: '白酒指数', market: '深圳', type: 'index' }
  ],

  // ==================== 期货 ====================
  futures: [
    // === 商品期货 - 农产品 ===
    { code: 'DCE.c', name: '玉米主力', basePrice: 2800, sector: '农产品', market: '大商所', type: 'futures' },
    { code: 'DCE.cs', name: '玉米淀粉主力', basePrice: 2600, sector: '农产品', market: '大商所', type: 'futures' },
    { code: 'DCE.a', name: '豆一主力', basePrice: 6200, sector: '农产品', market: '大商所', type: 'futures' },
    { code: 'DCE.b', name: '豆二主力', basePrice: 4800, sector: '农产品', market: '大商所', type: 'futures' },
    { code: 'DCE.m', name: '豆粕主力', basePrice: 3200, sector: '农产品', market: '大商所', type: 'futures' },
    { code: 'DCE.y', name: '豆油主力', basePrice: 8500, sector: '农产品', market: '大商所', type: 'futures' },
    { code: 'DCE.p', name: '棕榈油主力', basePrice: 7200, sector: '农产品', market: '大商所', type: 'futures' },
    { code: 'CZCE.SR', name: '白糖主力', basePrice: 5800, sector: '农产品', market: '郑商所', type: 'futures' },
    { code: 'CZCE.CF', name: '棉花主力', basePrice: 15000, sector: '农产品', market: '郑商所', type: 'futures' },
    { code: 'CZCE.AP', name: '苹果主力', basePrice: 8500, sector: '农产品', market: '郑商所', type: 'futures' },
    { code: 'CZCE.CJ', name: '红枣主力', basePrice: 12000, sector: '农产品', market: '郑商所', type: 'futures' },
    
    // === 商品期货 - 金属 ===
    { code: 'SHFE.cu', name: '沪铜主力', basePrice: 68000, sector: '有色金属', market: '上期所', type: 'futures' },
    { code: 'SHFE.al', name: '沪铝主力', basePrice: 19000, sector: '有色金属', market: '上期所', type: 'futures' },
    { code: 'SHFE.zn', name: '沪锌主力', basePrice: 25000, sector: '有色金属', market: '上期所', type: 'futures' },
    { code: 'SHFE.pb', name: '沪铅主力', basePrice: 16000, sector: '有色金属', market: '上期所', type: 'futures' },
    { code: 'SHFE.ni', name: '沪镍主力', basePrice: 130000, sector: '有色金属', market: '上期所', type: 'futures' },
    { code: 'SHFE.sn', name: '沪锡主力', basePrice: 220000, sector: '有色金属', market: '上期所', type: 'futures' },
    { code: 'SHFE.au', name: '沪金主力', basePrice: 450, sector: '贵金属', market: '上期所', type: 'futures' },
    { code: 'SHFE.ag', name: '沪银主力', basePrice: 5500, sector: '贵金属', market: '上期所', type: 'futures' },
    { code: 'DCE.i', name: '铁矿石主力', basePrice: 850, sector: '黑色金属', market: '大商所', type: 'futures' },
    { code: 'DCE.j', name: '焦炭主力', basePrice: 2200, sector: '黑色金属', market: '大商所', type: 'futures' },
    { code: 'DCE.jm', name: '焦煤主力', basePrice: 1800, sector: '黑色金属', market: '大商所', type: 'futures' },
    { code: 'SHFE.rb', name: '螺纹钢主力', basePrice: 3800, sector: '黑色金属', market: '上期所', type: 'futures' },
    { code: 'SHFE.hc', name: '热卷主力', basePrice: 3600, sector: '黑色金属', market: '上期所', type: 'futures' },
    
    // === 商品期货 - 能源化工 ===
    { code: 'SHFE.sc', name: '原油主力', basePrice: 520, sector: '能源', market: '上期所', type: 'futures' },
    { code: 'SHFE.fu', name: '燃料油主力', basePrice: 3200, sector: '能源', market: '上期所', type: 'futures' },
    { code: 'SHFE.lu', name: '低硫燃料油主力', basePrice: 3800, sector: '能源', market: '上期所', type: 'futures' },
    { code: 'DCE.eg', name: '乙二醇主力', basePrice: 4500, sector: '化工', market: '大商所', type: 'futures' },
    { code: 'DCE.pp', name: 'PP主力', basePrice: 8200, sector: '化工', market: '大商所', type: 'futures' },
    { code: 'DCE.l', name: 'LLDPE主力', basePrice: 8500, sector: '化工', market: '大商所', type: 'futures' },
    { code: 'DCE.v', name: 'PVC主力', basePrice: 6800, sector: '化工', market: '大商所', type: 'futures' },
    { code: 'CZCE.TA', name: 'PTA主力', basePrice: 5200, sector: '化工', market: '郑商所', type: 'futures' },
    { code: 'CZCE.MA', name: '甲醇主力', basePrice: 2400, sector: '化工', market: '郑商所', type: 'futures' },
    { code: 'SHFE.ru', name: '橡胶主力', basePrice: 13000, sector: '化工', market: '上期所', type: 'futures' },
    
    // === 金融期货 ===
    { code: 'CFFEX.IF', name: '沪深300股指', basePrice: 4200, sector: '股指期货', market: '中金所', type: 'futures' },
    { code: 'CFFEX.IC', name: '中证500股指', basePrice: 6500, sector: '股指期货', market: '中金所', type: 'futures' },
    { code: 'CFFEX.IH', name: '上证50股指', basePrice: 2800, sector: '股指期货', market: '中金所', type: 'futures' },
    { code: 'CFFEX.IM', name: '中证1000股指', basePrice: 8200, sector: '股指期货', market: '中金所', type: 'futures' },
    { code: 'CFFEX.T', name: '10年期国债', basePrice: 102, sector: '国债期货', market: '中金所', type: 'futures' },
    { code: 'CFFEX.TF', name: '5年期国债', basePrice: 101, sector: '国债期货', market: '中金所', type: 'futures' },
    { code: 'CFFEX.TS', name: '2年期国债', basePrice: 100.5, sector: '国债期货', market: '中金所', type: 'futures' }
  ]
};

// 获取所有工具的扁平化列表
function getAllInstruments() {
  const all = [];
  
  // 添加股票
  COMPREHENSIVE_INSTRUMENTS.stocks.forEach(item => {
    all.push({ ...item, category: '股票' });
  });
  
  // 添加指数
  COMPREHENSIVE_INSTRUMENTS.indices.forEach(item => {
    all.push({ ...item, category: '指数' });
  });
  
  // 添加期货
  COMPREHENSIVE_INSTRUMENTS.futures.forEach(item => {
    all.push({ ...item, category: '期货' });
  });
  
  return all;
}

// 按类型获取工具
function getInstrumentsByType(type) {
  switch (type) {
    case 'stock':
      return COMPREHENSIVE_INSTRUMENTS.stocks.map(item => ({ ...item, category: '股票' }));
    case 'index':
      return COMPREHENSIVE_INSTRUMENTS.indices.map(item => ({ ...item, category: '指数' }));
    case 'futures':
      return COMPREHENSIVE_INSTRUMENTS.futures.map(item => ({ ...item, category: '期货' }));
    default:
      return getAllInstruments();
  }
}

// 按行业获取工具
function getInstrumentsBySector(sector) {
  return getAllInstruments().filter(item => item.sector === sector);
}

// 获取所有行业列表
function getAllSectors() {
  const sectors = new Set();
  getAllInstruments().forEach(item => {
    sectors.add(item.sector);
  });
  return Array.from(sectors).sort();
}

// 获取所有市场列表
function getAllMarkets() {
  const markets = new Set();
  getAllInstruments().forEach(item => {
    markets.add(item.market);
  });
  return Array.from(markets).sort();
}

// 搜索工具
function searchInstruments(query) {
  const lowerQuery = query.toLowerCase();
  return getAllInstruments().filter(item => 
    item.code.toLowerCase().includes(lowerQuery) ||
    item.name.toLowerCase().includes(lowerQuery) ||
    item.sector.toLowerCase().includes(lowerQuery)
  );
}

module.exports = {
  COMPREHENSIVE_INSTRUMENTS,
  getAllInstruments,
  getInstrumentsByType,
  getInstrumentsBySector,
  getAllSectors,
  getAllMarkets,
  searchInstruments
};
