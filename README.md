# SR1e-3e GameBot

I maintain this fork of Nathan Hawks' SR1eGameBot for Discord games using Shadowrun First, Second, or Third Edition. It handles d6 rolls, target numbers, the Rule of 6, opposed tests, modifiers, and saved rolls.

There are also commands for initiative, ammunition, session reminders, and scene descriptions. You can prepare material in a private GM channel and send it to the game channel during play. The initiative system includes Cyberpunk 2020 and Cyberpunk RED.

[Add SR1e-3e_GameBot to your Discord server](https://discord.com/oauth2/authorize?client_id=1565396579568062634&scope=bot&permissions=85056)

Choose your server and authorize the bot. Then enter `!help` in a text channel where the bot can read and send messages.

If the bot is already running, start with [Dice Commands](#dice-commands).

- [Installation and Hosting](#installation-and-hosting)
- [Dice Commands](#dice-commands)
- [Saved Rolls](#saved-rolls)
- [Initiative](#initiative)
- [Prepared Scenes](#prepared-scenes)
- [Virtual GM Screen](#virtual-gm-screen)
- [Session Reminders](#session-reminders)
- [Ammo Tracking](#ammo-tracking)
- [Other Commands and Notes](#other-commands-and-notes)
- [Development Checks](#development-checks)
- [Legacy Data Migration](#legacy-data-migration)
- [Admin Commands](#admin-commands)
- [Credits and License](#credits-and-license)
- [Terms of Service](TERMS.md)
- [Privacy Policy](PRIVACY.md)

## Installation and Hosting

These instructions cover the maintained Node.js version of the bot.

You need Node.js, MongoDB, and a Discord bot application. You can run the bot on your own computer or a hosting service that keeps a Node.js process running. If that computer or process stops, the bot goes offline.

### 1. Install Node.js and the dependencies

Use **Node.js 24.17.0 or later in the 24.x series** and **npm 11**. The `.nvmrc` file specifies Node.js 24.22.1; `package.json` specifies npm 11.9.0.

Check your installed versions:

```sh
node --version
npm --version
```

Download or clone this repository, open a terminal in the bot's directory, and install the dependencies:

```sh
npm ci --ignore-scripts
```

Keep `package-lock.json` in the repository. npm builds `node_modules` during installation, so leave that directory out of GitHub and don't reuse an old copy.

### 2. Configure MongoDB and encryption

The MongoDB database is named `sr1egamebot`. Require authentication and limit connections to the bot's machine or a trusted private network.

Set the following environment variables on the machine running the bot:

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Your MongoDB connection string. |
| `CRYPTO_KEY_HEX` | An encryption key containing exactly 64 hexadecimal characters, representing 32 bytes. |
| `CRYPTO_IV_HEX` | An encryption vector containing exactly 32 hexadecimal characters, representing 16 bytes. |

A typical MongoDB connection string is:

```text
mongodb://USERNAME:PASSWORD@HOST:PORT/sr1egamebot
```

If your username or password contains special characters, URI-encode them. A provider-supplied `mongodb+srv://` address also works.

For a **new database only**, generate the encryption values with:

```sh
node -e "const c=require('node:crypto');console.log('CRYPTO_KEY_HEX='+c.randomBytes(32).toString('hex'));console.log('CRYPTO_IV_HEX='+c.randomBytes(16).toString('hex'))"
```

Put each value into its matching environment variable, and keep a private backup with your database recovery information.

**If the database already contains saved data, keep its original encryption key and vector. Changing either one can make that data unreadable.**

You can configure the bot entirely through environment variables when `config.js` is absent. In that case, it reads the variables through `config.example.js`.

If you have a local `config.js`, the bot uses it first. It must export `{config}` with these properties:

- `dbUrl`: the MongoDB connection string.
- `cryptoKey`: a 32-byte `Buffer`.
- `cryptoVector`: a 16-byte `Buffer`.

You can copy `config.example.js` to `config.js` if you prefer a local configuration file that reads the same environment variables. The older `make-crypto-vars.js` helper writes Buffer assignments to `crypto-vars.txt`.

**Never commit your database credentials, encryption values, `config.js`, or `crypto-vars.txt` to a public repository.**

### 3. Set up your Discord application

Create a bot application, or open an existing one, in the [Discord Developer Portal](https://discord.com/developers/applications).

On the **Bot** page, turn on **Message Content Intent**. GameBot reads `!` commands from messages, so this setting is required.

Set **`TOKEN`** to your Discord bot token. Enter the token alone, with no JSON, quotation marks, or `Bot ` prefix. Use uppercase `TOKEN` for the variable name.

If you're hosting locally, you can use `discordauth.json` beside `main.js` instead:

```json
{
  "token": "YOUR_BOT_TOKEN"
}
```

`TOKEN` takes precedence over `discordauth.json`. If `TOKEN` is present but empty or malformed, the bot won't start, even if the JSON file has a valid token.

**Keep the token private.** Never commit it to GitHub or show it in a screenshot.

### 4. Invite your bot to the server

In the Developer Portal, open **OAuth2 URL Generator** and select the `bot` scope. Give the bot these permissions in the channels where it will be used:

- View Channels
- Send Messages
- Add Reactions
- Read Message History

Use the generated invitation link to add the bot to your server. Check its role and channel permissions, including access to any private GM channel.

GameBot uses prefix commands, so you don't need an Interactions Endpoint URL.

### 5. Start the bot

In the bot's directory, run:

```sh
npm start
```

You can also start it with `node main.js`.

At startup, GameBot checks its configuration, connects to MongoDB, loads stored data, and logs in to Discord. It restores saved reminders once Discord is ready.

Check the logs for successful database and Discord connections. Then enter this in a channel where the bot has access:

```text
!5
```

For hosted installations, run GameBot as a continuously running **worker**. The included `Procfile` uses:

```text
worker: node main.js
```

GameBot connects out to Discord. It doesn't run a website or expose an HTTP health-check endpoint.

## Dice Commands

All commands start with `!`. Capitalization doesn't matter.

Dice commands accept up to **100 dice per pool**, including the opponent's pool, and **10 rolls per command**. Invalid dice counts are rejected before any dice are rolled.

### Basic rolls

| Command | Result |
| --- | --- |
| `!5` | Roll 5d6 without the Rule of 6. |
| `!6t` | Roll 6d6 and add the results together. |
| `!6t -5` | Roll 6d6, total the results, and subtract 5. |
| `!6t +3` | Roll 6d6, total the results, and add 3. |
| `!5!` | Roll 5d6 with the Rule of 6. |
| `!5 tn4` | Roll 5d6 against target number 4 without the Rule of 6. |
| `!5! tn4` | Roll 5d6 against target number 4 with the Rule of 6. |

Change the numbers to suit the roll. Put a second `!` after the dice count when you want the Rule of 6.

### Opposed tests

```text
!A! tnB vsX! otnY
```

- `A`: your dice pool.
- `B`: your target number.
- `X`: the opponent's dice pool.
- `Y`: the opponent's target number.

The Rule of 6 is set separately for each side. Add `!` after either dice count to enable it.

Example:

```text
!5! tn3 vs6! otn4
```

Your five dice roll against TN 3; the opponent's six dice roll against TN 4. Both use the Rule of 6.

### Multiple rolls

Use semicolons to put several rolls in one command:

```text
!1 ; 2t ; 3! ; 4t +5
```

Only the first roll needs `!` at the beginning. A semicolon inside a note starts another roll, so don't use one for ordinary punctuation.

### Notes

Put a note after the dice command if you want to label the roll. You can place the target number before, within, or after the note:

```text
!3! TN4 resist wagemage sorcery
!3! resist wagemage sorcery TN4
!3! resist TN4 wagemage sorcery
```

All three forms work. The dice command must come first; this form won't work:

```text
resist wagemage sorcery !3! TN4
```

### Rerolls

Use the dice reaction on a recent roll to roll it again. To reroll a second time, remove your reaction and add it again.

Dice reactions work on dice commands and `!roll` saved rolls. They cannot repeat settings or deletion commands.

Rerolls aren't restricted to the player who made the original roll.

## Saved Rolls

Give a frequently used roll a name and call it up later:

| Command | Action |
| --- | --- |
| `!save name dice_command` | Create or replace a saved roll. Leave off the dice command's opening `!`. |
| `!roll name` | Roll the saved macro. |
| `!lm` | List your saved macros for the current channel. |
| `!removemacro name` or `!rmm name` | Remove a saved macro. |

Example:

```text
!save pistols 5! tn4
!roll pistols
```

## Initiative

### Player setup

Select the GM for your game, then save your initiative dice and modifier:

```text
!setgm @YourGM
!setinit 1 4
```

Here, `!setinit 1 4` means 1d6 + 4. Cyberpunk initiative uses d10s, although the stored formula may still be displayed as d6s.

Choose the GM from Discord's mention menu. An ordinary typed name without a linked mention won't work.

### GM setup

```text
!setgm
!setplayers @Player1 @Player2
!setnpcinits 1 5 thug 2 7 lieutenant
```

Run `!setgm` without a mention to identify yourself as GM. Then add the player list and any NPC initiative formulas.

### Roll initiative

| Command | System |
| --- | --- |
| `!init` | Shadowrun First Edition. |
| `!initflip` | Shadowrun First Edition, reversed order. |
| `!init2` | Shadowrun Second Edition. |
| `!init2flip` | Shadowrun Second Edition, reversed order. |
| `!init3` | Shadowrun Third Edition. |
| `!init3flip` | Shadowrun Third Edition, reversed order. |
| `!initcp` | Cyberpunk 2020. |
| `!initcpr` | Cyberpunk RED. |

Initiative settings are saved until you change them.

The setup belongs to a particular **GM and channel**. Set it up again if you move to another channel. Several GMs can use the same channel, but players changing groups must select the correct GM and enter their settings again. Separate channels are preferable for simultaneous games.

### Initiative commands

| Full command | Shortcut | Arguments |
| --- | --- | --- |
| `!setgm` | — | `@someone`, or no mention to select yourself. |
| `!setinit` | `!si` | `dice modifier` |
| `!setplayers` | `!setp` | `@Player1 @Player2 ...` |
| `!addplayers` | `!addp` | `@Player1 @Player2 ...` |
| `!listplayers` | `!lp` | None. |
| `!removeplayers` | `!rmp` | `@Player1 @Player2 ...` |
| `!clearplayers` | `!clrp` | None. |
| `!setnpcinits` | `!setn` | `dice modifier label`, repeated for each NPC. |
| `!addnpcinits` | `!addn` | `dice modifier label`, repeated for each NPC. |
| `!listnpcinits` | `!ln` | None. |
| `!removenpcinits` | `!rmn` | `label1 label2 ...` |
| `!clearnpcinits` | `!clrn` | None. |

### NPCs

Enter each NPC as:

```text
dice modifier label
```

Example:

```text
!addnpcinits 1 5 thug1 1 5 thug2 2 7 lieutenant
```

NPC labels can't contain spaces or commas. Use a different label for each NPC so you can remove the correct entry later.

Remove an NPC with:

```text
!removenpcinits thug1
```

If several entries have the same label, include the full formula to identify the one you want:

```text
!removenpcinits 1 5 thug
```

## Prepared Scenes

Write scene descriptions ahead of the session and store them in the bot. When the scene comes up, send the description to the game channel. A scene can also have a music link.

### Create or update a scene

```text
!setscene name sceneText
```

To include music:

```text
!setscene name musicLink sceneText
```

Example:

```text
!setscene ambush The loading-bay door rises. Three armed figures are waiting on the other side.
```

Put the music link between the scene name and its description. You can use line breaks and Discord formatting in scene text, subject to Discord's message-length limits.

### Send a scene

```text
!getscene ambush
```

The players receive the scene description and its music link, if one was saved. The scene's stored name isn't included.

### List or delete scenes

```text
!listscenes
!delscene ambush
```

`!listscenes` lists scenes for the current channel. If you're using the GM screen, it lists scenes for the linked game channel.

You can delete several scenes at once:

```text
!delscene ambush arrival meeting
```

**Scene deletion is permanent.**

## Virtual GM Screen

A private GM channel lets you prepare material without posting it where players can see it. The setup works with the scene, initiative, ammunition, and reminder commands.

1. Create a channel your players cannot view. Give the bot access to it.
2. In that private channel, run `!setchannel #game-channel`.
3. Select the game channel through Discord's channel-mention menu so the reference is linked.
4. Prepare your material in the private channel.

Players must still use `!setgm` and `!setinit` in the game channel.

`!getscene` posts the prepared scene to the linked game channel. You can set up NPC initiative behind the screen, then roll in the game channel. Running initiative in the private channel keeps the result private.

The in-Discord instructions are available through `!help gmscreen`.

## Session Reminders

GameBot can DM players before a scheduled session.

```text
!addreminder sessionDateAndTime timer1 timer2 ...
```

Use this date-and-time format:

```text
YYYY-MM-DDTHH:MMZ
```

Times use a 24-hour clock. `Z` means UTC (GMT+0). Without a time-zone suffix, JavaScript interprets the time using the host computer's local time zone. Include `Z` if you want the scheduled time to be unambiguous.

Each timer tells the bot how early to send a reminder:

| Timer | Reminder time |
| --- | --- |
| `10m` | Ten minutes before the session. |
| `3h` | Three hours before the session. |
| `7d` | Seven days before the session. |

Example:

```text
!addreminder 2027-05-04T18:00Z 30m 6h 1d 3d 7d
```

This example schedules the May 4, 2027 session for 18:00 UTC and sends five reminders.

The recipient list is taken from your saved players **when you create the reminder**. Set the list with `!setplayers` or add players with `!addplayers` before scheduling.

### List reminders

```text
!listreminders
```

The list shows reminder IDs and recipients. Long lists may be split across multiple Discord messages.

### Cancel reminders

```text
!cancelreminder id1 id2
```

Use the reminder IDs returned by `!listreminders`.

## Ammo Tracking

Ammo tracking stores weapon capacity, compatible ammunition, and maximum rate of fire. Enter the values from the rules and weapon you're using.

### Add a weapon

```text
!ammo addgun name maxROF ammoContainerType ammoCapacity ammoTypes
```

Example:

```text
!ammo addgun uzi3 7 clip 16 slug
```

Here, `uzi3` has a maximum rate of fire of 7, holds a 16-round clip, and accepts `slug` ammunition.

Weapon names can't contain spaces or commas. Choose a short name; you'll need it whenever you fire or reload. Separate multiple ammunition types with spaces.

### Remove a weapon

```text
!ammo delgun uzi3
```

### Add ammunition

```text
!ammo addammo qtyContainers containerType qtyRounds roundType maxRounds
```

Example:

```text
!ammo addammo 10 clip 16 slug 16
```

This stores ten clips with sixteen slug rounds in each. The container type, ammunition type, and capacity must match the weapon.

### Remove ammunition

```text
!ammo delammo qtyContainers containerType qtyRounds roundType maxRounds
```

Example:

```text
!ammo delammo 4 clip 16 slug 16
```

This removes four matching clips from the inventory.

### List weapons and ammunition

```text
!ammo list
```

`!ammo list` shows the weapons, their loaded ammunition, and what's left in inventory. It doesn't list empty clips; you'll need to track those yourself.

### Fire

```text
!ammo fire weaponName nbrShots
```

Example:

```text
!ammo fire uzi3 3
```

The bot subtracts the rounds fired, up to the weapon's maximum rate of fire. If you request more shots than remain loaded, it fires the remaining rounds and reports the actual number fired.

### Reload

```text
!ammo reload weaponName
```

Example:

```text
!ammo reload uzi3
```

If more than one ammunition type fits the weapon, name the type to load:

```text
!ammo reload enfield shot
```

## Other Commands and Notes

- `!help` — list help topics.
- `!help main` — dice-command help.
- `!help init` — initiative help.
- `!skipstatus` — hide the encryption status notice on bot messages.

Command names aren't case-sensitive: `!INIT3` and `!init3` do the same thing.

## Development Checks

From the repository directory, run:

```sh
npm run check
npm test
npm audit --omit=dev --audit-level=high
```

The automated tests use stand-ins for Discord and MongoDB. They check code behavior without connecting to live services.

Before deploying, test the commands you use with a separate Discord bot and database. Restart the test bot when checking whether data survives a restart. Automated tests can't verify live credentials, channel permissions, or the outcome of an old-data migration.

## Legacy Data Migration

This applies only to older GameBot installations that saved data in Google Drive. Skip it for a new installation.

`migrate.js` imports a downloaded `UserData` archive. Back up the archive and the destination MongoDB database first. **Running the importer more than once can duplicate or damage data.** The legacy importer has not been verified here against a real migration.

1. Configure the MongoDB connection for the destination database.
2. Download the old `UserData` folder from Google Drive as a ZIP archive.
3. Rename it `UserData.zip` and put it beside `migrate.js`.
4. In the bot's directory, run:

```sh
node migrate.js
```

The importer may report fewer folders than the archive appears to contain. In a path such as `UserData/serverID/channelID/userID`, the ZIP library may count only the final directory entry.

## Admin Commands

The maintained version disables `!open`, `!showcache`, and `!clearcache`. These legacy commands can expose shared process data from other servers. No Discord account has an exception.

Manage the bot through your hosting account and database tools. Normal game commands remain available.

## Credits and License

The original SR1eGameBot was written by **Nathan Hawks (AstroMacGuffin)**. This repository is my maintained fork.

Original source: [NathanHawks/SR1eGameBot](https://github.com/NathanHawks/SR1eGameBot).

The code is provided under the **Unlicense** and dedicated to the public domain, without warranty.
