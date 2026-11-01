const assert = require('node:assert/strict');
const {test} = require('node:test');
const {loadModule} = require('./helpers/load-module');

test('in-bot help directs players to the maintained project without the removed promotion', async () => {
  const replies = [];
  const {exports: help} = loadModule('ft_help.js', {
    './api': {addMaintenanceStatusMessage: async (_msg, output) => output},
    './log': {logError() {}}
  });
  for (const topic of ['main', 'init', 'scene', 'macros', 'gmscreen', 'reminders', 'ammo', 'troubleshoot']) {
    await help.handleHelpCommand({reply: async output => replies.push(output)}, 'help', [topic]);
  }
  const output = replies.join('\n');
  assert.doesNotMatch(output, /patreon|<@360086569778020352>|NathanHawks\/SR1eGameBot\/issues|discord\.gg\/HBDPU6k/i);
  assert.match(output, /github\.com\/RHabenicht\/SR1eGameBot/);
});
