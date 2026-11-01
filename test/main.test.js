const assert = require('node:assert/strict');
const {test} = require('node:test');
const {EventEmitter} = require('node:events');
const {setImmediate: nextTurn} = require('node:timers/promises');
const Discord = require('discord.js');
const startup = require('../startup');
const {loadModule} = require('./helpers/load-module');

function makeBot({login, roll = async () => {}, initialize = async () => {},
  handlers = {}} = {}) {
  const calls = [], errors = [], replies = [], adminCalls = [];
  let client;
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      client = this;
      this.user = {tag: 'test-bot', setActivity() {}};
    }
    async login(token) {
      calls.push('login');
      if (login) await login(token);
      this.emit(Discord.Events.ClientReady);
      return token;
    }
    destroy() { calls.push('destroy'); }
  }
  const stubs = {
    './startup': {...startup, loadSettings: () => ({token: 'test-token'})},
    'discord.js': {...Discord, Client: FakeClient},
    './api': {resetCache() {}},
    './admin': {
      openFile: () => adminCalls.push('open'),
      showCache: () => adminCalls.push('showcache'),
      clearCache: () => adminCalls.push('clearcache')
    },
    './log': {logWrite() {}, logSpam() {}, logError: error => errors.push(error)},
    './init': {
      initAll: async options => {
        assert.equal(options.scheduleReminders, false);
        calls.push('initialize');
        await initialize();
      },
      startReminders: () => calls.push('reminders'),
      stopReminders: () => calls.push('stop-reminders')
    },
    './db': {connectDatabase: async () => calls.push('connect'),
      closeDatabase: async () => calls.push('close')},
    './ft_dicebot': {handleRollCommand: roll}
  };
  for (const file of ['ft_ammo', 'ft_gmscreen', 'ft_help', 'ft_initiative',
    'ft_macro', 'ft_reminders', 'ft_scene', 'ft_misc']) {
    stubs[`./${file}`] = handlers[file] || {};
  }
  const {exports} = loadModule('main.js', stubs);
  const message = {content: '!3', author: {id: 'player', bot: false},
    reply: async value => replies.push(value)};
  return {start: exports.start, get client() { return client; }, calls, errors, replies,
    adminCalls, message};
}

test('does not connect merely by importing the main module', () => {
  const bot = makeBot();
  assert.equal(bot.client, undefined);
  assert.deepEqual(bot.calls, []);
});

test('ignores commands until login succeeds, then enables commands and saved reminders', async () => {
  let releaseLogin;
  let rolls = 0;
  const bot = makeBot({login: () => new Promise(resolve => { releaseLogin = resolve; }),
    roll: async () => { rolls++; }});
  const starting = bot.start();
  await nextTurn();
  bot.client.emit(Discord.Events.MessageCreate, bot.message);
  assert.equal(rolls, 0);
  assert.deepEqual(bot.calls, ['connect', 'initialize', 'login']);
  releaseLogin();
  await starting;
  bot.client.emit(Discord.Events.MessageCreate, bot.message);
  await nextTurn();
  assert.equal(rolls, 1);
  assert.deepEqual(bot.calls, ['connect', 'initialize', 'login', 'reminders']);
});

test('awaits asynchronous command status before sending the failure response', async () => {
  const bot = makeBot({roll: async () => { await nextTurn(); return -1; }});
  await bot.start();
  bot.client.emit(Discord.Events.MessageCreate, bot.message);
  await nextTurn();
  await nextTurn();
  assert.equal(bot.replies.length, 1);
  assert.match(bot.replies[0], /Something went wrong/);
  assert.doesNotMatch(bot.replies[0], /NathanHawks|args:|cmd:/);
});

test('handles rejected asynchronous commands without an unhandled rejection', async () => {
  const failure = new Error('command failed');
  const bot = makeBot({roll: async () => { throw failure; }});
  await bot.start();
  bot.client.emit(Discord.Events.MessageCreate, bot.message);
  await nextTurn();
  assert.deepEqual(bot.errors, [failure]);
  assert.equal(bot.replies.length, 1);
  assert.match(bot.replies[0], /Something went wrong/);
});

test('a failure response does not repeat command arguments or internal errors', async () => {
  const failure = new Error('private connection details');
  const bot = makeBot({roll: async () => { throw failure; }});
  await bot.start();
  bot.client.emit(Discord.Events.MessageCreate,
    {...bot.message, content: '!3 private-command-note'});
  await nextTurn();
  assert.equal(bot.replies.length, 1);
  assert.doesNotMatch(bot.replies[0], /private-command-note|private connection details/);
});

