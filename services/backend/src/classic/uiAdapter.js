'use strict';

/**
 * classic/uiAdapter.js — Classic mode renderer for unified UI responses.
 *
 * Renders response objects using readline/inquirer.
 */

const inquirer = require('inquirer');

/**
 * Show info message in classic mode.
 * @param {object} response
 */
function showInfo(response) {
  const chalk = require('chalk');
  if (response.title) {
    console.log(chalk.bold(response.title));
  }
  console.log(response.message);
  if (response.details) {
    console.log(chalk.dim(JSON.stringify(response.details, null, 2)));
  }
}

/**
 * Show success message in classic mode.
 * @param {object} response
 */
function showSuccess(response) {
  const chalk = require('chalk');
  if (response.title) {
    console.log(chalk.green.bold(response.title));
  }
  console.log(chalk.green(response.message));
}

/**
 * Show error message in classic mode.
 * @param {object} response
 */
function showError(response) {
  const chalk = require('chalk');
  const prefix = response.code ? `[${response.code}] ` : '';
  if (response.title) {
    console.error(chalk.red.bold(response.title));
  }
  console.error(chalk.red(`${prefix}${response.message}`));
}

/**
 * Show confirmation dialog in classic mode.
 * @param {object} response
 * @returns {Promise<boolean>}
 */
async function showConfirm(response) {
  const chalk = require('chalk');
  const prefix = response.danger ? chalk.red('⚠ ') : '';
  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `${prefix}${response.message}`,
      default: response.default,
    },
  ]);
  return confirmed;
}

/**
 * Show list selection in classic mode.
 * @param {object} response
 * @returns {Promise<string>} Selected item id
 */
async function showList(response) {
  const { choice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'choice',
      message: response.message,
      choices: response.items.map((item) => ({
        name: item.description ? `${item.label} (${item.description})` : item.label,
        value: item.id,
        disabled: item.disabled,
      })),
      pageSize: 15,
    },
  ]);
  return choice;
}

/**
 * Show form input in classic mode.
 * @param {object} response
 * @returns {Promise<object>} Form values
 */
async function showForm(response) {
  const questions = response.fields.map((field) => ({
    type: field.type === 'password' ? 'password' : 'input',
    name: field.name,
    message: field.label + (field.required ? ' *' : ''),
    default: field.placeholder,
    validate: field.required
      ? (value) => (value ? true : `${field.label} 不能为空`)
      : undefined,
  }));
  return inquirer.prompt(questions);
}

module.exports = {
  showInfo,
  showSuccess,
  showError,
  showConfirm,
  showList,
  showForm,
};
