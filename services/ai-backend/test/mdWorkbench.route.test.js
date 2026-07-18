/**
 * mdWorkbench.route.test.js — 服务器文件目录读写路由（Markdown 工作台「连服务器文件」增强）。
 *
 * 覆盖两道安全闸 + fail-soft：
 *   - 鉴权：未带 token → 401（router.use(authenticateToken)）。
 *   - 路径 confinement：`../` 逃逸 / 绝对路径穿越 → 403，绝不泄漏根目录外文件。
 *   - 文本扩展名 allowlist：读/写非文本扩展名 → 400。
 *   - 正常读/列/存在配置根内工作。
 *   - 门控 enabled()：KHY_AI_MD_WORKBENCH_FILES 的 default-on + CANON off 语义。
 *
 * 隔离：sqlite 临时库 + 临时 workbench 根目录（KHY_MD_WORKBENCH_ROOT），测后清理。
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-mdwb-${process.pid}.db`);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mdwb-root-'));

process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-mdwb-route';
process.env.NODE_ENV = 'test';
process.env.KHY_MD_WORKBENCH_ROOT = ROOT;

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { sequelize, User } = require('@khy/shared/models');
const router = require('../src/routes/mdWorkbench');

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

let app;
let userA;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = await User.create({
    username: 'mdwb-a', email: 'mdwb-a@test.local', password: 'pw-a-123456', status: 'active',
  });

  // 根目录内的桩文件树：一个 md、一个子目录 md、一个非文本文件。
  fs.mkdirSync(path.join(ROOT, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'a.md'), '# A\n正文内容');
  fs.writeFileSync(path.join(ROOT, 'sub', 'b.markdown'), '# B\n');
  fs.writeFileSync(path.join(ROOT, 'notes.txt'), 'plain');
  fs.writeFileSync(path.join(ROOT, 'ignore.png'), 'x');
  // 根目录之外的机密文件——confinement 必须拒绝经 ../ 读到它。
  fs.writeFileSync(path.join(path.dirname(ROOT), 'SECRET.md'), 'TOP-SECRET');

  app = express();
  app.use(express.json());
  app.use('/api/md-workbench', router);
});

afterAll(async () => {
  try { await sequelize.close(); } catch (_) { /* ignore */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  try { fs.rmSync(path.join(path.dirname(ROOT), 'SECRET.md'), { force: true }); } catch (_) { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch (_) { /* ignore */ }
});

describe('mdWorkbench route — auth + confinement + allowlist', () => {
  test('未鉴权 → 401（/list 也受 authenticateToken 保护）', async () => {
    const r = await request(app).get('/api/md-workbench/list');
    expect(r.status).toBe(401);
  });

  test('鉴权后 /list 列出根内 Markdown（递归子目录，忽略非文本）', async () => {
    const r = await request(app).get('/api/md-workbench/list').set('Authorization', `Bearer ${tokenFor(userA.id)}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const names = r.body.data.files.map((f) => f.name);
    expect(names).toContain('a.md');
    expect(names).toContain('b.markdown'); // 递归进子目录
    expect(names).toContain('notes.txt');
    expect(names).not.toContain('ignore.png'); // 非文本被忽略
  });

  test('/list 体现目录层级：子目录作为 type:dir 节点、其内文件 depth+1、空目录被剔除', async () => {
    // 追加一个只含非文本的空目录（应无 dir 节点）。
    fs.mkdirSync(path.join(ROOT, 'empty'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'empty', 'x.png'), 'x');
    const r = await request(app).get('/api/md-workbench/list').set('Authorization', `Bearer ${tokenFor(userA.id)}`);
    const files = r.body.data.files;
    const dirNode = files.find((f) => f.type === 'dir' && f.name === 'sub');
    expect(dirNode).toBeTruthy();
    expect(dirNode.depth).toBe(0);
    const aTop = files.find((f) => f.name === 'a.md');
    expect(aTop.type).toBe('file');
    expect(aTop.depth).toBe(0);
    const bNested = files.find((f) => f.name === 'b.markdown');
    expect(bNested.type).toBe('file');
    expect(bNested.depth).toBe(1); // 子目录内文件层级 +1
    expect(files.indexOf(dirNode)).toBeLessThan(files.indexOf(bNested)); // 目录节点在其内容之前
    expect(files.some((f) => f.type === 'dir' && f.name === 'empty')).toBe(false); // 空目录剔除
  });

  test('/read 读取根内文本文件内容', async () => {
    const abs = path.join(ROOT, 'a.md');
    const r = await request(app)
      .get('/api/md-workbench/read')
      .query({ path: abs })
      .set('Authorization', `Bearer ${tokenFor(userA.id)}`);
    expect(r.status).toBe(200);
    expect(r.body.data.content).toMatch(/正文内容/);
  });

  test('红线 confinement：/read 经 ../ 逃逸到根外机密 → 403，绝不泄漏', async () => {
    const escape = path.join(ROOT, '..', 'SECRET.md');
    const r = await request(app)
      .get('/api/md-workbench/read')
      .query({ path: escape })
      .set('Authorization', `Bearer ${tokenFor(userA.id)}`);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toMatch(/TOP-SECRET/);
  });

  test('/read 非文本扩展名 → 400', async () => {
    const r = await request(app)
      .get('/api/md-workbench/read')
      .query({ path: path.join(ROOT, 'ignore.png') })
      .set('Authorization', `Bearer ${tokenFor(userA.id)}`);
    expect(r.status).toBe(400);
  });

  test('/save 写回根内 .md', async () => {
    const abs = path.join(ROOT, 'a.md');
    const r = await request(app)
      .post('/api/md-workbench/save')
      .query({ path: abs })
      .set('Authorization', `Bearer ${tokenFor(userA.id)}`)
      .send({ content: '# 新内容\n已保存' });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(abs, 'utf8')).toBe('# 新内容\n已保存');
  });

  test('红线 confinement：/save 经 ../ 逃逸 → 403，不写根外', async () => {
    const escape = path.join(ROOT, '..', 'SECRET.md');
    const r = await request(app)
      .post('/api/md-workbench/save')
      .query({ path: escape })
      .set('Authorization', `Bearer ${tokenFor(userA.id)}`)
      .send({ content: 'HACKED' });
    expect(r.status).toBe(403);
    expect(fs.readFileSync(path.join(path.dirname(ROOT), 'SECRET.md'), 'utf8')).toBe('TOP-SECRET');
  });

  test('/save 非文本扩展名 → 400，不落盘', async () => {
    const evil = path.join(ROOT, 'evil.exe');
    const r = await request(app)
      .post('/api/md-workbench/save')
      .query({ path: evil })
      .set('Authorization', `Bearer ${tokenFor(userA.id)}`)
      .send({ content: 'x' });
    expect(r.status).toBe(400);
    expect(fs.existsSync(evil)).toBe(false);
  });
});

describe('mdWorkbench enabled() — default-on + CANON off', () => {
  const KEY = 'KHY_AI_MD_WORKBENCH_FILES';
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved;
  });

  test('缺省应开', () => {
    delete process.env[KEY];
    expect(router.enabled()).toBe(true);
  });

  test('CANON off 词关（0/false/off/no，大小写不敏感）', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' off ']) {
      process.env[KEY] = v;
      expect(router.enabled()).toBe(false);
    }
  });

  test('非关闭词开', () => {
    for (const v of ['1', 'true', 'yes', 'x']) {
      process.env[KEY] = v;
      expect(router.enabled()).toBe(true);
    }
  });
});
