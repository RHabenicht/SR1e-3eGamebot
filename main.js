/*
 * Shadowrun 1e GameBot by Discord user AstroMacGuffin#1486 (Nathan Hawks)
 * https://github.com/NathanHawks/SR1eGameBot
 * Yes I do regret baking 1e into the name
 * version 0.3, yeah that sounds good
 * Released under the terms of the UnLicense. This work is in the public domain.
 * Released as-is with no warranty or claim of usability for any purpose.
 */
const {loadSettings, initializeGlobals, startBot, reportStartupFailure} = require('./startup');

async function start() {
  const {token} = loadSettings();
  const { resetCache } = require('./api');
  const { logSpam, logWrite, logError } = require('./log');
  const {handleAmmoCommand} = require('./ft_ammo');
  const {handleRollCommand} = require('./ft_dicebot');
  const {handleCheckChannelCommand, handleSetChannelCommand}
    = require('./ft_gmscreen');
  const {handleHelpCommand} = require('./ft_help');
  const {handleInitCommand, handleSetGMCommand, handleRemovePlayersCommand,
    handleClearPlayersCommand, handleSetInitCommand, handleSetNPCInitCommand,
    handleAddNPCInitCommand, handleListNPCInitCommand, handleRemoveNPCInitCommand,
    handleClearNPCInitCommand, handleListPlayersCommand, handleAddPlayersCommand,
    handleSetPlayersCommand} = require('./ft_initiative');
  const {handleSaveMacroCommand, handleRollMacroCommand, handleRemoveMacroCommand,
    handleListMacrosCommand} = require('./ft_macro');
  const {handleListRemindersCommand, handleAddReminderCommand,
    handleCancelReminderCommand} = require('./ft_reminders');
  const {handleSetSceneCommand, handleDelSceneCommand, handleGetSceneCommand,
    handleListScenesCommand} = require('./ft_scene');
  const {handleSkipStatusCommand, handleLinkCodeCommand} = require('./ft_misc');
  const {initAll, startReminders, stopReminders} = require('./init');
  const {connectDatabase, closeDatabase} = require('./db');
  const Discord = require('discord.js');
  initializeGlobals(resetCache);
  let acceptingCommands = false;

  // Connect to Discord
  global.bot = new Discord.Client({
    intents: [
      Discord.GatewayIntentBits.Guilds,
      Discord.GatewayIntentBits.GuildMessages,
      Discord.GatewayIntentBits.GuildMessageReactions,
      Discord.GatewayIntentBits.DirectMessages,
      Discord.GatewayIntentBits.MessageContent
    ],
    partials: [ Discord.Partials.Channel ]
  });
  global.bot.once(Discord.Events.ClientReady, () => {
    logWrite('Connected to Discord as ['+ global.bot.user.tag + ']');
    global.bot.user.setActivity(`!help`, { type: 2 });
  });

  // Setup reaction handler (when 🎲 UI for triggering re-roll is clicked)
  global.bot.on(Discord.Events.MessageReactionAdd, (reaction, user) => {
    if ((reaction.emoji.name == '🎲' || reaction.emoji.name == 'game_die' ||
          reaction.emoji.name == ':game_die:') && !user.bot && acceptingCommands
        && reaction.message.author && !reaction.message.author.bot
        && /^!(?:\d+[!t]?|roll)(?=\s|;|$)/i.test(reaction.message.content?.trim() || '')) {
      handleMessage(reaction.message, user)
        .catch(error => reportCommandFailure(reaction.message, error));
    }
  });

  global.bot.on(Discord.Events.Error, logError);
  global.bot.on(Discord.Events.ShardError, logError);

  global.bot.on(Discord.Events.ShardDisconnect, (message) => {
    logSpam('Disconnected.');
  });

  global.bot.on(Discord.Events.ShardReconnecting, (message) => {
    // this goes off every 30-45 seconds, kill it
    // logSpam('Reconnecting...');
  });

  global.bot.on(Discord.Events.ShardResume, (message) => {
    // same issue as reconnecting event
    // logSpam('Reconnected.');
  });

  async function reportCommandFailure(msg, error) {
    if (error) logError(error);
    try {
      await msg.reply('Something went wrong. Please try your command again. '
        + "If it keeps happening, contact this bot's maintainer.");
    } catch (replyError) {
      logError(replyError);
    }
  }

  // @ =========== HANDLEMESSAGE FUNCTION ============
  async function handleMessage(msg, user=msg.author) {
    if (typeof msg.content !== 'string') return;
    // check if message starts with `!`
    let message = msg.content.trim();
    if (message.substring(0, 1) === '!') {
      let args = message.substring(1).split(/\s+/);
      let cmd = args[0];
      args = args.splice(1);
      cmd = cmd.toLowerCase();
      let handlerStatus;
      switch(cmd) {
        case 'help':
        case 'inithelp':
          await handleHelpCommand(msg, cmd, args);
        break;
        case 'open':
        case 'showcache':
        case 'clearcache':
          // Global cache inspection is unavailable through Discord. It can expose
          // data from unrelated servers; no Discord account receives an exception.
        break;
        case 'init':
        case 'init2':
        case 'init3':
        case 'initflip':
        case 'init2flip':
        case 'init3flip':
        case 'initcp':
        case 'initcpr':
          handlerStatus = await handleInitCommand(msg, cmd, user);
        break;
        case 'setgm':
          handlerStatus = await handleSetGMCommand(msg, args, user);
        break;
        case 'setp':
        case 'setplayers':
        case 'setplayer':
          handlerStatus = await handleSetPlayersCommand(msg, args);
        break;
        case 'addp':
        case 'addplayers':
        case 'addplayer':
          handlerStatus = await handleAddPlayersCommand(msg, args);
        break;
        case 'lp':
        case 'listplayers':
          handlerStatus = await handleListPlayersCommand(msg);
        break;
        case 'rmp':
        case 'removeplayer':
        case 'removeplayers':
          handlerStatus = await handleRemovePlayersCommand(msg, args);
        break;
        case 'clrp':
        case 'clearplayers':
          handlerStatus = await handleClearPlayersCommand(msg);
        break;
        case 'si':
        case 'seti':
        case 'setinit':
          handlerStatus = await handleSetInitCommand(msg, args);
        break;
        case 'setn':
        case 'setnpc':
        case 'setnpcs':
        case 'setnpcinits':
        case 'setnpcinit':
          handlerStatus = await handleSetNPCInitCommand(msg, args);
        break;
        case 'addn':
        case 'addnpc':
        case 'addnpcs':
        case 'addnpcinits':
        case 'addnpcinit':
          handlerStatus = await handleAddNPCInitCommand(msg, args);
        break;
        case 'ln':
        case 'listnpcs':
        case 'listnpcinits':
        case 'listnpcinit':
          handlerStatus = await handleListNPCInitCommand(msg);
        break;
        case 'rmn':
        case 'rmnpc':
        case 'rmnpcs':
        case 'removenpc':
        case 'removenpcs':
        case 'removenpcinit':
        case 'removenpcinits':
          handlerStatus = await handleRemoveNPCInitCommand(msg, args);
        break;
        case 'clrn':
        case 'clearnpcinits':
        case 'clearnpcinit':
          handlerStatus = await handleClearNPCInitCommand(msg);
        break;
        case 'save':
          handlerStatus = await handleSaveMacroCommand(msg, args);
        break;
        case 'roll':
          handlerStatus = await handleRollMacroCommand(msg, cmd, args, user);
        break;
        case 'removemacro':
        case 'rmm':
          handlerStatus = await handleRemoveMacroCommand(msg, args);
        break;
        case 'lm':
        case 'listmacros':
          handlerStatus = await handleListMacrosCommand(msg);
        break;
        case 'checkchannel':
          handlerStatus = await handleCheckChannelCommand(msg);
        break;
        case 'setchannel':
          handlerStatus = await handleSetChannelCommand(msg, args);
        break;
        case 'setscene':
          handlerStatus = await handleSetSceneCommand(msg, args);
        break;
        case 'delscene':
          handlerStatus = await handleDelSceneCommand(msg, args);
        break;
        case 'getscene':
          handlerStatus = await handleGetSceneCommand(msg, args);
        break;
        case 'listscenes':
          handlerStatus = await handleListScenesCommand(msg);
        break;
        case 'listreminders':
          handlerStatus = await handleListRemindersCommand(msg);
        break;
        case 'addreminder':
        case 'addreminders':
          handlerStatus = await handleAddReminderCommand(msg, args);
        break;
        case 'cancelreminder':
        case 'cancelreminders':
          handlerStatus = await handleCancelReminderCommand(msg, args);
        break;
        case 'ammo':
          handlerStatus = await handleAmmoCommand(msg, args);
        break;
        case 'skipstatus':
          handlerStatus = await handleSkipStatusCommand(msg);
        break;
        case 'link':
          handlerStatus = await handleLinkCodeCommand(msg, args);
        break;
        default:
          handlerStatus = await handleRollCommand(msg, cmd, args, user);
        break;
      }
      if (handlerStatus === -1) {
        logError('Command handler returned a failure status.');
        await reportCommandFailure(msg);
      }
    }
  }

  global.bot.on(Discord.Events.MessageCreate, (msg) => {
    if (acceptingCommands && !msg.author.bot) {
      handleMessage(msg).catch(error => reportCommandFailure(msg, error));
    }
  });

  return startBot({
    client: global.bot,
    token,
    connectDatabase,
    initialize: () => initAll({scheduleReminders: false}),
    afterLogin: () => {
      startReminders();
      acceptingCommands = true;
    },
    stopReminders,
    closeDatabase
  });
}

if (require.main === module) start().catch(reportStartupFailure);
module.exports = {start};
