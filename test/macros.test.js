const assert = require('node:assert/strict');
const {test} = require('node:test');
const {setImmediate: nextTurn} = require('node:timers/promises');
const {loadModule} = require('./helpers/load-module');

function macroFixture({saved = 'dodge 3! tn4\nspell-defense 4! tn5', roll} = {}) {
  const rolls = [], replies = [], errors = [];
  const {exports: macros} = loadModule('ft_macro.js', {
    './api': {
      addMaintenanceStatusMessage: async (_msg, output) => output,
      addHourglass() {}, removeHourglass() {}, ensureTriplet: async () => {},
      findUserFolderDBIDFromMsg: async () => 'user-folder',
      findStringIDByName: async () => saved === null ? -1 : 'saved-rolls',
      getStringContent: async () => saved
    },
    './ft_dicebot': {handleRollCommand: async (...args) => {
      rolls.push(args[4]);
      if (roll) await roll(...args);
    }},
    './log': {logWrite() {}, logSpam() {}, logError: error => errors.push(error)}
  });
  const user = {id: 'player'};
  const msg = {author: user, channel: {id: 'channel', guild: {id: 'server'}},
    reply: async output => replies.push(output)};
  return {macros, rolls, replies, errors, user, msg};
}

test('saved macro names containing d are not mistaken for Dice Maiden notation', async () => {
  const f = macroFixture();
  await f.macros.handleRollMacroCommand(f.msg, 'roll', ['dodge'], f.user);
  await f.macros.handleRollMacroCommand(f.msg, 'roll', ['spell-defense'], f.user);
  assert.deepEqual(f.rolls, ['!3! tn4', '!4! tn5']);
});

test('valid Dice Maiden notation is still ignored', async () => {
  const f = macroFixture();
  for (const notation of ['2d6', 'd20', '3D6+4', '2d6+3d4']) {
    await f.macros.handleRollMacroCommand(f.msg, 'roll', [notation], f.user);
  }
  assert.deepEqual(f.rolls, []);
  assert.deepEqual(f.replies, []);
});

test('a macro name beginning with dice-like text remains usable', async () => {
  const f = macroFixture({saved: '2d6-defense 4! tn4'});
  await f.macros.handleRollMacroCommand(f.msg, 'roll', ['2d6-defense'], f.user);
  assert.deepEqual(f.rolls, ['!4! tn4']);
});

test('a missing macro reports the unmatched name', async () => {
  const f = macroFixture();
  await f.macros.handleRollMacroCommand(f.msg, 'roll', ['pistols'], f.user);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0], /didn't match any of your saved macros/);
});

for (const saved of [null, '']) {
  test(`an ${saved === null ? 'absent' : 'empty'} macro list gives useful guidance`, async () => {
    const f = macroFixture({saved});
    await f.macros.handleRollMacroCommand(f.msg, 'roll', ['pistols'], f.user);
    assert.equal(f.replies.length, 1);
    assert.match(f.replies[0], /don't have any saved macros/);
  });
}

test('a saved roll remains pending until its dice handler completes', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = macroFixture({saved: 'pistols 3! tn4', roll: () => pending});
  let finished = false;
  const rolling = f.macros.handleRollMacroCommand(f.msg, 'roll', ['pistols'], f.user)
    .then(() => { finished = true; });
  await nextTurn();
  const finishedBeforeDice = finished;
  release();
  await rolling;
  assert.equal(finishedBeforeDice, false);
});
