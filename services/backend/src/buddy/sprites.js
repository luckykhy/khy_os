/**
 * Sprites — ASCII art for 18 companion species.
 *
 * Each species has 3 frames: [idle, fidget, special].
 * Frames are 5 lines tall. Line 0 is reserved for hat overlay.
 * {E} placeholders are replaced with the companion's eye character.
 *
 * @module buddy/sprites
 */
'use strict';

const { HAT_LINES, IDLE_SEQUENCE } = require('./types');

// ── Sprite Definitions ─────────────────────────────────────────────
// Format: array of 3 frames, each frame is array of 5 strings (12 chars wide)

const SPRITE_DATA = {
  duck: [
    // Frame 0: idle
    ['            ',
     '    __      ',
     '  <({E} )___ ',
     '   (  ._>   ',
     '    `--\'    '],
    // Frame 1: fidget
    ['            ',
     '    __      ',
     '  <({E} )___ ',
     '   (  ._>   ',
     '    `--\'~   '],
    // Frame 2: special
    ['            ',
     '    __      ',
     '  <({E} )___ ',
     '   (  .__>  ',
     '    `--\'    '],
  ],

  goose: [
    ['            ',
     '    ___     ',
     '  /({E} )\\   ',
     '  | >__/   ',
     '   \\/ \\/   '],
    ['            ',
     '    ___     ',
     '  /({E} )\\   ',
     '  | >__/ ! ',
     '   \\/ \\/   '],
    ['            ',
     '   _===_   ',
     '  /({E} )\\   ',
     '  |HONK/   ',
     '   \\/ \\/   '],
  ],

  cat: [
    ['            ',
     '  /\\_/\\    ',
     ' ( {E} {E} )   ',
     '  > ^ <    ',
     '   \\_/     '],
    ['            ',
     '  /\\_/\\    ',
     ' ( {E} {E} )   ',
     '  > ^ < ~  ',
     '   \\_/     '],
    ['            ',
     '  /\\_/\\    ',
     ' ( {E} {E} )   ',
     '  > w <    ',
     '  ~\\_/~    '],
  ],

  dragon: [
    ['            ',
     '   /\\_/|   ',
     '  ({E}  {E})>  ',
     '  /|  |\\   ',
     '  ~ ~~ ~   '],
    ['            ',
     '   /\\_/|   ',
     '  ({E}  {E})>~ ',
     '  /|  |\\   ',
     '  ~ ~~ ~   '],
    ['            ',
     '  ~/\\_/|   ',
     '  ({E}  {E})>  ',
     '  /|##|\\   ',
     '  ~*~~*~   '],
  ],

  octopus: [
    ['            ',
     '   ,---.   ',
     '  ( {E} {E} )  ',
     '  /|||||\\  ',
     '  ~~~~~~~  '],
    ['            ',
     '   ,---.   ',
     '  ( {E} {E} )  ',
     '  \\|||||/  ',
     '  ~~~~~~~  '],
    ['            ',
     '   ,---.   ',
     '  ( {E} {E} )  ',
     '  /|/|\\|\\  ',
     '  ~ ~ ~ ~  '],
  ],

  owl: [
    ['            ',
     '   {{{{}   ',
     '  ({E}  {E})   ',
     '  -(  )-   ',
     '   -||-    '],
    ['            ',
     '   {{{{}   ',
     '  ({E}  {E})   ',
     ' ~-(  )-~  ',
     '   -||-    '],
    ['            ',
     '   {{{{}   ',
     '  ({E}  {E})   ',
     '  -(())-   ',
     '   -||-    '],
  ],

  penguin: [
    ['            ',
     '    (\\     ',
     '   ({E} >)   ',
     '   /( )\\   ',
     '    \\_/    '],
    ['            ',
     '    (\\     ',
     '   ({E} >)   ',
     '  ~/( )\\~  ',
     '    \\_/    '],
    ['            ',
     '    (\\     ',
     '   ({E} >)   ',
     '   /( )\\   ',
     '   _\\_/_   '],
  ],

  turtle: [
    ['            ',
     '    ___     ',
     '  _/{E}  \\_  ',
     ' |_______|',
     '   U   U   '],
    ['            ',
     '    ___     ',
     '  _/{E}  \\_  ',
     ' |_______|',
     '  U     U  '],
    ['            ',
     '    ___     ',
     '  _/{E}z \\_  ',
     ' |~~___~~|',
     '   U   U   '],
  ],

  snail: [
    ['            ',
     '    __@    ',
     '   / {E}\\   ',
     '  /____\\   ',
     ' ~~~~~~~~  '],
    ['            ',
     '    __@    ',
     '   / {E}\\   ',
     '  /____\\   ',
     '  ~~~~~~~~ '],
    ['            ',
     '    __@~   ',
     '   / {E}\\   ',
     '  /____\\   ',
     ' ~~~~~~~~~  '],
  ],

  ghost: [
    ['            ',
     '   .---.   ',
     '  | {E} {E} |  ',
     '  |  o  |  ',
     '   \\/\\/\\  '],
    ['            ',
     '   .---.   ',
     '  | {E} {E} |  ',
     '  |  o  |  ',
     '   /\\/\\/  '],
    ['            ',
     '   .~~~.   ',
     '  | {E} {E} |  ',
     '  | ~o~ |  ',
     '   \\/\\/\\  '],
  ],

  axolotl: [
    ['            ',
     '  \\(-|-)/  ',
     '  ({E}  {E})   ',
     '  <(  )>   ',
     '   ~~~~    '],
    ['            ',
     '  \\(-|-)/  ',
     '  ({E}  {E})   ',
     '  <(  )> ~ ',
     '   ~~~~    '],
    ['            ',
     '  \\(~|~)/  ',
     '  ({E}  {E})   ',
     '  <(^^)>   ',
     '   ~~~~    '],
  ],

  capybara: [
    ['            ',
     '   .---.   ',
     '  /{E}   {E}\\  ',
     '  | ~~~ |  ',
     '  \\_____/  '],
    ['            ',
     '   .---.   ',
     '  /{E}   {E}\\  ',
     '  | ~~~ |  ',
     '  \\_____/ ~'],
    ['            ',
     '  ~.---.~  ',
     '  /{E}   {E}\\  ',
     '  | ^_^ |  ',
     '  \\_____/  '],
  ],

  cactus: [
    ['            ',
     '    |      ',
     '  --|{E}--  ',
     '    |      ',
     '   ~~~     '],
    ['            ',
     '    |  ~   ',
     '  --|{E}--  ',
     '    |      ',
     '   ~~~     '],
    ['            ',
     '    | *    ',
     '  --|{E}--  ',
     '    | *    ',
     '   ~~~     '],
  ],

  robot: [
    ['            ',
     '  [=====]  ',
     '  |{E}  {E}|  ',
     '  |[===]|  ',
     '  d|   |b  '],
    ['            ',
     '  [=====]  ',
     '  |{E}  {E}|  ',
     '  |[===]|  ',
     ' d |   | b '],
    ['            ',
     '  [==+==]  ',
     '  |{E}  {E}|  ',
     '  |[!!!]|  ',
     '  d|   |b  '],
  ],

  rabbit: [
    ['            ',
     '   (\\  /)  ',
     '   ({E}{E})   ',
     '   c(  )   ',
     '    || ||   '],
    ['            ',
     '   (\\ ~/)  ',
     '   ({E}{E})   ',
     '   c(  )   ',
     '    || ||   '],
    ['            ',
     '   (\\*/)   ',
     '   ({E}{E})   ',
     '   c(^^)   ',
     '    || ||   '],
  ],

  mushroom: [
    ['            ',
     '   .-=~-.  ',
     '  ( {E} {E} )  ',
     '    | |    ',
     '    \\_/    '],
    ['            ',
     '  ~.-=~-.  ',
     '  ( {E} {E} )  ',
     '    | |    ',
     '    \\_/    '],
    ['            ',
     '   .*=~*.  ',
     '  ( {E} {E} )  ',
     '   *| |*   ',
     '    \\_/    '],
  ],

  jelly: [
    ['            ',
     '   .~~~.   ',
     '  ( {E} {E} )  ',
     '  |/|/|/|  ',
     '   ~ ~ ~   '],
    ['            ',
     '   .~~~.   ',
     '  ( {E} {E} )  ',
     '  |\\|\\|\\|  ',
     '   ~ ~ ~   '],
    ['            ',
     '  ~.~~~.~  ',
     '  ( {E} {E} )  ',
     '  *|*|*|*  ',
     '   * * *   '],
  ],

  chonk: [
    ['            ',
     '  /\\_/\\    ',
     ' ({E}   {E})  ',
     ' (  w  )   ',
     ' (_____)   '],
    ['            ',
     '  /\\_/\\    ',
     ' ({E}   {E})  ',
     ' (  w  ) ~ ',
     ' (_____)   '],
    ['            ',
     '  /\\_/\\    ',
     ' ({E}   {E})  ',
     ' (  W  )   ',
     ' (=====)   '],
  ],
};

