const express = require('express');
const router = express.Router();
const BankTransfer = require('../models/BankTransfer');
const { authMiddleware } = require('../middleware/auth');

// All routes require authentication
router.use(authMiddleware);

// In-memory account balance per user (paper trading)
const accountBalances = {};
// In-memory transfer records fallback (when DB write/read fails)
const transferRecords = {};

function getBalance(userId) {
  if (accountBalances[userId] === undefined) {
    accountBalances[userId] = 1000000; // Default 1M for paper trading
  }
  return accountBalances[userId];
}

function getTransferRecords(userId) {
  if (!transferRecords[userId]) {
    transferRecords[userId] = [];
  }
  return transferRecords[userId];
}

function buildFallbackRecord(payload) {
  return {
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...payload,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function createTransferRecordWithFallback(payload) {
  try {
    const record = await BankTransfer.create(payload);
    return {
      record: record.toJSON ? record.toJSON() : record,
      persisted: true
    };
  } catch (error) {
    console.warn('[bank-transfer] 数据库写入失败，已切换内存兜底:', error.message);
    const fallbackRecord = buildFallbackRecord(payload);
    getTransferRecords(payload.userId).unshift(fallbackRecord);
    return {
      record: fallbackRecord,
      persisted: false
    };
  }
}

function applyHistoryQuery(list, { page = 1, pageSize = 20, type }) {
  const p = Number(page) > 0 ? Number(page) : 1;
  const ps = Number(pageSize) > 0 ? Number(pageSize) : 20;
  const filtered = (type === 'deposit' || type === 'withdraw')
    ? list.filter(item => item.type === type)
    : list;

  const sorted = [...filtered].sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    return tb - ta;
  });

  const start = (p - 1) * ps;
  return {
    total: sorted.length,
    page: p,
    pageSize: ps,
    list: sorted.slice(start, start + ps)
  };
}

// GET /api/bank-transfer/balance - Get current account balance
router.get('/balance', (req, res) => {
  const balance = getBalance(req.user.id);
  res.json({
    success: true,
    data: {
      securitiesBalance: balance,
      bankBalance: 5000000, // Demo bank balance
      bankName: 'Demo Bank',
      bankAccount: '****8888',
      securitiesAccount: `KHY-${String(req.user.id).padStart(6, '0')}`
    }
  });
});

// POST /api/bank-transfer/deposit - Bank to securities (deposit)
router.post('/deposit', async (req, res) => {
  try {
    const { amount, bankPassword } = req.body;
    const transferAmount = Number(amount);

    if (!transferAmount || transferAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    if (transferAmount < 100) {
      return res.status(400).json({ success: false, message: 'Minimum deposit is 100 CNY' });
    }
    if (transferAmount > 5000000) {
      return res.status(400).json({ success: false, message: 'Maximum single deposit is 5,000,000 CNY' });
    }

    // Paper trading: password check is simulated
    if (bankPassword !== '123456' && bankPassword !== undefined) {
      // Accept any password in paper mode, but '123456' is the default hint
    }

    const balanceBefore = getBalance(req.user.id);
    accountBalances[req.user.id] = balanceBefore + transferAmount;
    const balanceAfter = accountBalances[req.user.id];

    const payload = {
      userId: req.user.id,
      type: 'deposit',
      amount: transferAmount,
      bankName: 'Demo Bank',
      bankAccount: '****8888',
      securitiesAccount: `KHY-${String(req.user.id).padStart(6, '0')}`,
      status: 'completed',
      balanceBefore,
      balanceAfter,
      remark: 'Bank to securities transfer'
    };
    const { record, persisted } = await createTransferRecordWithFallback(payload);

    res.json({
      success: true,
      message: persisted ? 'Deposit successful' : 'Deposit successful (cached)',
      data: {
        id: record.id,
        amount: transferAmount,
        balanceBefore,
        balanceAfter,
        status: 'completed'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/bank-transfer/withdraw - Securities to bank (withdraw)
router.post('/withdraw', async (req, res) => {
  try {
    const { amount, tradingPassword } = req.body;
    const transferAmount = Number(amount);

    if (!transferAmount || transferAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    if (transferAmount < 100) {
      return res.status(400).json({ success: false, message: 'Minimum withdrawal is 100 CNY' });
    }

    const balanceBefore = getBalance(req.user.id);
    if (transferAmount > balanceBefore) {
      return res.status(400).json({ success: false, message: 'Insufficient securities account balance' });
    }

    accountBalances[req.user.id] = balanceBefore - transferAmount;
    const balanceAfter = accountBalances[req.user.id];

    const payload = {
      userId: req.user.id,
      type: 'withdraw',
      amount: transferAmount,
      bankName: 'Demo Bank',
      bankAccount: '****8888',
      securitiesAccount: `KHY-${String(req.user.id).padStart(6, '0')}`,
      status: 'completed',
      balanceBefore,
      balanceAfter,
      remark: 'Securities to bank transfer'
    };
    const { record, persisted } = await createTransferRecordWithFallback(payload);

    res.json({
      success: true,
      message: persisted ? 'Withdrawal successful' : 'Withdrawal successful (cached)',
      data: {
        id: record.id,
        amount: transferAmount,
        balanceBefore,
        balanceAfter,
        status: 'completed'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bank-transfer/history - Transfer history
router.get('/history', async (req, res) => {
  try {
    const { page = 1, pageSize = 20, type } = req.query;
    const where = { userId: req.user.id };
    if (type === 'deposit' || type === 'withdraw') {
      where.type = type;
    }

    let dbRows = [];
    try {
      dbRows = await BankTransfer.findAll({
        where,
        order: [['createdAt', 'DESC']]
      });
    } catch (error) {
      console.warn('[bank-transfer] 历史记录数据库读取失败，使用内存兜底:', error.message);
    }

    const memoryRows = getTransferRecords(req.user.id);
    const dbList = dbRows.map(item => (item.toJSON ? item.toJSON() : item));
    const merged = [...dbList, ...memoryRows];
    const result = applyHistoryQuery(merged, { page, pageSize, type });

    res.json({
      success: true,
      data: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        list: result.list
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
