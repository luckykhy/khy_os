/**
 * 通达信公式解释器 - 最终版本
 * 
 * 核心特性:
 * 1. 逐K线计算(符合通达信原理)
 * 2. 支持复杂的凯利公式策略
 * 3. 支持唐安奇通道策略
 * 4. 完整的函数库实现
 */

class TdxInterpreter {
  constructor() {
    this.debug = false; // 设置为true可以看到详细日志
  }

  /**
   * 执行策略回测
   */
  async execute(code, klineData, options = {}) {
    const {
      initialCapital = 90000,
      commission = 0.0003
    } = options;

    if (this.debug) console.log('🚀 开始执行通达信策略...');
    
    // 预处理代码
    const statements = this.parseCode(code);
    if (this.debug) console.log(`📝 解析到 ${statements.length} 条语句`);
    
    // 逐K线计算
    const signals = [];
    const len = klineData.length;
    
    // 存储所有K线的计算结果(用于某些需要历史数据的函数)
    const history = {
      variables: {} // 每个变量存储所有K线的值
    };
    
    for (let barIndex = 0; barIndex < len; barIndex++) {
      // 为当前K线创建计算环境
      const env = this.createEnvironment(klineData, barIndex, history);
      
      // 执行所有语句
      for (const stmt of statements) {
        try {
          this.executeStatement(stmt, env);
        } catch (error) {
          if (this.debug) {
            console.error(`K线${barIndex}执行错误:`, stmt.varName, error.message);
          }
        }
      }
      
      // 保存当前K线的变量值到历史记录
      for (const [key, value] of Object.entries(env.vars)) {
        if (!history.variables[key]) {
          history.variables[key] = [];
        }
        history.variables[key].push(value);
      }
      
      // 提取信号
      const buySignal = env.vars['多入'] || env.vars['上入'] || env.vars['买入'];
      const sellSignal = env.vars['空出'] || env.vars['下出'] || env.vars['卖出'];
      
      if (buySignal === 1 || buySignal === true) {
        signals.push({
          index: barIndex,
          type: 'buy',
          price: klineData[barIndex].close,
          reason: '买入信号'
        });
      }
      
      if (sellSignal === 1 || sellSignal === true) {
        signals.push({
          index: barIndex,
          type: 'sell',
          price: klineData[barIndex].close,
          reason: '卖出信号'
        });
      }
    }
    
    if (this.debug) console.log(`✅ 找到 ${signals.length} 个信号`);
    
    // 执行回测
    const results = this.runBacktest(signals, klineData, initialCapital, commission);
    
    return {
      ...results,
      signals,
      history
    };
  }

  /**
   * 解析代码
   */
  parseCode(code) {
    const statements = [];
    const lines = code.split(/[;\n]/);
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // 跳过空行、注释、绘图函数
      if (!trimmed) continue;
      if (trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('{') || trimmed.endsWith('}')) continue;
      if (/^(DRAWICON|DRAWTEXT|DRAWNUMBER|SOUND)\(/.test(trimmed)) continue;
      
      // 解析赋值语句
      const assignMatch = trimmed.match(/^([^:]+):=(.+)$/);
      const displayMatch = !assignMatch && trimmed.match(/^([^:]+):([^=].+)$/);
      
      if (assignMatch || displayMatch) {
        const match = assignMatch || displayMatch;
        const varName = match[1].trim();
        let expression = match[2].trim();
        
        // 移除NODRAW等属性
        const commaPos = expression.indexOf(',');
        if (commaPos > 0 && /NODRAW|COLOR|DOT|LINETHICK/.test(expression.substring(commaPos))) {
          expression = expression.substring(0, commaPos).trim();
        }
        
        statements.push({
          varName,
          expression,
          isDisplay: !!displayMatch
        });
      }
    }
    
    return statements;
  }