// ── Narrow-Terminal Faces ──────────────────────────────────────────

const SPECIES_FACES = {
  duck:     (e) => `<(${e}>)`,
  goose:    (e) => `>(${e}>)`,
  cat:      (e) => `=${e}\u03C9${e}=`,   // =·ω·=
  dragon:   (e) => `<${e}~${e}>`,
  octopus:  (e) => `(${e}~${e})`,
  owl:      (e) => `({${e}${e}})`,
  penguin:  (e) => `(${e}>)`,
  turtle:   (e) => `[${e}_${e}]`,
  snail:    (e) => `@(${e})`,
  ghost:    (e) => `(${e}o${e})`,
  axolotl:  (e) => `~(${e}${e})~`,
  capybara: (e) => `(${e}__${e})`,
  cactus:   (e) => `|${e}|`,
  robot:    (e) => `[${e}${e}]`,
  rabbit:   (e) => `(\\${e}${e}/)`,
  mushroom: (e) => `(${e}.${e})`,
  jelly:    (e) => `~(${e}${e})~`,
  chonk:    (e) => `(${e} w ${e})`,
};

// ── Rendering Functions ────────────────────────────────────────────

/**
 * Render a sprite frame with eye substitution and optional hat.
 * @param {object} bones - Companion bones { species, eye, hat, rarity }
 * @param {number} frame - Frame index (0-2)
 * @returns {string[]} Array of lines
 */
