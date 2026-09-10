const fs = require('fs');
const path = require('path');

const fileService = {
  async read(filePath) {
    if (!filePath) {
      throw new Error('读取失败：缺少文件路径');
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { path: filePath, content };
    } catch (err) {
      throw new Error(`读取文件失败 (${filePath})：${err.message}`);
    }
  },

  async write(filePath, data) {
    if (!filePath) {
      throw new Error('写入失败：缺少文件路径');
    }
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, data, 'utf-8');
      return { path: filePath, bytesWritten: Buffer.byteLength(data, 'utf-8') };
    } catch (err) {
      throw new Error(`写入文件失败 (${filePath})：${err.message}`);
    }
  },

  async list(dirPath) {
    if (!dirPath) {
      throw new Error('列出失败：缺少目录路径');
    }
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    } catch (err) {
      throw new Error(`列出目录失败 (${dirPath})：${err.message}`);
    }
  },

  async tree(dirPath, depth = 3) {
    if (!dirPath) {
      throw new Error('获取目录树失败：缺少目录路径');
    }

    function buildTree(currentPath, currentDepth) {
      if (currentDepth <= 0) return null;

      try {
        const stat = fs.statSync(currentPath);
        const node = {
          name: path.basename(currentPath),
          path: currentPath,
          isDirectory: stat.isDirectory(),
        };

        if (stat.isDirectory() && currentDepth > 1) {
          const children = fs
            .readdirSync(currentPath, { withFileTypes: true })
            .map((entry) =>
              buildTree(path.join(currentPath, entry.name), currentDepth - 1)
            )
            .filter(Boolean);
          node.children = children;
        }

        return node;
      } catch {
        return null;
      }
    }

    const root = buildTree(dirPath, depth);
    if (!root) {
      throw new Error(`无法读取目录树：${dirPath}`);
    }
    return root;
  },
};

module.exports = fileService;
