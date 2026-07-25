/**
 * Buddy — AI electronic pet system.
 *
 * CLI commands:
 *   buddy hatch   — Generate and name your companion
 *   buddy pet     — Pet your companion (heart animation)
 *   buddy card    — View companion stat card
 *   buddy mute    — Disable companion reactions
 *   buddy unmute  — Re-enable reactions
 *   buddy         — Show card (or prompt to hatch)
 */
'use strict';

const { rollBones, loadSoul, saveSoul, getCompanion, getUserId } = require('./companion');
const {
  renderCard, renderHeartAnimation, renderHatchAnimation,
  startAnimation, renderNarrowFallback, colorize,
} = require('./renderer');
const { RARITY_COLORS } = require('./types');

let _chalk;
function chalk() {
  if (_chalk) return _chalk;
  const m = require('chalk');
  _chalk = m.default || m;
  return _chalk;
}

/**
 * Handle /buddy CLI command.
 * @param {string} subCommand - hatch/pet/card/mute/unmute
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<boolean>}
 */
async function handleBuddyCommand(subCommand, args, options) {
  // Feature gate check
  try {
    const { isEnabled } = require('../services/featureFlags');
    if (!isEnabled('buddy')) {
      console.log(chalk().gray('Buddy feature is disabled. Set KHY_FEATURE_BUDDY=true to enable.'));
      return true;
    }
  } catch { /* featureFlags not available */ }

  const userId = getUserId();
  const c = chalk();

  switch (subCommand) {
    case 'hatch':
      return _handleHatch(userId, args, c);

    case 'pet':
      return _handlePet(userId, c);

    case 'card':
      return _handleCard(userId, c);

    case 'mute':
      return _handleMute(true, c);

    case 'unmute':
      return _handleMute(false, c);

    default: {
      // Default: show card or prompt to hatch
      const companion = getCompanion(userId);
      if (companion) {
        console.log(renderCard(companion));
      } else {
        const bones = rollBones(userId);
        console.log(c.yellow('\n  You don\'t have a companion yet!'));
        console.log(c.gray(`  Your companion awaits: a ${c.bold(bones.species.name)}...`));
        console.log(c.cyan('  Run ') + c.bold('/buddy hatch') + c.cyan(' to meet them!\n'));
      }
      return true;
    }
  }
}

// ── Sub-command Handlers ───────────────────────────────────────────

async function _handleHatch(userId, args, c) {
  const existing = loadSoul();
  if (existing) {
    console.log(c.yellow(`\n  You already have a companion: ${c.bold(existing.name)}`));
    console.log(c.gray('  Each user gets exactly one companion.\n'));
    return true;
  }

  const bones = rollBones(userId);

  console.log(c.yellow('\n  Hatching your companion...\n'));

  // Hatch animation
  try {
    await renderHatchAnimation(bones);
  } catch { /* animation failed, continue */ }

  // Get name from args or prompt
  let name = args.join(' ').trim();
  if (!name) {
    // Use readline for interactive name input
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    name = await new Promise((resolve) => {
      rl.question(c.cyan('  Give your companion a name: '), (answer) => {
        rl.close();
        resolve(answer.trim() || bones.species.name);
      });
    });
  }

  // Generate personality based on species and stats
  const personality = _generatePersonality(bones);

  // Save soul
  const soul = {
    name,
    personality,
    hatchedAt: Date.now(),
    muted: false,
  };
  saveSoul(soul);

  // Show result
  const companion = { ...soul, ...bones };
  console.log('');
  console.log(renderCard(companion));

  const shinyMsg = bones.shiny ? c.yellow(' \u2728 SHINY!!! ') : '';
  console.log(colorize(
    `  A ${bones.rarity.toUpperCase()} ${bones.species.name}!${shinyMsg}`,
    bones.rarity,
  ));
  console.log(c.gray(`  "${personality}"\n`));

  return true;
}

async function _handlePet(userId, c) {
  const companion = getCompanion(userId);
  if (!companion) {
    console.log(c.gray('\n  No companion to pet. Run /buddy hatch first.\n'));
    return true;
  }

  console.log(c.cyan(`\n  Petting ${companion.name}...\n`));

  try {
    await renderHeartAnimation();
  } catch { /* animation failed */ }

  const reactions = [
    `${companion.name} purrs contentedly.`,
    `${companion.name} nuzzles your hand.`,
    `${companion.name} does a happy dance!`,
    `${companion.name} beams with joy.`,
    `${companion.name} wiggles excitedly.`,
  ];
  const msg = reactions[Math.floor(Math.random() * reactions.length)];
  console.log(c.green(`  ${msg}\n`));

  return true;
}

async function _handleCard(userId, c) {
  const companion = getCompanion(userId);
  if (!companion) {
    console.log(c.gray('\n  No companion yet. Run /buddy hatch first.\n'));
    return true;
  }

  console.log(renderCard(companion));
  return true;
}

async function _handleMute(mute, c) {
  const soul = loadSoul();
  if (!soul) {
    console.log(c.gray('\n  No companion yet. Run /buddy hatch first.\n'));
    return true;
  }

  soul.muted = mute;
  saveSoul(soul);
  console.log(c.green(`\n  Companion ${mute ? 'muted' : 'unmuted'}.\n`));
  return true;
}

// ── Personality Generator ──────────────────────────────────────────

function _generatePersonality(bones) {
  const traits = {
    duck:     ['quirky', 'loyal', 'surprisingly wise'],
    goose:    ['chaotic', 'assertive', 'surprisingly helpful'],
    cat:      ['independent', 'elegant', 'secretly caring'],
    dragon:   ['fierce', 'protective', 'ancient wisdom'],
    octopus:  ['clever', 'adaptable', 'multitasking'],
    owl:      ['wise', 'observant', 'nocturnal coding buddy'],
    penguin:  ['determined', 'social', 'cold-resistant'],
    turtle:   ['patient', 'steady', 'reliable'],
    snail:    ['methodical', 'persistent', 'detail-oriented'],
    ghost:    ['mysterious', 'phasing through bugs', 'ethereal'],
    axolotl:  ['regenerative', 'adorable', 'resilient'],
    capybara: ['chill', 'everyone\'s friend', 'zen-like'],
    cactus:   ['tough', 'low-maintenance', 'prickly but lovable'],
    robot:    ['logical', 'efficient', 'occasionally glitchy'],
    rabbit:   ['energetic', 'quick-witted', 'fluffy'],
    mushroom: ['grounded', 'spore-adic wisdom', 'growing on you'],
    jelly:    ['flowing', 'luminescent', 'going with the flow'],
    chonk:    ['round', 'powerful', 'absolute unit'],
  };

  const speciesTraits = traits[bones.species.id] || ['curious', 'friendly', 'unique'];
  const peakStat = Object.entries(bones.stats).sort((a, b) => b[1] - a[1])[0];

  return `A ${speciesTraits[0]} companion with exceptional ${peakStat[0].toLowerCase()}.`;
}

module.exports = { handleBuddyCommand };