function renderSprite(bones, frame = 0) {
  const speciesId = bones.species.id || bones.species;
  const frames = SPRITE_DATA[speciesId];
  if (!frames) return ['  ???  '];

  const frameIdx = Math.max(0, Math.min(frame, frames.length - 1));
  const lines = frames[frameIdx].map(line =>
    line.replace(/\{E\}/g, bones.eye)
  );

  // Hat overlay on line 0
  if (bones.hat && bones.hat !== 'none' && HAT_LINES[bones.hat]) {
    lines[0] = HAT_LINES[bones.hat];
  }

  return lines;
}

/**
 * Render narrow-terminal face for a species.
 * @param {string} speciesId
 * @param {string} eye
 * @returns {string}
 */
function renderFace(speciesId, eye) {
  const faceFn = SPECIES_FACES[speciesId];
  return faceFn ? faceFn(eye) : `(${eye}${eye})`;
}

/**
 * Get the frame index from the idle sequence at a given tick.
 * @param {number} tick
 * @returns {number} Frame index (0-2), or -1 for blink
 */
function getIdleFrame(tick) {
  return IDLE_SEQUENCE[tick % IDLE_SEQUENCE.length];
}

module.exports = {
  SPRITE_DATA,
  SPECIES_FACES,
  renderSprite,
  renderFace,
  getIdleFrame,
};
