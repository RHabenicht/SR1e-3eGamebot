const assert = require('node:assert/strict');
const {test} = require('node:test');
const {loadModule} = require('./helpers/load-module');

function reminder(id, options = {}) {
  return {id, shortID: id.slice(0, 6), gmID: 'gm-a', userFolderID: 'folder-a',
    playChannelID: 'play-a', timeoutID: {id}, ...options};
}

function cancellationFixture(reminders, {userFolderID = 'folder-a'} = {}) {
  const cleared = [], writes = [], replies = [], errors = [];
  const global = {reminders: [...reminders], folderID: {reminders: 'system-folder'}};
  const serialize = reminder => `${reminder.shortID},${reminder.id},${reminder.gmID},${reminder.playChannelID}`;
  const {exports: commands} = loadModule('ft_reminders.js', {
    './api': {
      addHourglass() {}, removeHourglass() {}, ensureTriplet: async () => {},
      getPlayChannel: async () => 'play-a',
      findUserFolderDBIDFromMsg: async () => userFolderID,
      _makeReminderSaveString: serialize,
      setStringByNameAndParent: async (name, parent, content) => {
        writes.push({name, parent, content});
      }
    },
    './log': {logWrite() {}, logSpam() {}, logError: error => errors.push(error)}
  }, {global, clearTimeout: timer => cleared.push(timer)});
  const msg = {author: {id: 'gm-a'}, channel: {id: 'channel-a', guild: {id: 'server-a'}},
    reply: async output => replies.push(output)};
  return {commands, global, cleared, writes, replies, errors, serialize, msg};
}

test('a player cannot cancel another GMs reminder by supplying its ID', async () => {
  const foreign = reminder('b00001-foreign', {gmID: 'gm-b', userFolderID: 'folder-b'});
  const f = cancellationFixture([foreign]);
  await f.commands.handleCancelReminderCommand(f.msg, [foreign.shortID]);
  assert.deepEqual(Array.from(f.global.reminders), [foreign]);
  assert.deepEqual(f.cleared, []);
  assert.deepEqual(f.writes, []);
  assert.match(f.replies[0], /No matching reminders/);
});

test('a GM cannot cancel reminders belonging to another play channel', async () => {
  const otherChannel = reminder('c00001-elsewhere', {playChannelID: 'play-b', userFolderID: 'folder-b'});
  const f = cancellationFixture([otherChannel]);
  await f.commands.handleCancelReminderCommand(f.msg, [otherChannel.shortID]);
  assert.deepEqual(Array.from(f.global.reminders), [otherChannel]);
  assert.deepEqual(f.cleared, []);
  assert.deepEqual(f.writes, []);
});

test('a reminder in another user folder is not cancelled even when GM and channel match', async () => {
  const otherFolder = reminder('f00001-other-folder', {userFolderID: 'another-folder'});
  const f = cancellationFixture([otherFolder]);
  await f.commands.handleCancelReminderCommand(f.msg, [otherFolder.shortID]);
  assert.deepEqual(Array.from(f.global.reminders), [otherFolder]);
  assert.deepEqual(f.writes, []);
});

test('a short-ID collision cancels only the current GMs reminder in this channel', async () => {
  const own = reminder('a00001-own');
  const otherGM = reminder('b00001-other', {shortID: own.shortID, gmID: 'gm-b', userFolderID: 'folder-b'});
  const otherChannel = reminder('c00001-other', {shortID: own.shortID, playChannelID: 'play-b'});
  const f = cancellationFixture([own, otherGM, otherChannel]);
  await f.commands.handleCancelReminderCommand(f.msg, [own.shortID]);
  assert.deepEqual(Array.from(f.global.reminders), [otherGM, otherChannel]);
  assert.deepEqual(f.cleared, [own.timeoutID]);
  assert.match(f.replies[0], /^1 reminder cancelled/);
});

test('cancellation preserves other active reminders and writes a clean current GM record', async () => {
  const own = reminder('a00001-remove');
  const keep = reminder('a00002-keep');
  const foreign = reminder('b00001-keep', {gmID: 'gm-b', userFolderID: 'folder-b'});
  const otherChannel = reminder('c00001-keep', {playChannelID: 'play-b', userFolderID: 'folder-c'});
  const f = cancellationFixture([own, keep, foreign, otherChannel]);
  await f.commands.handleCancelReminderCommand(f.msg, [own.shortID]);
  assert.deepEqual(f.writes, [
    {name: 'activeReminders', parent: 'system-folder',
      content: [keep, foreign, otherChannel].map(f.serialize).join('\n')},
    {name: 'gmReminders', parent: 'folder-a', content: f.serialize(keep)}
  ]);
});

test('duplicate and unknown IDs do not inflate the cancellation count', async () => {
  const own = reminder('a00001-own');
  const f = cancellationFixture([own]);
  await f.commands.handleCancelReminderCommand(f.msg, [own.shortID, own.shortID, 'unknown']);
  assert.deepEqual(f.cleared, [own.timeoutID]);
  assert.match(f.replies[0], /^1 reminder cancelled/);
});

test('an unknown reminder ID does not rewrite saved reminders', async () => {
  const own = reminder('a00001-own');
  const f = cancellationFixture([own]);
  await f.commands.handleCancelReminderCommand(f.msg, ['unknown']);
  assert.deepEqual(Array.from(f.global.reminders), [own]);
  assert.deepEqual(f.writes, []);
  assert.match(f.replies[0], /No matching reminders/);
});

test('a failed user-folder lookup leaves timers and saved reminders unchanged', async () => {
  const own = reminder('a00001-own');
  const f = cancellationFixture([own], {userFolderID: -1});
  const result = await f.commands.handleCancelReminderCommand(f.msg, [own.shortID]);
  assert.equal(result, -1);
  assert.deepEqual(Array.from(f.global.reminders), [own]);
  assert.deepEqual(f.cleared, []);
  assert.deepEqual(f.writes, []);
});
