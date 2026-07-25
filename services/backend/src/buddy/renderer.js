/**
 * Renderer — ANSI terminal output for buddy companion.
 *
 * Handles animated sprites, speech bubbles, heart animation,
 * stat cards, hatch animation, and narrow terminal fallback.
 * Uses raw ANSI escape codes + chalk for coloring.
 */
'use strict';

const { RARITY_COLORS, RARITY_STARS, STAT_NAMES, ANIMATION, NARROW_THRESHOLD } = require('./types');
const { renderSprite, renderFace, getIdleFrame } = require('./sprites');

let _chalk;
function chalk() {
  if (_chalk) return _chalk;
  const m = require('chalk');
  _chalk = m.default || m;
  return _chalk;
}

// ── ANSI Helpers ───────────────────────────────────────────────────

function moveCursorUp(n) {
  if (n > 0) process.stdout.write(`\x1b[${n}A`);
}

function clearLine() {
  process.stdout.write('\x1b[2K');
}

function hideCursor() {
  process.stdout.write('\x1b[?25l');
}

function showCursor() {
  process.stdout.write('\x1b[?25h');
}

function getTermWidth() {
  return process.stdout.columns || 80;
}

// ── Rarity Color Helper ────────────────────────────────────────────

function colorize(text, rarity) {
  const c = chalk();
  const colorName = RARITY_COLORS[rarity] || 'white';
  const colorMap = {
    gray: c.gray,
    green: c.green,
    blue: c.blue,
    magenta: c.magenta,
    yellow: c.yellow,
  };
  const fn = colorMap[colorName] || c.white;
  return fn(text);
}

function rarityStars(rarity) {
  const count = RARITY_STARS[rarity] || 1;
  return '\u2605'.repeat(count); // ★
}

// ── Speech Bubble ──────────────────────────────────────────────────

const MAX_BUBBLE_WIDTH = 30;

/**
 * Render a speech bubble around text.
 * @param {string} text
 * @param {number} ticksRemaining
 * @param {number} fadeTicks
 * @returns {string[]}
 */
function renderSpeechBubble(text, ticksRemaining, fadeTicks) {
  const c = chalk();
  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 > MAX_BUBBLE_WIDTH) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);

  const width = Math.min(MAX_BUBBLE_WIDTH, Math.max(...lines.map(l => l.length)));
  const top = '\u256D' + '\u2500'.repeat(width + 2) + '\u256E'; // ╭──╮
  const bot = '\u2570' + '\u2500'.repeat(width + 2) + '\u256F'; // ╰──╯

  const result = [top];
  for (const line of lines) {
    result.push('\u2502 ' + line.padEnd(width) + ' \u2502'); // │ text │
  }
  result.push(bot);

  // Fade effect in last ticks
  if (ticksRemaining <= fadeTicks) {
    return result.map(l => c.dim(l));
  }
  return result;
}

// ── Heart Animation ────────────────────────────────────────────────

const HEART_FRAMES = [
  '   \u2661    \u2661   ',  // ♡
  '  \u2661  \u2665   \u2661  ',  // ♡ ♥
  ' \u2665   \u2665  \u2665   ',  // ♥
  '\u2665  \u2665      \u2665 ',  // ♥ big
  '\u00B7    \u00B7   \u00B7  ',  // · fade
];

/**
 * Play heart animation (blocking, ~2.5 seconds).
 * @returns {Promise<void>}
 */
function renderHeartAnimation() {
  const c = chalk();
  return new Promise((resolve) => {
    let frame = 0;
    hideCursor();
    process.stdout.write('\n');

    const timer = setInterval(() => {
      moveCursorUp(1);
      clearLine();
      process.stdout.write(c.red(HEART_FRAMES[frame]) + '\n');
      frame++;
      if (frame >= HEART_FRAMES.length) {
        clearInterval(timer);
        moveCursorUp(1);
        clearLine();
        showCursor();
        resolve();
      }
    }, ANIMATION.PET_FRAME_MS);
  });
}

// ── Hatch Animation ────────────────────────────────────────────────

const HATCH_FRAMES = [
  ['            ',
   '    ____    ',
   '   / .. \\   ',
   '  |      |  ',
   '  \\______/  '],
  ['            ',
   '    _/\\_    ',
   '   / .. \\   ',
   '  |  ??  |  ',
   '  \\______/  '],
  ['     *      ',
   '   _/ \\_   ',
   '  /  ..  \\  ',
   '  |  !!  |  ',
   '  \\__  __/  '],
  ['   * * *    ',
   '    /  \\    ',
   '   | !! |   ',
   '  _/    \\_  ',
   '  __    __  '],
];

/**
 * Play hatch animation then reveal companion.
 * @param {object} companion
 * @returns {Promise<void>}
 */
function renderHatchAnimation(companion) {
  const c = chalk();
  return new Promise((resolve) => {
    let frame = 0;
    const totalLines = 5;
    hideCursor();

    // Print initial blank lines
    for (let i = 0; i < totalLines; i++) process.stdout.write('\n');

    const timer = setInterval(() => {
      moveCursorUp(totalLines);

      if (frame < HATCH_FRAMES.length) {
        // Egg animation
        for (const line of HATCH_FRAMES[frame]) {
          clearLine();
          process.stdout.write(c.yellow(line) + '\n');
        }
      } else {
        // Reveal companion
        const sprite = renderSprite(companion, 2); // special frame
        for (const line of sprite) {
          clearLine();
          process.stdout.write(colorize(line, companion.rarity) + '\n');
        }
        clearInterval(timer);
        showCursor();
        resolve();
      }
      frame++;
    }, 600);
  });
}

