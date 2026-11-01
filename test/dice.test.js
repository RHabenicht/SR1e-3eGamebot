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
    channel: {send: async value => {
      assert.ok(value.length <= 2000, 'Discord messages must fit its content limit');
      messages.push(value);
    }},
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

for (const content of ['!1001', '!1000000000', '!2.5', '!1e9', '!0', '!2 vs1001', '!2 vs999999999', '!1; nope']) {
  test(`rejects an invalid or oversized dice request before rolling: ${content}`, async () => {
    const f = diceFixture([]);
    await f.dice.handleRollCommand(f.message(content), '', [], f.user);
    assert.equal(f.messages.length, 0);
    assert.equal(f.replies.length, 1);
    assert.match(f.replies[0], /whole number.*1.*1000/);
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
  const f = diceFixture(Array(1000).fill(4));
  await f.dice.handleRollCommand(f.message('!1000 tn4'), '1000', ['tn4'], f.user);
  assert.match(f.messages.join(''), /1000 successes/);
  assert.ok(f.messages.every(message => message.length <= 2000));
});

test('880-dice rolls remain supported', async () => {
  const f = diceFixture(Array(880).fill(4));
  await f.dice.handleRollCommand(f.message('!880 tn4'), '880', ['tn4'], f.user);
  assert.match(f.messages.join(''), /880 successes/);
  assert.deepEqual(f.replies, []);
  assert.deepEqual(f.reactions, ['🎲']);
});

test('large Rule of Six results are delivered completely across bounded messages', async () => {
  const f = diceFixture(Array.from({length: 880}, () => [6, 4]).flat());
  await f.dice.handleRollCommand(f.message('!880! tn8'), '880!', ['tn8'], f.user);
  const output = f.messages.join('');
  assert.match(output, /880 successes/);
  assert.ok(output.includes('(' + Array(880).fill(10).join(',') + ')'));
  assert.ok(f.messages.length > 1);
  assert.ok(f.messages.every(message => message.length <= 2000));
});

test('opposed 880-dice pools preserve both complete result lists', async () => {
  const f = diceFixture([...Array(880).fill(4), ...Array(880).fill(2)]);
  await f.dice.handleRollCommand(f.message('!880 tn4 vs880 otn4'), '880', [], f.user);
  const output = f.messages.join('');
  assert.match(output, /880 net successes/);
  assert.ok(output.includes('(' + Array(880).fill(4).join(',') + ') vs ('
    + Array(880).fill(2).join(',') + ')'));
  assert.ok(f.messages.length > 1);
  assert.ok(f.messages.every(message => message.length <= 2000));
});

test('saved rolls can use an 880-dice pool', async () => {
  const f = diceFixture(Array(880).fill(4));
  await f.dice.handleRollCommand(f.message('!roll largepool'), '880', [], f.user, '!880 tn4');
  assert.match(f.messages.join(''), /880 successes/);
  assert.deepEqual(f.replies, []);
});

test('splitting long output preserves Unicode notes without breaking surrogate pairs', async () => {
  const f = diceFixture(Array.from({length: 880}, () => [6, 4]).flat());
  const note = '🎲'.repeat(700);
  await f.dice.handleRollCommand(f.message(`!880! tn8 ${note}`), '880!', [], f.user);
  assert.ok(f.messages.join('').includes(note));
  assert.ok(f.messages.every(message => message.length <= 2000));
  for (const message of f.messages) {
    assert.equal(/[\uD800-\uDBFF]$/.test(message), false);
    assert.equal(/^[\uDC00-\uDFFF]/.test(message), false);
  }
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
