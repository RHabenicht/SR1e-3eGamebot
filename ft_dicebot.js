/*
 * Shadowrun 1e GameBot by Discord user AstroMacGuffin#1486 (Nathan Hawks)
 * https://github.com/NathanHawks/SR1eGameBot
 * Yes I do regret baking 1e into the name
 * version 0.3, yeah that sounds good
 * Released under the terms of the UnLicense. This work is in the public domain.
 * Released as-is with no warranty or claim of usability for any purpose.
 */
const {
  lastChar, rollDice, getTNFromArgs, getOpposedSetupArr, getModifierFromArgs,
  addMaintenanceStatusMessage, prepRollNote, makeOpposedOutput, MAX_DICE_PER_POOL
} = require('./api');
const {logError, logWrite} = require('./log');
async function handleRollCommand(msg, cmd, args, user, override=null) {
  let numDiceInt = 0;
  // allow multiple roll commands separated by semicolon
  let cmdArr = null;
  if (override !== null) cmdArr = override.split(";");
  else cmdArr = msg.content.split(";");
  const firstCommand = cmdArr[0].trim().replace(/^!/, '').split(/\s+/)[0];
  // Keep other bots' formats, such as !3d6, separate from our numeric requests.
  const looksNumeric = /^\d/.test(firstCommand) && Number.isFinite(Number(firstCommand));
  if (!/^\d+[!t]?$/i.test(firstCommand) && !looksNumeric) return;
  if (cmdArr.length > 10) {
    await msg.reply('Use no more than 10 rolls in one command.');
    return;
  }
  // Validate the entire request before rolling, including opposed pools and macros.
  for (const section of cmdArr) {
    const [command, ...rollArgs] = section.trim().replace(/^!/, '').split(/\s+/);
    const match = /^(\d+)[!t]?$/i.exec(command);
    const [opposed, opposedCount] = getOpposedSetupArr(rollArgs);
    if (!match || !Number.isSafeInteger(Number(match[1]))
        || Number(match[1]) < 1 || Number(match[1]) > MAX_DICE_PER_POOL
        || (opposed && (!/^\d+$/.test(opposedCount)
          || !Number.isSafeInteger(Number(opposedCount))
          || Number(opposedCount) < 1 || Number(opposedCount) > MAX_DICE_PER_POOL))) {
      await msg.reply(`Each dice pool must be a whole number from 1 to ${MAX_DICE_PER_POOL}.`);
      return;
    }
  }
  let output = '';
  for (let x = 0; x < cmdArr.length; x++) {
    if (output !== '') output += `\nRoll #${x+1}: `;
    // kill preceding or trailing space before it kills my parsing
    cmdArr[x] = cmdArr[x].trim();
    args = cmdArr[x].split(/\s+/);
    cmd = args[0];
    args = args.splice(1);
    cmd = cmd.toLowerCase();
    if (cmd.substring(0, 1) === '!') cmd = cmd.substring(1);
    // SETUP: how many dice, and do we explode?
    let isTestBool = false;
    let isTotalBool = false;
    let lastchar = lastChar(cmd);
    let modifier = 0;
    if (lastchar == '!') {
      isTestBool = true;
      numDiceInt = cmd.substring(0, cmd.length-1);
    } else if (lastchar == 't') {
      isTotalBool = true;
      numDiceInt = cmd.substring(0, cmd.length-1);
      // look for a modifier
      modifier = getModifierFromArgs(args);
    }
    else {
      numDiceInt = cmd.substring(0, cmd.length);
    }

    // SETUP: was a TN given?
    let tnInt = getTNFromArgs(args);

    // SETUP: is this an opposed roll?
    let retarr = getOpposedSetupArr(args);
    let isOpposedBool = retarr[0];
    let opponentDiceInt = retarr[1];
    let opponentTNInt = retarr[2];
    let isOpposedTestBool = retarr[3];
    if (isOpposedTestBool === true && opponentTNInt === -1) {
      msg.reply(await addMaintenanceStatusMessage(msg, ":no_entry_sign: You ordered an opposed test without an "
      + "opponent TN (the **otn** option).\nExample: **!6! tn4 vs5! *otn4***"))
      .catch((e) => { logError(e); });
      return;
    }

    // SETUP: anything remaining is a note; prepare to pass it thru
    let note = prepRollNote(cmd, args, tnInt);

    // GO: Roll the bones ============================================
    retarr = rollDice(numDiceInt, isTestBool, tnInt);
    let successesInt = retarr[0];
    let rollsIntArr = retarr[1];
    // handle opposed roll
    let opponentRollsIntArr, opponentSuccessesInt;
    if (isOpposedBool) {
      let retarr = rollDice(opponentDiceInt, isOpposedTestBool, opponentTNInt);
      opponentSuccessesInt = retarr[0];
      opponentRollsIntArr = retarr[1];
    }
    // prep output and deliver it ====================================
    // handle total'd roll
    if (isTotalBool) {
      let total = 0;
      rollsIntArr.map((roll)=>{total+=roll;})
      if (modifier) total += modifier;
      output += `[Total: ${total}] | `;
    }
    if (isOpposedBool) {
      output += makeOpposedOutput(successesInt,
        opponentSuccessesInt, user, rollsIntArr, opponentRollsIntArr, note
      );
    }
    else {
      let successesFormattedString = "";
      if (successesInt > 0) {
        successesFormattedString = successesInt + ' successes ';
      }
      output += `${user}` + ', you rolled ' + successesFormattedString
      + '(' +rollsIntArr+ ') ' + note;
    }
    // end of for cmdArr loop
  }
  // avoid false positives e.g. when chatting about Astral Tabeltop dice formats
  if (numDiceInt > 0) {
    // modify output for maintenance mode status
    output = await addMaintenanceStatusMessage(msg, output);
    // post results
    await msg.channel.send(output);
    // log activity
    logWrite('🎲');
    // provide reroll ui (dice reaction)
    msg.react('🎲').catch((e) => { logError(e); });
    // no return
  }

}
module.exports = {
  handleRollCommand
}
