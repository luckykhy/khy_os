'use strict';

/**
 * diskCleanHandler.test.js �?`khy cleandisk` 的纯决策�? *
 * 盯的都是「删错不可逆」的几条边：分组确认的输入解析不能把「保留」猜成「删除」�? * 未完成下载必须过在用窗口、扫描预算耗尽要如实标 truncated、includeIds 点名不能
 * 把回收站一起放行。全部用临时目录树与�?scanResult，绝不碰真实 C 盘�? */

const fs = require('fs');
const os = require('os');
const path = require('path');

const clean = require('../../src/cli/handlers/diskClean');
const planner = require('../../src/services/domain/backup/diskCleanup/planner');

/** 造一棵一次性的临时目录树�?*/
function fixture(layout = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cleandisk-'));
  const write = (rel, bytes) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(bytes, 0x61));
  };
  for (const [rel, bytes] of Object.entries(layout)) {
    write(rel, bytes);
  }
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('parseGroupAnswer �?分组确认的输入解�?, () => {
  test('确认类输入（y/删除）→ all', () => {
    for (const raw of ['y', 'Y', 'yes', '删除', '全删', '全部删除']) {
      expect(clean.parseGroupAnswer(raw, 5)).toBe({ mode: 'all' });
    }
  });

  test('保留类输入（回车/n/保留）→ none，绝不猜成删�?, () => {
    for (const raw of ['', '   ', 'n', 'N', '保留', '跳过', 'keep']) {
      expect(clean.parseGroupAnswer(raw, 5)).toBe({ mode: 'none' });
    }
  });

  test('序号列表 �?subset�?-based 且越界项被丢�?, () => {
    expect(clean.parseGroupAnswer('1,3', 5)).toBe({ mode: 'subset', indexes: [1, 3] });
    expect(clean.parseGroupAnswer('2�?', 5)).toBe({ mode: 'subset', indexes: [2, 4] });
    // 全部越界 �?unknown（提示后重问），绝不静默当「保留」或「全删�?    expect(clean.parseGroupAnswer('9', 5)).toBe({ mode: 'unknown' });
    expect(clean.parseGroupAnswer('0', 5)).toBe({ mode: 'unknown' });
    // 去重
    expect(clean.parseGroupAnswer('2,2,3', 5)).toBe({ mode: 'subset', indexes: [2, 3] });
  });

  test('退出类输入（q/退出）�?quit；乱�?�?unknown', () => {
    expect(clean.parseGroupAnswer('q', 5)).toBe({ mode: 'quit' });
    expect(clean.parseGroupAnswer('退�?, 5)).toBe({ mode: 'quit' });
    expect(clean.parseGroupAnswer('随便说点�?, 5)).toBe({ mode: 'unknown' });
  });
});

describe('describeFile �?用途说�?, () => {
  test('安装�?/ 未完成下�?/ 压缩�?/ 文档各自命中', () => {
    expect(clean.describeFile('C:\\x\\setup.exe')).toBe('安装�?);
    expect(clean.describeFile('C:\\x\\OneDriveSetup.exe')).toBe('安装�?);
    expect(clean.describeFile('C:\\x\\jdk-installer.exe')).toBe('安装�?);
    expect(clean.describeFile('C:\\x\\a.crdownload')).toBe('未完成的下载');
    expect(clean.describeFile('C:\\x\\b.rar')).toBe('压缩�?);
    expect(clean.describeFile('C:\\x\\报告.pdf')).toBe('文档');
  });

  test('.exe 无安装器命名特征 �?「可执行程序」，不误导为可删的安装包', () => {
    // 程序本体（浏览器内核/IDE 主程序）删了会坏应用，措辞必须区�?    expect(clean.describeFile('C:\\x\\chrome-headless-shell.exe')).toBe('可执行程�?);
    expect(clean.describeFile('C:\\x\\Qoder IDE.exe')).toBe('可执行程�?);
  });

  test('无匹配回退「其他文件」，绝不�?, () => {
    expect(clean.describeFile('')).toBe('其他文件');
    expect(clean.describeFile('C:\\x\\no-ext')).toBe('其他文件');
  });
});

describe('chunkGroups �?分组', () => {
  test('整除与不整除都正确收�?, () => {
    expect(clean.chunkGroups([1, 2, 3, 4, 5], 5)).toBe([[1, 2, 3, 4, 5]]);
    expect(clean.chunkGroups([1, 2, 3, 4, 5, 6, 7], 5)).toBe([[1, 2, 3, 4, 5], [6, 7]]);
    expect(clean.chunkGroups([], 5)).toBe([]);
  });
});

describe('collectLargeFiles �?有界大文件扫�?, () => {
  test('只收 ≥minBytes 的文件并按体积降序；小文件与目录不入�?, () => {
    const f = fixture({
      'a.dat': 500,
      'b.dat': 300,
      'small.txt': 50,
      'nested/c.dat': 200,
    });
    try {
      const res = clean.collectLargeFiles([f.root], 100, {}, 10_000);
      expect(res.truncated).toBe(false);
      expect(res.files.map((x) => x.sizeBytes)).toBe([500, 300, 200]);
      expect(res.files[0].path.endsWith('a.dat')).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test('预算�?0 �?truncated:true 且不虚报结果', () => {
    const f = fixture({ 'a.dat': 500 });
    try {
      const res = clean.collectLargeFiles([f.root], 100, {}, 0);
      expect(res.truncated).toBe(true);
      expect(res.files).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  test('符号链接不跟随、不入列（建不出来就跳过该用例）', () => {
    const f = fixture({ 'a.dat': 500, 'real/b.dat': 900 });
    try {
      let linked = true;
      try {
        fs.symlinkSync(path.join(f.root, 'real'), path.join(f.root, 'link'), 'dir');
      } catch {
        linked = false; // Windows 无开发者模式时建不了符号链�?      }
      const res = clean.collectLargeFiles([f.root], 100, {}, 10_000);
      const paths = res.files.map((x) => path.basename(x.path));
      expect(paths).toContain('b.dat'); // 真实目录里的文件照常被扫�?      if (linked) {
        // 链接目标 b.dat 只能出现一次：链接本身没被跟随
        expect(paths.filter((p) => p === 'b.dat').length).toBe(1);
      }
    } finally {
      f.cleanup();
    }
  });
});

describe('findUnfinishedDownloads �?下载中断文件', () => {
  test('过期 .crdownload 入列�?h 内的与普通文件不入列', () => {
    const f = fixture({ 'old.crdownload': 4096, 'fresh.crdownload': 2048, 'done.zip': 1024 });
    try {
      const old = new Date(Date.now() - 5 * 3600 * 1000);
      fs.utimesSync(path.join(f.root, 'old.crdownload'), old, old);
      const res = clean.findUnfinishedDownloads(f.root, {}, 2);
      expect(res.map((x) => path.basename(x.path))).toBe(['old.crdownload']);
      expect(res[0].sizeBytes).toBe(4096);
    } finally {
      f.cleanup();
    }
  });

  test('目录不存在返回空数组，绝不抛', () => {
    expect(clean.findUnfinishedDownloads(path.join(os.tmpdir(), 'khy-不存�?xyz'), {}, 2)).toBe(
      []
    );
  });
});

describe('removeFile �?删除计量', () => {
  test('删除返回字节数；重复删返�?0（目标已达成）；不抛', async () => {
    const f = fixture({ 'x.bin': 1234 });
    try {
      const p = path.join(f.root, 'x.bin');
      await expect(clean.removeFile(p, {})).resolves.toBe(1234);
      await expect(clean.removeFile(p, {})).resolves.toBe(0);
    } finally {
      f.cleanup();
    }
  });
});

describe('_resolveRoot �?盘符/目录参数', () => {
  test('C / c: / C:\\ 都归一为大写盘根；绝对目录原样放行', () => {
    expect(clean._resolveRoot('c')).toBe({ root: 'C:\\' });
    expect(clean._resolveRoot('C:')).toBe({ root: 'C:\\' });
    expect(clean._resolveRoot('d:\\')).toBe({ root: 'D:\\' });
    expect(clean._resolveRoot('D:\\downloads')).toBe({ root: 'D:\\downloads' });
  });

  test('相对路径/非法输入报错而不是猜', () => {
    expect(clean._resolveRoot('downloads').error).toBeTruthy();
    expect(clean._resolveRoot('..').error).toBeTruthy();
  });
});

describe('_defaultRoot �?系统盘根解析优先�?, () => {
  test('SystemDrive 环境变量优先（单一真源�?, () => {
    expect(clean._defaultRoot({ env: { SystemDrive: 'C:' }, homedir: 'C:\\Users\\x' })).toBe('C:\\');
    expect(clean._defaultRoot({ env: { SystemDrive: 'D:' }, homedir: 'C:\\Users\\x' })).toBe('D:\\');
  });

  test('�?SystemDrive 时回退主目录所在盘，绝不返回�?」这种模糊根', () => {
    const root = clean._defaultRoot({ env: {}, homedir: 'C:\\Users\\x' });
    expect(root).toBe('C:\\');
  });
});

describe('_ageLabel �?修改时间人话', () => {
  test('分钟/小时/天三�?, () => {
    const now = Date.now();
    expect(clean._ageLabel(now - 30 * 1000, now)).toBe('刚刚');
    expect(clean._ageLabel(now - 5 * 60 * 1000, now)).toBe('5 分钟�?);
    expect(clean._ageLabel(now - 3 * 3600 * 1000, now)).toBe('3 小时�?);
    expect(clean._ageLabel(now - 2 * 24 * 3600 * 1000, now)).toBe('2 天前');
  });
});

describe('_driveCapacity �?盘容量（真实 fs�?, () => {
  const maybe = typeof fs.statfsSync === 'function' ? test : test.skip;
  maybe('返回 total > 0 �?free �?total', () => {
    const cap = clean._driveCapacity(os.tmpdir(), {});
    expect(cap).not.toBeNull();
    expect(cap.totalBytes).toBeGreaterThan(0);
    expect(cap.freeBytes).toBeGreaterThan(0);
    expect(cap.freeBytes).toBeLessThanOrEqual(cap.totalBytes);
  });
});

describe('planner.buildPlan includeIds �?点名 review 条目', () => {
  const scanResult = {
    platform: 'windows',
    driveRoots: ['C:'],
    candidates: [
      {
        id: 'win-user-temp',
        label: '用户临时目录',
        category: 'system-temp',
        safety: 'safe',
        eligible: true,
        sizeBytes: 10,
        fileCount: 1,
        drive: 'C:',
      },
      {
        id: 'win-update-cache',
        label: 'Windows 更新缓存',
        category: 'update-cache',
        safety: 'review',
        eligible: true,
        sizeBytes: 20,
        fileCount: 2,
        drive: 'C:',
      },
      {
        id: 'win-recycle-bin',
        label: '回收�?,
        category: 'recycle',
        safety: 'review',
        eligible: true,
        sizeBytes: 30,
        fileCount: 3,
        drive: 'C:',
      },
    ],
  };

  test('默认：review 全部留在 review �?, () => {
    const plan = planner.buildPlan(scanResult, {});
    expect(plan.selected.map((c) => c.id)).toBe(['win-user-temp']);
    expect(plan.review.map((c) => c.id).sort()).toBe(['win-recycle-bin', 'win-update-cache']);
  });

  test('includeIds 只放行被点名�?review 项，回收站仍�?review �?, () => {
    const plan = planner.buildPlan(scanResult, { includeIds: ['win-update-cache'] });
    expect(plan.selected.map((c) => c.id).sort()).toBe(['win-update-cache', 'win-user-temp']);
    expect(plan.review.map((c) => c.id)).toBe(['win-recycle-bin']);
    expect(plan.totals.selectedBytes).toBe(30);
  });

  test('includeIds �?includeReview 等价放行被点名项；未�?id 无副作用', () => {
    const plan = planner.buildPlan(scanResult, { includeIds: ['不存在的-id'] });
    expect(plan.selected.map((c) => c.id)).toBe(['win-user-temp']);
    expect(plan.review.length).toBe(2);
  });
});

