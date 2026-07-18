'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const quickTaskService = require('../../src/services/quickTaskService');

function listFilesRecursive(rootDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(rootDir);
  return files;
}

describe('quickTaskService', () => {
  test('organizes desktop by categories without deleting files', () => {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-quick-desktop-'));
    try {
      fs.writeFileSync(path.join(desktopDir, 'notes.txt'), 'n');
      fs.writeFileSync(path.join(desktopDir, 'photo.jpg'), 'i');
      fs.writeFileSync(path.join(desktopDir, 'archive.zip'), 'z');

      const beforeFiles = listFilesRecursive(desktopDir).map(p => path.basename(p)).sort();
      const plan = quickTaskService.detectQuickTask('请帮我整理桌面，只分类不删除', { desktopDir });
      expect(plan).toBeTruthy();
      expect(plan.type).toBe('desktop_organize');
      expect(plan.noDelete).toBe(true);

      const statusEvents = [];
      const result = quickTaskService.executeQuickTask(plan, {
        onStatus: (evt) => statusEvents.push(evt),
      });
      expect(result.success).toBe(true);
      expect(result.stats.scanned).toBe(3);
      expect(result.stats.moved).toBe(3);
      expect(result.stats.failed).toBe(0);

      const afterFiles = listFilesRecursive(desktopDir).map(p => path.basename(p)).sort();
      expect(afterFiles).toEqual(beforeFiles);

      expect(fs.existsSync(path.join(desktopDir, 'KHY-Documents', 'notes.txt'))).toBe(true);
      expect(fs.existsSync(path.join(desktopDir, 'KHY-Images', 'photo.jpg'))).toBe(true);
      expect(fs.existsSync(path.join(desktopDir, 'KHY-Archives', 'archive.zip'))).toBe(true);
      expect(statusEvents.length).toBeGreaterThan(0);
    } finally {
      try { fs.rmSync(desktopDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('creates file and folder quickly for simple creation intent', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-quick-create-'));
    try {
      const plan = quickTaskService.detectQuickTask('创建文件 notes.txt 和 文件夹 reports', { cwd });
      expect(plan).toBeTruthy();
      expect(plan.type).toBe('create_entries');

      const result = quickTaskService.executeQuickTask(plan, { cwd });
      expect(result.success).toBe(true);

      const fileItem = result.created.find(item => item.kind === 'file');
      const folderItem = result.created.find(item => item.kind === 'folder');
      expect(fileItem).toBeTruthy();
      expect(folderItem).toBeTruthy();
      expect(fs.existsSync(fileItem.path)).toBe(true);
      expect(fs.existsSync(folderItem.path)).toBe(true);
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('uses safe defaults when creation intent has no explicit names', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-quick-create-default-'));
    try {
      const plan = quickTaskService.detectQuickTask('创建一个文件与文件夹', { cwd });
      expect(plan).toBeTruthy();
      expect(plan.fileName).toBe('quick_note.txt');
      expect(plan.folderName).toBe('quick_folder');

      const result = quickTaskService.executeQuickTask(plan, { cwd });
      expect(result.success).toBe(true);
      expect(result.created.some(item => item.kind === 'file')).toBe(true);
      expect(result.created.some(item => item.kind === 'folder')).toBe(true);
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('does not hijack desktop requests that explicitly ask deletion', () => {
    const plan = quickTaskService.detectQuickTask('请整理桌面并删除所有文件');
    expect(plan).toBeNull();
  });
});
