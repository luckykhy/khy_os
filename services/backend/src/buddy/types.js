/**
 * Buddy Types — constants for the AI companion pet system.
 *
 * Defines species, rarities, eyes, hats, stats, and animation parameters.
 * All generation is deterministic per user via FNV-1a + Mulberry32 PRNG.
 */
'use strict';

// ── 18 Species ─────────────────────────────────────────────────────

const SPECIES = [
  { id: 'duck',     name: 'Duck',     emoji: '\uD83E\uDD86' },
  { id: 'goose',    name: 'Goose',    emoji: '\uD83E\uDEB6' },
  { id: 'cat',      name: 'Cat',      emoji: '\uD83D\uDC31' },
  { id: 'dragon',   name: 'Dragon',   emoji: '\uD83D\uDC09' },
  { id: 'octopus',  name: 'Octopus',  emoji: '\uD83D\uDC19' },
  { id: 'owl',      name: 'Owl',      emoji: '\uD83E\uDD89' },
  { id: 'penguin',  name: 'Penguin',  emoji: '\uD83D\uDC27' },
  { id: 'turtle',   name: 'Turtle',   emoji: '\uD83D\uDC22' },
  { id: 'snail',    name: 'Snail',    emoji: '\uD83D\uDC0C' },
  { id: 'ghost',    name: 'Ghost',    emoji: '\uD83D\uDC7B' },
  { id: 'axolotl',  name: 'Axolotl',  emoji: '\uD83E\uDD8E' },
  { id: 'capybara', name: 'Capybara', emoji: '\uD83E\uDDAB' },
  { id: 'cactus',   name: 'Cactus',   emoji: '\uD83C\uDF35' },
  { id: 'robot',    name: 'Robot',    emoji: '\uD83E\uDD16' },
  { id: 'rabbit',   name: 'Rabbit',   emoji: '\uD83D\uDC30' },
  { id: 'mushroom', name: 'Mushroom', emoji: '\uD83C\uDF44' },
  { id: 'jelly',    name: 'Jellyfish',emoji: '\uD83E\uDEBC' },
  { id: 'chonk',    name: 'Chonk Cat',emoji: '\uD83D\uDC08' },
];

// ── Rarity System ──────────────────────────────────────────────────

const RARITY_WEIGHTS = {
  common:    60,
  uncommon:  25,
  rare:      10,
  epic:       4,
  legendary:  1,
};

const RARITY_COLORS = {
  common:    'gray',
  uncommon:  'green',
  rare:      'blue',
  epic:      'magenta',
  legendary: 'yellow',
};

const RARITY_STARS = {
  common:    1,
  uncommon:  2,
  rare:      3,
  epic:      4,
  legendary: 5,
};

// Stat generation floor per rarity
const RARITY_FLOOR = {
  common:     5,
  uncommon:  15,
  rare:      25,
  epic:      35,
  legendary: 50,
};

// ── Appearance ─────────────────────────────────────────────────────

const EYES = ['\u00B7', '\u2726', '\u00D7', '\u25C9', '@', '\u00B0'];
// ·, ✦, ×, ◉, @, °

const HATS = ['none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck'];

const HAT_LINES = {
  none:      '',
  crown:     '   \\^^^/    ',
  tophat:    '   [___]    ',
  propeller: '    -+-     ',
  halo:      '   (   )    ',
  wizard:    '    /^\\     ',
  beanie:    '   (___)    ',
  tinyduck:  '    ,>      ',
};

// ── Stats ──────────────────────────────────────────────────────────

const STAT_NAMES = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK'];

// ── Animation ──────────────────────────────────────────────────────

const ANIMATION = {
  TICK_MS: 500,         // Frame rate
  BUBBLE_SHOW: 20,      // Speech bubble display ticks (~10 seconds)
  FADE_TICKS: 6,        // Fade-out window (~3 seconds)
  PET_FRAMES: 5,        // Heart animation frames
  PET_FRAME_MS: 200,    // Heart animation speed
};

const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0];
// -1 = blink (replace eyes with '-')

const NARROW_THRESHOLD = 100; // Terminal columns threshold for full sprite

const SHINY_CHANCE = 0.01;
const SALT = 'friend-2026-401';

module.exports = {
  SPECIES,
  RARITY_WEIGHTS, RARITY_COLORS, RARITY_STARS, RARITY_FLOOR,
  EYES, HATS, HAT_LINES,
  STAT_NAMES,
  ANIMATION, IDLE_SEQUENCE, NARROW_THRESHOLD,
  SHINY_CHANCE, SALT,
};
