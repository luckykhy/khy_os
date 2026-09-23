'use strict';

/**
 * ilinkFileDelivery — IlinkDispatcher 的「把工具产出的文件投递到微信」职责簇。
 *
 * 从 ilinkDispatcher.js 拆出的第三簇。它回答一个问题：**SendUserFile 的产物怎么送到人手里**。
 *
 * 为什么值得单独成文件：
 *   它是一段「有副作用、有多种失败面、但**绝不能影响主流程**」的代码。三处失败各有各的
 *   应对（超限 → 报路径；发送失败 → 报路径；读取异常 → 报路径），而顶层还有一层兜底。
 *   这类「失败矩阵」密集的代码最需要独立焦点 —— 埋在主流程里时，任何一次重构都可能
 *   悄悄把某个 catch 拿掉，而后果只是「文件静默不发」。
 *
 * 契约（与拆分前逐字节同构）：
 *   - **整体 fail-soft**：任何异常都只 log.warn，绝不向上抛 —— _deliverFiles 出错
 *     不能影响后续文本回复。
 *   - **逐文件隔离**：单个文件失败仅 log.warn + 文本告知路径，不影响其余文件。
 *   - 只投递 `tool === 'SendUserFile'` 且 `result.success === true` 的条目。
 *   - 读文件前先 stat 判尺寸上限；超限不发，改报「可自取路径」。
 *
 * @param {object} deps
 * @param {object} deps.msg      入站消息（取 channelId/threadId/userId）
 * @param {*}      deps.out      _chatWithWatchdog 的返回（读 out.toolCallLog）
 * @param {object} deps.channel  IlinkChannel（sendImage / sendFile）
 * @param {Function} deps.say    (msg, text) => Promise —— 由 dispatcher 注入其 _say
 * @param {Function} deps.isImageFile (fileName) => boolean
 * @param {object} deps.defaults 常量（ILINK_MAX_FILE_SIZE_BYTES）
 * @param {object} deps.log      logger
 * @returns {Promise<void>}
 */
async function deliverFiles(deps = {}) {
  const { msg, out, channel, say, isImageFile, defaults, log } = deps;
  const fs = require('fs');
  const path = require('path');

  try {
    const logArr = out && Array.isArray(out.toolCallLog) ? out.toolCallLog : null;
    if (!logArr) {
      return;
    }
    if (!channel) {
      return;
    }
    const channelId = msg.channelId || msg.userId;
    const threadId = msg.threadId || '';

    for (const entry of logArr) {
      if (!entry || entry.tool !== 'SendUserFile') {
        continue;
      }
      const result = entry.result;
      if (!result || result.success !== true) {
        continue;
      }
      // 防御性解析文件路径:直接字段 / 则又一层 result 嵌套。
      const filePath = result.file || result.file_path || (result.result && result.result.file);
      if (!filePath) {
        continue;
      }

      const fileName = path.basename(String(filePath));
      try {
        const st = await fs.promises.stat(filePath);
        if (st.size > defaults.ILINK_MAX_FILE_SIZE_BYTES) {
          const limitMb = Math.round(defaults.ILINK_MAX_FILE_SIZE_BYTES / (1024 * 1024));
          const sizeMb = (st.size / (1024 * 1024)).toFixed(1);
          await say(
            msg,
            `📎 文件「${fileName}」太大(${sizeMb}MB,超过上限 ${limitMb}MB),暂不能直接发送。` +
              `你可以到这个路径自取:${filePath}`
          );
          continue;
        }

        const buf = await fs.promises.readFile(filePath);
        const isImage = isImageFile(fileName);
        const sendRes = isImage
          ? await channel.sendImage(channelId, buf, { threadId, fileName })
          : await channel.sendFile(channelId, buf, { threadId, fileName, fileSize: st.size });

        if (!sendRes || sendRes.ok === false) {
          const reason = (sendRes && sendRes.error) || '未知原因';
          log.warn(`ilink: 文件发送失败(${fileName}):${reason}`);
          await say(msg, `📎 文件「${fileName}」发送失败。你可以到这个路径自取:${filePath}`);
        }
      } catch (err) {
        const reason = (err && err.message) || String(err);
        log.warn(`ilink: 文件投递出错(${fileName}):${reason}`);
        await say(msg, `📎 文件「${fileName}」发送出错。你可以到这个路径自取:${filePath}`).catch(
          () => {}
        );
      }
    }
  } catch (err) {
    // 整体兼底:_deliverFiles 绝不能抛错影响后续文本回复。
    log.warn(`ilink: 文件投递环节异常(已忽略):${(err && err.message) || err}`);
  }
}

module.exports = { deliverFiles };
