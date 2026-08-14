/**
 * adapters/index.js — barrel export for all delivery adapters.
 */

const { BaseAdapter } = require('./baseAdapter');
const { SlackAdapter } = require('./slackAdapter');
const { NotionAdapter } = require('./notionAdapter');
const { MarkdownAdapter } = require('./markdownAdapter');
const { WebhookAdapter } = require('./webhookAdapter');
const { EmailAdapter } = require('./emailAdapter');
const { ApiAdapter } = require('./apiAdapter');
const { PromiseTimeout } = require('./promiseTimeout');

module.exports = {
  BaseAdapter,
  SlackAdapter,
  NotionAdapter,
  MarkdownAdapter,
  WebhookAdapter,
  EmailAdapter,
  ApiAdapter,
  PromiseTimeout,
};
