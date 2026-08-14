/**
 * @pattern Command
 */
const { sequelize } = require('../src/config/database');

async function up() {
  const qi = sequelize.getQueryInterface();
  const { DataTypes } = require('sequelize');

  // webauthn_credential_id: base64url 编码的 credential id
  await qi.addColumn('users', 'webauthn_credential_id', {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null
  }).catch(() => console.log('webauthn_credential_id 已存在，跳过'));

  // webauthn_public_key: 公钥（base64）
  await qi.addColumn('users', 'webauthn_public_key', {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null
  }).catch(() => console.log('webauthn_public_key 已存在，跳过'));

  // webauthn_counter: 防重放计数器
  await qi.addColumn('users', 'webauthn_counter', {
    type: DataTypes.BIGINT,
    allowNull: true,
    defaultValue: 0
  }).catch(() => console.log('webauthn_counter 已存在，跳过'));

  console.log('✅ WebAuthn 字段迁移完成');
}

up()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
