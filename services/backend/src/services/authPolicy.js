'use strict';

const PASSWORD_MIN_LENGTH = 6;

function normalizeLoginIdentifier(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `密码长度至少${PASSWORD_MIN_LENGTH}个字符`;
  }
  return null;
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  normalizeEmail,
  normalizeLoginIdentifier,
  validatePassword,
};
