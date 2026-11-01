const assert = require('node:assert/strict');
const {test} = require('node:test');
const {loadModule} = require('./helpers/load-module');

function diceFixture(rolls) {
  const values = rolls.map(value => (value - 0.5) / 6);
  const math = Object.create(Math);
  math.random = () => {
    assert.ok(values.length, 'unexpected additional die roll');
    return values.shift();
  };
  const {exports: api} = loadModule('api.js', {
    './settings': {config: {}}, './db': {Database: {}},
    './log': {logWrite() {}, logSpam() {}, logError() {}}
  }, {Math: math});
  const {exports: dice} = loadModule('ft_dicebot.js', {
    './api': {...api, addMaintenanceStatusMessage: async (_msg, output) => output},
    './log': {logWrite() {}, logError() {}}
  });
  const messages = [], reactions = [], replies = [];
  const user = {toString: () => '<@player>'};
  const message = content => ({content, author: user,
    channel: {send: async value => messages.push(value)},
    react: async value => reactions.push(value), reply: async value => replies.push(value)});
  return {api, dice, messages, reactions, replies, user, message};
}

test('ordinary d6 success tests preserve target numbers and descending roll display', () => {
  const {api} = diceFixture([1, 4, 6]);
  const [successes, rolls] = api.rollDice(3, false, 4);
  assert.equal(successes, 2);
  assert.deepEqual(Array.from(rolls), [6, 4, 1]);
});

test('Rule of Six still explodes sixes for target numbers above six', () => {
  const {api} = diceFixture([6, 4, 2]);
  const [successes, rolls] = api.rollDice(2, true, 8);
  assert.equal(successes, 1);
  assert.deepEqual(Array.from(rolls), [10, 2]);
});

test('totalled and semicolon-separated roll commands retain output and reroll reaction', async () => {
  const fixture = diceFixture([2, 4, 1]);
  const msg = fixture.message('!2t +3; 1');
  await fixture.dice.handleRollCommand(msg, '2t', ['+3'], fixture.user);
  assert.equal(fixture.messages.length, 1);
  assert.match(fixture.messages[0], /\[Total: 9\]/);
  assert.match(fixture.messages[0], /Roll #2:.*\(1\)/);
  assert.deepEqual(fixture.reactions, ['🎲']);
});

test('opposed tests without an opponent target number return existing user guidance', async () => {
  const fixture = diceFixture([]);
  const msg = fixture.message('!2! tn4 vs2!');
  await fixture.dice.handleRollCommand(msg, '2!', ['tn4', 'vs2!'], fixture.user);
  assert.equal(fixture.messages.length, 0);
  assert.match(fixture.replies[0], /opponent TN/);
});

for (const content of ['!1000000000', '!2.5', '!1e9', '!0', '!2 vs999999999', '!1; nope']) {
  test(`rejects an invalid or oversized dice request before rolling: ${content}`, async () => {
    const f = diceFixture([]);
    await f.dice.handleRollCommand(f.message(content), '', [], f.user);
    assert.equal(f.messages.length, 0);
    assert.equal(f.replies.length, 1);
    assert.match(f.replies[0], /whole number.*1.*100/);
    assert.deepEqual(f.reactions, []);
  });
}

test('rejects excessive semicolon-separated rolls before consuming any dice', async () => {
  const f = diceFixture([]);
  const content = '!' + Array(11).fill('1').join(';');
  await f.dice.handleRollCommand(f.message(content), '1', [], f.user);
  assert.equal(f.messages.length, 0);
  assert.match(f.replies[0], /10 rolls/);
});

test('dice pools at the supported maximum still roll normally', async () => {
  const f = diceFixture(Array(100).fill(4));
  await f.dice.handleRollCommand(f.message('!100 tn4'), '100', ['tn4'], f.user);
  assert.match(f.messages[0], /100 successes/);
});

test('roll arguments accept tabs and repeated spaces', async () => {
  const f = diceFixture([4, 2]);
  await f.dice.handleRollCommand(f.message('!2t\t +3  '), '2t', ['+3'], f.user);
  assert.match(f.messages[0], /\[Total: 9\]/);
});

test('a failed result delivery rejects so the command boundary can notify the player', async () => {
  const f = diceFixture([4]);
  const failure = new Error('result delivery failed');
  const msg = f.message('!1');
  msg.channel.send = async () => { throw failure; };
  await assert.rejects(f.dice.handleRollCommand(msg, '1', [], f.user), error => error === failure);
  assert.deepEqual(f.reactions, []);
});

test('shared d6 and d10 rollers reject unsafe stored initiative pools', () => {
  const {api} = diceFixture([]);
  for (const count of [-1, 1.5, Infinity, '1000000000', 'invalid']) {
    for (const roll of [api.rollDice, api.rollD10s]) {
      assert.throws(() => roll(count, false, -1), /Dice pools must/);
    }
  }
  assert.deepEqual(Array.from(api.rollDice(0, false, -1)[1]), []);
  assert.deepEqual(Array.from(api.rollD10s(0)), []);
});

test('ordinary opposed tests still compare both pools against their own target numbers', async () => {
  const f = diceFixture([4, 1, 5, 2]);
  await f.dice.handleRollCommand(f.message('!2! tn4 vs2! otn5'), '2!', [], f.user);
  assert.match(f.messages[0], /0 net successes.*\(4,1\) vs \(5,2\)/);
  assert.deepEqual(f.replies, []);
});

test('ten semicolon-separated rolls remain supported', async () => {
  const f = diceFixture(Array(10).fill(4));
  await f.dice.handleRollCommand(f.message('!' + Array(10).fill('1').join(';')), '1', [], f.user);
  assert.match(f.messages[0], /Roll #10:/);
});

test('unknown commands and other bots dice formats stay silent', async () => {
  const f = diceFixture([]);
  for (const content of ['!ping', '!3d6', '!d20']) {
    await f.dice.handleRollCommand(f.message(content), '', [], f.user);
  }
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.replies, []);
});
