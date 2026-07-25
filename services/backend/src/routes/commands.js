'use strict';

/**
 * Command Catalog HTTP Endpoint — 把 khy 的功能索引暴露给前端网页 UI。
 *
 * 承 goal「khyos 应把设计的功能在 TUI 与前端网页 UI 中充分暴露，不要有了功能用户
 * 却不知去哪用」：前端网页聊天把文本发给大模型、并不执行 Node CLI 路由，所以网页面
 * 无法「真执行」斜杠命令。诚实的暴露方式是提供一份**能力索引 / 参考手册**——列出
 * khy 有哪些功能、各归哪类、在 CLI/TUI 里怎么调用——而不是伪装成会执行的自动补全。
 *
 * 数据来自与 TUI `/features` 命令、后端 CLI 完全相同的 SSOT
 * (services/commandCatalog/commandCatalog.buildCommandCatalog)，三处永不漂移。
 *
 * 只读、无用户数据、无副作用 → 公开端点，不挂 authMiddleware（与静态元信息同级）。
 * 门控 KHY_COMMAND_CATALOG 关闭时返回空目录，前端据此隐藏入口。
 *
 * @module routes/commands
 */
const express = require('express');
const router = express.Router();

/**
 * GET /api/commands
 * 返回 { success, data: { categories, total, generatedBy } }。
 * 可选 ?q=<keyword> 服务端过滤（命令名/标签/描述任一命中，大小写不敏感）。
 */
router.get('/', (req, res) => {
  try {
    const { buildCommandCatalog } = require('../services/commandCatalog/commandCatalog');
    let catalog = buildCommandCatalog({}, process.env);

    const q = String((req.query && req.query.q) || '').trim().toLowerCase();
    if (q) {
      const categories = [];
      for (const cat of catalog.categories) {
        const commands = cat.commands.filter((c) =>
          c.cmd.toLowerCase().includes(q)
          || (c.label && c.label.toLowerCase().includes(q))
          || (c.desc && c.desc.toLowerCase().includes(q)));
        if (commands.length) categories.push({ ...cat, commands });
      }
      const total = categories.reduce((n, c) => n + c.commands.length, 0);
      catalog = { ...catalog, categories, total };
    }

    res.json({ success: true, data: catalog });
  } catch (error) {
    // Fail-soft：目录失败绝不 500 掉整体，返回空目录让前端优雅隐藏入口。
    res.json({
      success: true,
      data: { categories: [], total: 0, generatedBy: 'commandSchema' },
      degraded: true,
      error: error && error.message ? error.message : String(error),
    });
  }
});

module.exports = router;