// ── Animated Sprite Loop ───────────────────────────────────────────

/**
 * Start animated sprite display. Returns stop function.
 * @param {object} companion - Full companion object
 * @returns {{ stop: () => void }}
 */
function startAnimation(companion) {
  if (!process.stdout.isTTY) {
    // Non-TTY: print static sprite
    const lines = renderSprite(companion, 0);
    console.log(lines.join('\n'));
    return { stop: () => {} };
  }

  const narrow = getTermWidth() < NARROW_THRESHOLD;
  let tick = 0;
  let lineCount = 0;
  let stopped = false;

  hideCursor();

  const timer = setInterval(() => {
    if (stopped) return;

    // Clear previous frame
    if (lineCount > 0) {
      moveCursorUp(lineCount);
    }

    if (narrow) {
      // Narrow mode: single line
      clearLine();
      const face = renderFace(companion.species.id, companion.eye);
      const name = companion.name || '???';
      const shinyTag = companion.shiny ? ' \u2728' : ''; // ✨
      process.stdout.write(
        `  ${companion.species.emoji} ${colorize(face, companion.rarity)} ${name}${shinyTag}\n`
      );
      lineCount = 1;
    } else {
      // Full sprite mode
      const frameCode = getIdleFrame(tick);
      let frame;
      let blink = false;

      if (frameCode === -1) {
        frame = 0;
        blink = true;
      } else {
        frame = frameCode;
      }

      let lines = renderSprite(companion, frame);
      if (blink) {
        lines = lines.map(l => l.replace(new RegExp(escapeRegex(companion.eye), 'g'), '-'));
      }

      // Name plate under sprite
      const name = companion.name || '???';
      const shinyTag = companion.shiny ? ' \u2728' : '';
      const namePlate = `  ${colorize(name, companion.rarity)}${shinyTag}`;

      for (const line of lines) {
        clearLine();
        process.stdout.write(colorize(line, companion.rarity) + '\n');
      }
      clearLine();
      process.stdout.write(namePlate + '\n');
      lineCount = lines.length + 1;
    }

    tick++;
  }, ANIMATION.TICK_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      showCursor();
    },
  };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Static Card Render ─────────────────────────────────────────────

/**
 * Render a companion stat card.
 * @param {object} companion
 * @returns {string}
 */
function renderCard(companion) {
  const c = chalk();
  const sep = c.gray('\u2500'.repeat(40));
  const parts = [];

  // Header
  const stars = colorize(rarityStars(companion.rarity), companion.rarity);
  const shiny = companion.shiny ? c.yellow(' \u2728 SHINY') : '';
  const species = companion.species.name || companion.species.id;
  parts.push(sep);
  parts.push(` ${companion.species.emoji}  ${c.bold(companion.name || '???')}${shiny}`);
  parts.push(`    ${colorize(companion.rarity.toUpperCase(), companion.rarity)} ${stars}  ${c.gray(species)}`);
  parts.push(sep);

  // Sprite (frame 0)
  const sprite = renderSprite(companion, 0);
  for (const line of sprite) {
    parts.push(colorize(line, companion.rarity));
  }
  parts.push('');

  // Stats
  parts.push(c.bold(' Stats:'));
  for (const stat of STAT_NAMES) {
    const val = (companion.stats && companion.stats[stat]) || 0;
    const barLen = Math.floor(val / 5);
    const bar = '\u2588'.repeat(barLen) + '\u2591'.repeat(20 - barLen); // █░
    const label = stat.padEnd(10);
    const color = val >= 70 ? c.green : val >= 40 ? c.yellow : c.red;
    parts.push(`  ${c.gray(label)} ${color(bar)} ${color(String(val).padStart(3))}`);
  }
  parts.push(sep);

  // Footer
  if (companion.personality) {
    parts.push(c.italic(` "${companion.personality}"`));
  }
  if (companion.hatchedAt) {
    const date = new Date(companion.hatchedAt).toLocaleDateString();
    parts.push(c.gray(`  Hatched: ${date}`));
  }
  parts.push(sep);

  return parts.join('\n');
}

// ── Narrow Fallback ────────────────────────────────────────────────

/**
 * Single-line narrow terminal display.
 * @param {object} companion
 * @returns {string}
 */
function renderNarrowFallback(companion) {
  const c = chalk();
  const face = renderFace(companion.species.id, companion.eye);
  const rTag = companion.rarity.charAt(0).toUpperCase();
  const shiny = companion.shiny ? '\u2728' : '';
  const stats = STAT_NAMES.map(s => {
    const v = companion.stats[s] || 0;
    return `${s.slice(0, 3)}:${v}`;
  }).join(' ');
  return `${companion.species.emoji} ${colorize(face, companion.rarity)} ${companion.name || '???'} [${rTag}] ${shiny} ${c.gray(stats)}`;
}

module.exports = {
  renderCard,
  renderSpeechBubble,
  renderHeartAnimation,
  renderHatchAnimation,
  startAnimation,
  renderNarrowFallback,
  colorize,
  rarityStars,
};
