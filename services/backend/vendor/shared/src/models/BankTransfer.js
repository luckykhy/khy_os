/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const BankTransfer = sequelize.define('BankTransfer', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'User ID'
  },
  type: {
    type: DataTypes.ENUM('deposit', 'withdraw'),
    allowNull: false,
    comment: 'Transfer type: deposit (bank->securities), withdraw (securities->bank)'
  },
  amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Transfer amount'
  },
  bankName: {
    type: DataTypes.STRING(50),
    defaultValue: 'Demo Bank',
    field: 'bank_name',
    comment: 'Bank name'
  },
  bankAccount: {
    type: DataTypes.STRING(30),
    field: 'bank_account',
    comment: 'Bank account (masked)'
  },
  securitiesAccount: {
    type: DataTypes.STRING(30),
    field: 'securities_account',
    comment: 'Securities account'
  },
  status: {
    type: DataTypes.ENUM('pending', 'completed', 'failed', 'cancelled'),
    defaultValue: 'completed',
    comment: 'Transfer status'
  },
  remark: {
    type: DataTypes.STRING(200),
    comment: 'Remark / note'
  },
  balanceBefore: {
    type: DataTypes.DECIMAL(15, 2),
    field: 'balance_before',
    comment: 'Account balance before transfer'
  },
  balanceAfter: {
    type: DataTypes.DECIMAL(15, 2),
    field: 'balance_after',
    comment: 'Account balance after transfer'
  }
}, {
  tableName: 'bank_transfers',
  timestamps: true
});

module.exports = BankTransfer;