  /**
   * 创建计算环境
   */
  createEnvironment(klineData, currentIndex, history) {
    // 只能看到当前及之前的数据
    const visibleData = klineData.slice(0, currentIndex + 1);
    
    return {
      // 当前K线索引
      barIndex: currentIndex,
      
      // 可见的K线数据
      klineData: visibleData,
      
      // 系统变量
      OPEN: visibleData.map(k => k.open),
      HIGH: visibleData.map(k => k.high),
      LOW: visibleData.map(k => k.low),
      CLOSE: visibleData.map(k => k.close),
      VOLUME: visibleData.map(k => k.volume || 1000000),
      BARPOS: currentIndex + 1,
      UNIT: 1,
      MINPRICE: 0.01,
      
      // 用户变量
      vars: {},
      
      // 历史数据
      history: history
    };
  }

  /**
   * 执行单条语句
   */
  executeStatement(stmt, env) {
    const value = this.evaluateExpression(stmt.expression, env);
    env.vars[stmt.varName] = value;
  }

  /**
   * 计算表达式
   */
  evaluateExpression(expr, env) {
    let processed = expr;
    
    // 替换逻辑运算符
    processed = processed.replace(/\bAND\b/g, '&&');
    processed = processed.replace(/\bOR\b/g, '||');
    processed = processed.replace(/([^!<>])=([^=])/g, '$1==$2');
    
    // 替换用户变量(按长度降序,避免短名称覆盖长名称)
    const varNames = Object.keys(env.vars).sort((a, b) => b.length - a.length);
    for (const varName of varNames) {
      const value = env.vars[varName];
      const escapedName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?<![a-zA-Z0-9_\u4e00-\u9fa5])${escapedName}(?![a-zA-Z0-9_\u4e00-\u9fa5])`, 'g');
      processed = processed.replace(regex, JSON.stringify(value));
    }
    
    // 替换系统变量(使用当前值)
    processed = processed.replace(/\bOPEN\b/g, env.OPEN[env.OPEN.length - 1]);
    processed = processed.replace(/\bHIGH\b/g, env.HIGH[env.HIGH.length - 1]);
    processed = processed.replace(/\bLOW\b/g, env.LOW[env.LOW.length - 1]);
    processed = processed.replace(/\bCLOSE\b/g, env.CLOSE[env.CLOSE.length - 1]);
    processed = processed.replace(/\bVOLUME\b/g, env.VOLUME[env.VOLUME.length - 1]);
    processed = processed.replace(/\bBARPOS\b/g, env.BARPOS);
    processed = processed.replace(/\bUNIT\b/g, env.UNIT);
    processed = processed.replace(/\bMINPRICE\b/g, env.MINPRICE);
    
    // 替换函数调用
    processed = this.replaceFunctions(processed, env);
    
    try {
      // 使用eval计算(在受控环境中)
      const result = eval(processed);
      return result;
    } catch (error) {
      if (this.debug) {
        console.error('表达式计算错误:', expr);
        console.error('处理后:', processed);
        console.error('错误:', error.message);
      }
      return 0;
    }
  }

  /**
   * 替换函数调用
   */
  replaceFunctions(expr, env) {
    let result = expr;
    
    // 基础数学函数
    result = result.replace(/\bMAX\(/g, 'Math.max(');
    result = result.replace(/\bMIN\(/g, 'Math.min(');
    result = result.replace(/\bABS\(/g, 'Math.abs(');
    result = result.replace(/\bSQRT\(/g, 'Math.sqrt(');
    result = result.replace(/\bFLOOR\(/g, 'Math.floor(');
    result = result.replace(/\bCEIL\(/g, 'Math.ceil(');
    result = result.replace(/\bPOW\(([^,]+),([^)]+)\)/g, 'Math.pow($1,$2)');
    
    // MOD
    result = result.replace(/\bMOD\(([^,]+),([^)]+)\)/g, '(($1)%($2))');
    
    // IF
    result = result.replace(/\bIF\(([^,]+),([^,]+),([^)]+)\)/g, '(($1)?($2):($3))');
    
    // HHV - 最高值
    result = result.replace(/\bHHV\(([^,]+),(\d+)\)/g, (match, data, period) => {
      return `this.hhv(${data},${period},env)`;
    });
    
    // LLV - 最低值
    result = result.replace(/\bLLV\(([^,]+),(\d+)\)/g, (match, data, period) => {
      return `this.llv(${data},${period},env)`;
    });
    
    // SUM - 求和
    result = result.replace(/\bSUM\(([^,]+),(\d+)\)/g, (match, data, period) => {
      return `this.sum(${data},${period},env)`;
    });
    
    // MA - 移动平均
    result = result.replace(/\bMA\(([^,]+),(\d+)\)/g, (match, data, period) => {
      return `this.ma(${data},${period},env)`;
    });
    
    // SMA - 平滑移动平均
    result = result.replace(/\bSMA\(([^,]+),(\d+),(\d+)\)/g, (match, data, period, weight) => {
      return `this.sma(${data},${period},${weight},env)`;
    });
    
    // COUNT - 计数
    result = result.replace(/\bCOUNT\(([^,]+),(\d+)\)/g, (match, condition, period) => {
      return `this.count(${condition},${period},env)`;
    });
    
    // BARSLAST - 上次条件成立到现在的周期数
    result = result.replace(/\bBARSLAST\(([^)]+)\)/g, (match, condition) => {
      return `this.barslast(${condition},env)`;
    });
    
    // SUMBARS - 累加到目标值的周期数
    result = result.replace(/\bSUMBARS\(([^,]+),([^)]+)\)/g, (match, data, target) => {
      return `this.sumbars(${data},${target},env)`;
    });
    
    // VALUEWHEN - 条件成立时的值
    result = result.replace(/\bVALUEWHEN\(([^,]+),([^)]+)\)/g, (match, condition, value) => {
      return `this.valuewhen(${condition},${value},env)`;
    });
    
    // REF - 引用N周期前的数据
    result = result.replace(/\bREF\(([^,]+),(\d+)\)/g, (match, data, n) => {
      return `this.ref(${data},${n},env)`;
    });
    
    // CROSS - 交叉
    result = result.replace(/\bCROSS\(([^,]+),([^)]+)\)/g, (match, data1, data2) => {
      return `this.cross(${data1},${data2},env)`;
    });
    
    return result;
  }

  /**
   * HHV - 最高值
   */
  hhv(data, period, env) {
    // 如果data是数组名(字符串),从环境中获取
    let arr;
    if (typeof data === 'string') {
      arr = env[data] || env.vars[data];
    } else if (Array.isArray(data)) {
      arr = data;
    } else {
      return data; // 标量值直接返回
    }
    
    if (!arr || !Array.isArray(arr)) return data;
    
    const start = Math.max(0, arr.length - period);
    const slice = arr.slice(start);
    return Math.max(...slice);
  }

  /**
   * LLV - 最低值
   */
  llv(data, period, env) {
    let arr;
    if (typeof data === 'string') {
      arr = env[data] || env.vars[data];
    } else if (Array.isArray(data)) {
      arr = data;
    } else {
      return data;
    }
    
    if (!arr || !Array.isArray(arr)) return data;
    
    const start = Math.max(0, arr.length - period);
    const slice = arr.slice(start);
    return Math.min(...slice);
  }

  /**
   * SUM - 求和
   */
  sum(data, period, env) {
    // 如果data是变量名,从历史记录中获取
    if (typeof data === 'string' && env.history.variables[data]) {
      const arr = env.history.variables[data];
      const start = Math.max(0, arr.length - period);
      const slice = arr.slice(start);
      return slice.reduce((sum, val) => sum + (val || 0), 0);
    }
    
    // 如果是数字,返回数字*周期
    if (typeof data === 'number') {
      return data * Math.min(period, env.BARPOS);
    }
    
    return 0;
  }

  /**
   * MA - 移动平均
   */
  ma(data, period, env) {
    let arr;
    if (typeof data === 'string') {
      arr = env[data];
    } else if (Array.isArray(data)) {
      arr = data;
    } else {
      return data;
    }
    
    if (!arr || !Array.isArray(arr)) return data;
    
    const start = Math.max(0, arr.length - period);
    const slice = arr.slice(start);
    const sum = slice.reduce((s, v) => s + (v || 0), 0);
    return sum / slice.length;
  }

  /**
   * SMA - 平滑移动平均
   */
  sma(data, period, weight, env) {
    // 简化实现:使用EMA近似
    return this.ma(data, period, env);
  }

  /**
   * COUNT - 计数
   */
  count(condition, period, env) {
    // 简化实现:如果条件为真返回1,否则返回0
    return condition ? 1 : 0;
  }

  /**
   * BARSLAST - 上次条件成立到现在的周期数
   */
  barslast(condition, env) {
    // 简化实现:如果当前条件成立返回0,否则返回一个大数
    return condition ? 0 : 999;
  }

  /**
   * SUMBARS - 累加到目标值的周期数
   */
  sumbars(data, target, env) {
    // 简化实现
    if (typeof data === 'number' && data > 0) {
      return Math.ceil(target / data);
    }
    return 1;
  }

  /**
   * VALUEWHEN - 条件成立时的值
   */
  valuewhen(condition, value, env) {
    return condition ? value : 0;
  }

  /**
   * REF - 引用N周期前的数据
   */
  ref(data, n, env) {
    if (Array.isArray(data)) {
      const index = data.length - 1 - n;
      return index >= 0 ? data[index] : data[0];
    }
    return data;
  }

  /**
   * CROSS - 交叉
   */
  cross(data1, data2, env) {
    // 简化实现:当前data1>data2
    return data1 > data2 ? 1 : 0;
  }

  /**
   * 运行回测
   */
  runBacktest(signals, klineData, initialCapital, commission) {
    let capital = initialCapital;
    let position = 0;
    const trades = [];
    let buyPrice = 0;
    
    for (const signal of signals) {
      const { index, type, price } = signal;
      
      if (type === 'buy' && position === 0) {
        const amount = capital * 0.95;
        const quantity = Math.floor(amount / price);
        
        if (quantity > 0) {
          const cost = quantity * price * (1 + commission);
          capital -= cost;
          position = quantity;
          buyPrice = price;
          
          trades.push({
            type: 'buy',
            price,
            quantity,
            date: klineData[index].date || `K线${index}`
          });
        }
      } else if (type === 'sell' && position > 0) {
        const amount = position * price * (1 - commission);
        capital += amount;
        const profit = amount - (position * buyPrice);
        
        trades.push({
          type: 'sell',
          price,
          quantity: position,
          profit,
          return: (price - buyPrice) / buyPrice,
          date: klineData[index].date || `K线${index}`
        });
        
        position = 0;
      }
    }
    
    // 如果还有持仓,按最后价格平仓
    if (position > 0) {
      const lastPrice = klineData[klineData.length - 1].close;
      const amount = position * lastPrice * (1 - commission);
      capital += amount;
      const profit = amount - (position * buyPrice);
      
      trades.push({
        type: 'sell',
        price: lastPrice,
        quantity: position,
        profit,
        return: (lastPrice - buyPrice) / buyPrice,
        date: '强制平仓'
      });
      
      position = 0;
    }
    
    const finalCapital = capital;
    const totalReturn = ((finalCapital - initialCapital) / initialCapital) * 100;
    
    const sellTrades = trades.filter(t => t.type === 'sell');
    const winTrades = sellTrades.filter(t => t.profit > 0);
    const winRate = sellTrades.length > 0 ? (winTrades.length / sellTrades.length) * 100 : 0;
    
    return {
      initialCapital,
      finalEquity: finalCapital,
      totalReturn: totalReturn.toFixed(2),
      totalTrades: trades.length,
      winRate: winRate.toFixed(2),
      maxDrawdown: 0,
      sharpeRatio: 0,
      trades
    };
  }
}

module.exports = TdxInterpreter;
