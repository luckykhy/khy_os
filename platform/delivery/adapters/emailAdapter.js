/**
 * EmailAdapter — deliver content via email (SMTP).
 *
 * Uses nodemailer if available, otherwise falls back to a stub.
 *
 * Configuration:
 *   email.smtp.host     — SMTP host
 *   email.smtp.port     — SMTP port (587 for TLS, 465 for SSL)
 *   email.smtp.user     — SMTP username
 *   email.smtp.pass     — SMTP password
 *   email.from          — default From address
 */

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch {
  // nodemailer not installed — adapter will report not available
}

const { BaseAdapter } = require('./baseAdapter');
const path = require('path');

// ── Markdown → HTML (simple, inline-CSS) ──────────────────────────────

function markdownToHtml(md) {
  let html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Headings
    .replace(/^### (.+)$/gm, '<h3 style="font-size:16px;font-weight:bold;margin:16px 0 8px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:18px;font-weight:bold;margin:20px 0 10px">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:22px;font-weight:bold;margin:24px 0 12px">$1</h1>')
    // Bold & italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Code inline
    .replace(/`([^`]+)`/g, '<code style="background:#f4f4f4;padding:2px 6px;border-radius:3px;font-family:monospace">$1</code>')
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre style="background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto;font-family:monospace;font-size:13px">$2</pre>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#0066cc;text-decoration:underline">$1</a>')
    // Lists
    .replace(/^[-*]\s(.+)$/gm, '<li style="margin:4px 0">$1</li>')
    // Paragraphs
    .replace(/\n\n/g, '</p><p style="margin:12px 0;line-height:1.6">')
    // Line breaks
    .replace(/\n/g, '<br>');

  return `<div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;color:#333;line-height:1.6"><p style="margin:12px 0;line-height:1.6">${html}</p></div>`;
}

function markdownToText(md) {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*]\s/gm, '- ')
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```\w*\n?/g, '').trim())
    .trim();
}

// ── Adapter ────────────────────────────────────────────────────────────

class EmailAdapter extends BaseAdapter {
  constructor(config = {}, logger = console) {
    super(config, logger);
    this._available = !!nodemailer && !!(config.smtp || config.email?.smtp);
    this._transporter = null;
  }

  getPlatform() { return 'email'; }
  getSupportedFormats() { return ['markdown', 'html', 'text']; }

  detect() { return this._available; }

  validateConfig() {
    const smtp = this.config.smtp || this.config.email?.smtp;
    const errors = [];
    if (!nodemailer) errors.push('nodemailer package not installed (run: npm install nodemailer)');
    if (!smtp) errors.push('Missing email.smtp configuration');
    if (smtp && !smtp.host) errors.push('Missing smtp.host');
    if (smtp && !smtp.user) errors.push('Missing smtp.user');
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async deliver(task) {
    if (!this._available) {
      return this.buildResult(false, {
        error: 'smtp_not_configured',
        message: 'Email adapter not available. Install nodemailer and configure SMTP.',
      });
    }

    const to = Array.isArray(task.to) ? task.to : String(task.to || '').split(',').map((s) => s.trim());
    const subject = task.subject || 'No Subject';
    const bodyMd = task.body || task.text || '';

    if (!to.length || !to[0]) {
      return this.buildResult(false, { error: 'invalid_recipient', message: 'No recipient specified.' });
    }

    // Build transporter
    const smtp = this.config.smtp || this.config.email?.smtp;
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port || 587,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
    });

    const from = task.from || this.config.from || smtp.user;

    const mailOptions = {
      from,
      to: to.join(', '),
      cc: task.cc,
      bcc: task.bcc,
      subject,
      priority: task.priority || 'normal',
    };

    if (task.html !== false) {
      mailOptions.html = markdownToHtml(bodyMd);
      mailOptions.text = markdownToText(bodyMd);
    } else {
      mailOptions.text = bodyMd;
    }

    // Attachments
    if (task.attachments && task.attachments.length > 0) {
      mailOptions.attachments = task.attachments.map((att) => {
        if (att.path && require('fs').existsSync(att.path)) {
          return { path: att.path, filename: att.filename || path.basename(att.path) };
        }
        this.logger.warn(`[email] Attachment not found, skipping: ${att.path}`);
        return null;
      }).filter(Boolean);
    }

    try {
      const info = await transporter.sendMail(mailOptions);
      return this.buildResult(true, {
        to,
        subject,
        message_id: info.messageId,
        attachments_sent: mailOptions.attachments?.length || 0,
        size_bytes: Buffer.byteLength(bodyMd),
        response: info.response,
      });
    } catch (err) {
      return this.buildResult(false, { error: 'smtp_error', message: err.message });
    }
  }
}

module.exports = { EmailAdapter };
