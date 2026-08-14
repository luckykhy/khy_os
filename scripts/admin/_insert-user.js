'use strict';
const path = require('path');
const bcrypt = require('bcryptjs');
const { Sequelize } = require('sequelize');

async function main() {
  // khyquant DB lives inside the project data home (repo root/.khy/khyquant/data/)
  const repoRoot = path.resolve(__dirname, '..', '..');
  const dbPath = path.join(repoRoot, '.khy', 'khyquant', 'data', 'khy-quant.db');
  // Create a Sequelize connection directly to the SQLite file
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: dbPath,
    logging: false,
  });

  const { User } = require(path.join(repoRoot, 'services', 'backend', 'src', 'models'));

  // Delete existing admin user if any
  await User.destroy({ where: { username: 'qiqiaoban' } });
  console.log('Deleted existing qiqiaoban user');

  // Create admin with known password
  const user = await User.create({
    username: 'qiqiaoban',
    email: 'qiqiaoban@khy-quant.com',
    password: 'testpass123',
    role: 'admin',
    status: 'active',
  });
  console.log('Created user:', user.username, 'id:', user.id);

  // Verify the password works
  const isValid = await user.comparePassword('testpass123');
  console.log('Password verify:', isValid);

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
