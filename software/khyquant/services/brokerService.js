/**
 * Broker abstraction layer
 * Currently implements paper trading; real broker adapters can be swapped in.
 */
const { Trade } = require('../models');
const logger = require('../utils/logger');

class BrokerService {
  constructor() {
    this.mode = 'paper'; // 'paper' | 'live'
    this.INITIAL_FUNDS = 1_000_000;
  }

  /**
   * Get account summary for a user
   */
  async getAccount(userId) {
    const trades = await Trade.findAll({
      where: { user_id: userId, status: 'filled' }
    });

    let totalProfit = 0;
    let todayProfit = 0;
    let positionCost = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const t of trades) {
      if (t.isClosed && t.profit) {
        totalProfit += parseFloat(t.profit);
        if (t.closedAt && new Date(t.closedAt) >= today) {
          todayProfit += parseFloat(t.profit);
        }
      } else if (!t.isClosed && t.side === 'buy') {
        positionCost += parseFloat(t.amount);
      }
    }

    const available = this.INITIAL_FUNDS + totalProfit - positionCost;
    return {
      availableFunds: available,
      totalAssets: available + positionCost,
      frozenFunds: 0,
      totalProfit,
      todayProfit,
      positionValue: positionCost,
      tradeCount: trades.length
    };
  }

  /**
   * Submit an order (paper trading mode)
   * Returns the created Trade record.
   */
  async submitOrder(userId, { symbol, side, quantity, price, type = 'paper', strategyId = null }) {
    if (!['buy', 'sell'].includes(side)) {
      throw Object.assign(new Error('side must be buy or sell'), { status: 400 });
    }

    const qty = parseFloat(quantity);
    const px = parseFloat(price);
    if (!qty || qty <= 0 || !px || px <= 0) {
      throw Object.assign(new Error('Invalid quantity or price'), { status: 400 });
    }

    const amount = qty * px;

    // Validate funds for buy orders
    if (side === 'buy') {
      const acct = await this.getAccount(userId);
      if (acct.availableFunds < amount) {
        const err = new Error(`Insufficient funds: available=${acct.availableFunds.toFixed(2)}, required=${amount.toFixed(2)}`);
        err.status = 400;
        err.data = { availableFunds: acct.availableFunds, requiredAmount: amount };
        throw err;
      }
    }

    const trade = await Trade.create({
      user_id: userId,
      strategy_id: strategyId,
      symbol,
      side,
      quantity: qty,
      price: px,
      amount,
      type,
      status: 'filled',
      filledAt: new Date()
    });

    logger.info('Order filled', { tradeId: trade.id, symbol, side, qty, px });
    return trade;
  }

  /**
   * Close a position (full or partial)
   */
  async closePosition(userId, tradeId, { closeType = 'full', quantity, closePrice }) {
    const trade = await Trade.findOne({ where: { id: tradeId, user_id: userId } });
    if (!trade) throw Object.assign(new Error('Trade not found'), { status: 404 });
    if (trade.status !== 'filled') throw Object.assign(new Error('Trade not filled'), { status: 400 });
    if (trade.isClosed) throw Object.assign(new Error('Already closed'), { status: 400 });

    const px = parseFloat(closePrice) || trade.price;
    const closeQty = closeType === 'full' ? trade.quantity : Math.min(parseInt(quantity), trade.quantity);

    if (closeQty <= 0) throw Object.assign(new Error('Invalid close quantity'), { status: 400 });

    const profit = trade.side === 'buy'
      ? (px - trade.price) * closeQty
      : (trade.price - px) * closeQty;

    if (closeType === 'full' || closeQty >= trade.quantity) {
      await trade.update({ isClosed: true, closedAt: new Date(), closedQuantity: trade.quantity, profit });
      return { tradeId: trade.id, closeType: 'full', closedQuantity: trade.quantity, profit };
    }

    // Partial close: reduce original, create counter-trade
    const remaining = trade.quantity - closeQty;
    await trade.update({ quantity: remaining, amount: remaining * trade.price });
    await Trade.create({
      user_id: userId,
      strategy_id: trade.strategy_id,
      symbol: trade.symbol,
      side: trade.side === 'buy' ? 'sell' : 'buy',
      quantity: closeQty,
      price: px,
      amount: closeQty * px,
      status: 'filled',
      type: trade.type,
      isClosed: true,
      closedAt: new Date(),
      filledAt: new Date(),
      profit
    });

    return { tradeId: trade.id, closeType: 'partial', closedQuantity: closeQty, remainingQuantity: remaining, profit };
  }
}

module.exports = new BrokerService();