test('a rejected failure reply is logged without trying to reply again', async () => {
  const failure = new Error('command failed');
  const replyFailure = new Error('cannot send messages');
  const bot = makeBot({roll: async () => { throw failure; }});
  await bot.start();
  let attempts = 0;
  bot.client.emit(Discord.Events.MessageCreate, {...bot.message, reply: async () => {
    attempts++;
    throw replyFailure;
  }});
  await nextTurn();
  assert.equal(attempts, 1);
  assert.deepEqual(bot.errors, [failure, replyFailure]);
});

test('command arguments tolerate repeated spaces and tabs', async () => {
  const inputs = [];
  const bot = makeBot({handlers: {ft_macro: {
    handleRollMacroCommand: async (_msg, _cmd, args) => inputs.push(Array.from(args))
  }}});
  await bot.start();
  bot.client.emit(Discord.Events.MessageCreate,
    {...bot.message, content: '!roll\t  dodge  '});
  await nextTurn();
  assert.deepEqual(inputs, [['dodge']]);
});

test('human rerolls retain the reacting user and bot messages/reactions are ignored', async () => {
  const users = [];
  const bot = makeBot({roll: async (_msg, _cmd, _args, user) => users.push(user.id)});
  await bot.start();
  bot.client.emit(Discord.Events.MessageCreate, {...bot.message, author: {id: 'bot', bot: true}});
  const reaction = {emoji: {name: '🎲'}, message: bot.message};
  bot.client.emit(Discord.Events.MessageReactionAdd, reaction, {id: 'bot', bot: true});
  bot.client.emit(Discord.Events.MessageReactionAdd,
    {...reaction, message: {...bot.message, author: {id: 'bot', bot: true}}},
    {id: 'reroller', bot: false});
  bot.client.emit(Discord.Events.MessageReactionAdd, reaction, {id: 'reroller', bot: false});
  await nextTurn();
  assert.deepEqual(users, ['reroller']);
});

test('dice reactions cannot repeat settings or deletion commands', async () => {
  const calls = [];
  const bot = makeBot({handlers: {
    ft_initiative: {handleSetPlayersCommand: async () => calls.push('setplayers')},
    ft_macro: {handleRemoveMacroCommand: async () => calls.push('rmm')},
    ft_scene: {handleDelSceneCommand: async () => calls.push('delscene')}
  }});
  await bot.start();
  for (const command of ['!setplayers <@player>', '!rmm dodge', '!delscene warehouse']) {
    const message = {...bot.message, content: command};
    bot.client.emit(Discord.Events.MessageCreate, message);
    bot.client.emit(Discord.Events.MessageReactionAdd,
      {emoji: {name: '🎲'}, message}, {id: 'other-player', bot: false});
  }
  await nextTurn();
  assert.deepEqual(calls, ['setplayers', 'rmm', 'delscene']);
});

test('dice reactions still repeat saved rolls for the reacting player', async () => {
  const users = [];
  const bot = makeBot({handlers: {ft_macro: {
    handleRollMacroCommand: async (_msg, _cmd, _args, user) => users.push(user.id)
  }}});
  await bot.start();
  bot.client.emit(Discord.Events.MessageReactionAdd,
    {emoji: {name: '🎲'}, message: {...bot.message, content: '!roll dodge'}},
    {id: 'reroller', bot: false});
  await nextTurn();
  assert.deepEqual(users, ['reroller']);
});

test('legacy global-data admin commands cannot be invoked by messages or reactions', async () => {
  const bot = makeBot();
  await bot.start();
  for (const id of ['360086569778020352', 'ordinary-player']) {
    const user = {id, bot: false};
    for (const command of ['open', 'showcache', 'clearcache']) {
      const message = {...bot.message, content: `!${command} example-file`, author: user};
      bot.client.emit(Discord.Events.MessageCreate, message);
      bot.client.emit(Discord.Events.MessageReactionAdd,
        {emoji: {name: '🎲'}, message}, user);
    }
  }
  await nextTurn();
  assert.deepEqual(bot.adminCalls, []);
  assert.deepEqual(bot.errors, []);
  assert.deepEqual(bot.replies, []);
});

test('failed login closes resources and leaves command handlers inactive', async () => {
  let rolls = 0;
  const bot = makeBot({login: async () => { throw new Error('invalid token'); },
    roll: async () => { rolls++; }});
  await assert.rejects(bot.start(), /Discord login failed/);
  bot.client.emit(Discord.Events.MessageCreate, bot.message);
  assert.equal(rolls, 0);
  assert.deepEqual(bot.calls.slice(-3), ['stop-reminders', 'destroy', 'close']);
});
