/**
 * Management resource: platform users.
 *
 * Source of truth: the relational `users` table (@khy/shared/models User).
 * Both the CLI (`khy manage users ...`) and the Web management page invoke
 * these ops through managementRegistry, so the two surfaces stay in lockstep.
 */
const { User } = require('../../../models');

const PUBLIC_ATTRS = ['id', 'username', 'email', 'role', 'status', 'lastLoginAt', 'createdAt'];

function toPublic(user) {
  if (!user) return null;
  const u = user.get ? user.get({ plain: true }) : user;
  const out = {};
  for (const k of PUBLIC_ATTRS) out[k] = u[k];
  return out;
}

/** @type {import('../resourceContract').Contract} */
const contract = {
  id: 'users',
  label: 'Users',
  source: 'db',
  sourceDetail: 'users',
  capabilities: ['list', 'get', 'create', 'delete', 'reset-password'],
  schema: {
    get: { id: { type: 'string', required: true } },
    create: {
      username: { type: 'string', required: true },
      email: { type: 'string', required: true },
      password: { type: 'string', required: true },
      role: { type: 'string', required: false },
    },
    delete: { id: { type: 'string', required: true } },
    'reset-password': {
      id: { type: 'string', required: true },
      password: { type: 'string', required: true },
    },
  },
  ops: {
    async list() {
      const rows = await User.findAll({ attributes: PUBLIC_ATTRS, order: [['id', 'ASC']] });
      return { users: rows.map(toPublic) };
    },
    async get(args) {
      if (!args || args.id == null) throw new Error('id is required');
      const user = await User.findByPk(args.id, { attributes: PUBLIC_ATTRS });
      if (!user) throw new Error('user not found');
      return { user: toPublic(user) };
    },
    async create(args) {
      if (!args || !args.username) throw new Error('username is required');
      if (!args.email) throw new Error('email is required');
      if (!args.password) throw new Error('password is required');
      const role = args.role === 'admin' ? 'admin' : 'user';
      const user = await User.create({
        username: args.username,
        email: args.email,
        password: args.password,
        role,
      });
      return { user: toPublic(user) };
    },
    async delete(args) {
      if (!args || args.id == null) throw new Error('id is required');
      const user = await User.findByPk(args.id);
      if (!user) throw new Error('user not found');
      await user.destroy();
      return { deleted: args.id };
    },
    'reset-password': async (args) => {
      if (!args || args.id == null) throw new Error('id is required');
      if (!args.password) throw new Error('password is required');
      const user = await User.findByPk(args.id);
      if (!user) throw new Error('user not found');
      await user.update({ password: args.password });
      return { reset: args.id };
    },
  },
};

module.exports = contract;
