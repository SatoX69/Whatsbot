# WhatsApp Self-Bot

A modular WhatsApp self-bot built with [Baileys](https://github.com/WhiskeySockets/Baileys). It includes command and event plugins, a SQLite-backed data layer, hot reload, logging, and configurable access control.

## Features

- Modular command and event handlers
- Self-bot command processing
- SQLite database facades for users, threads, local data, messages, and command usage
- Per-thread and global prefixes
- Role-based command permissions
- Hot reload for configuration and plugins
- Message, media, group, and account API wrappers
- Logging, backups, and automated tests

## Project structure

```text
.
├── index.js
├── bot.js
├── utils.js
├── config.json
├── configCommand.json
├── configEvent.json
├── configManager.js
├── package.json
├── assets/
├── bot/
│   ├── auth-baileys/
│   └── handler/
├── database/
│   ├── models/
│   └── runtime/
├── scripts/
│   ├── cmds/
│   └── events/
└── logger/
```

## Installation

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run check
npm test
node index.js
```

On first launch, scan the displayed QR code in WhatsApp under **Linked devices → Link a device**. The session is stored in `bot/auth-baileys/`; keep this directory private and never commit it.

## Runtime globals

The runtime initializes these objects:

```js
global.config
global.db
global.client
global.utils
global.log
global.temp
```

Database facades:

```js
global.db.usersData
global.db.threadsData
global.db.localData
global.db.messagesData
global.db.commandUsage
```

`global.temp` is for short-lived state only. Use `global.utils` for shared utilities.

## Command plugins

Place command files in `scripts/cmds/`.

```js
'use strict';

module.exports = {
  config: {
    name: 'hello',
    role: 0,
    category: 'Utility',
    description: 'Say hello.',
    usage: '!hello'
  },

  async onStart({ message, event }) {
    await message.reply(`Hello ${event.senderID}`);
  }
};
```

Commands receive a normalized context containing commonly used values such as `message`, `api`, `event`, `args`, `input`, `body`, `prefix`, `client`, `config`, database facades, permission flags, and `log`. Utilities are available through `global.utils`.

Supported command settings include `name`, `aliases`, `version`, `author`, `role`, `countDown`, `category`, `description`, and `usage`. Omit `aliases` when unused; an empty array is invalid.

### Roles

| Role | Access |
|---:|---|
| `0` | Everyone |
| `1` | Group admins |
| `2` | Bot admins |
| `3` | Bot developers |

The configured bot identity and role lists are managed in `config.json`. Keep developer access restricted to trusted accounts.

## Message and API helpers

The command-facing `message` helper supports:

```js
await message.reply('Reply to the current message');
await message.send('Send without quoting');
await message.react('👍');
await message.delete();
await message.edit(undefined, 'Updated text');
```

The `api` wrapper provides messaging, media, group, presence, profile, and permission methods. Examples:

```js
await api.sendMessage('Hello', threadID, options);
await api.sendImage(source, 'Caption', threadID, options);
await api.reactMessage('👍', messageID, threadID);
await api.getGroupMetadata(threadID);
```

For Baileys-specific operations, use `api.raw` or `api.socket`.

## Normalized events

Message events expose fields such as:

```js
event.messageID
event.senderID
event.participantID
event.threadID
event.threadName
event.body
event.repliedMessageID
event.repliedMessageBody
event.repliedMessageSenderID
event.mentions
event.messageType
event.isSelf
event.isGroup
event.raw
```

The event handler normalizes incoming messages and routes supported WhatsApp events to event plugins in `scripts/events/`.

## Database

The database uses `sql.js` and stores data in SQLite.

```js
const user = global.db.usersData.get(userID);

await global.db.usersData.create(userID, {
  username: 'Example',
  data: {}
});

await global.db.usersData.refresh(userID, {
  pushName: 'Updated name'
});

await global.db.usersData.set(userID, {
  theme: 'dark',
  level: 5
});

await global.db.usersData.delete(userID);
```

Equivalent CRUD-style methods are available on `threadsData` and `localData`. User and thread records are registered or refreshed when messages reach the action handler. `messagesData` tracks message records and deletion state; `commandUsage` stores command execution metadata.

## Configuration

- `config.json` — global settings, identity, prefixes, database, runtime, and logger
- `configCommand.json` — command overrides and unloaded commands
- `configEvent.json` — event controls and unloaded events

The default prefix is `!`. The built-in `prefix` command manages global and per-thread prefixes. `adminMode` can restrict command execution to bot admins; role requirements still apply when it is disabled.

When hot reload is enabled, configuration changes and edits to command/event files are applied without a full restart.

## Built-in commands

| Command | Purpose |
|---|---|
| `!start` / `!alive` | Runtime status |
| `!ping` / `!p` | Response latency |
| `!uptime` | Process uptime |
| `!id` | Normalized event details |
| `!userinfo` / `!user` | User information |
| `!echo <text>` | Send text to the current thread |
| `!help [command]` | List commands or inspect one |
| `!admin [on\|off]` | Toggle admin mode |
| `!prefix [all] <prefix>` | Change thread or global prefix |
| `!cmd load\|unload <file>` | Manage command plugins |
| `!event load\|unload <file>` | Manage event plugins |
| `!eval <javascript>` | Execute developer-only JavaScript |
| `!pic` | Send the test image |

`!cmd`, `!event`, and `!eval` require developer access. Treat `!eval` as full access to the worker process and its filesystem.

## Event plugins

Place event files in `scripts/events/`. Each plugin exports a `config` object and an `async onEvent(context)` function. Available event families include messages, edits, deletions, reactions, group participant changes, presence, contacts, calls, and related WhatsApp events, subject to the event configuration and Baileys support.

## Testing and troubleshooting

```bash
npm run check
npm test
```

If commands do not run, check the active prefix, command loading configuration, self-bot settings, and role permissions. If a command was unloaded, restore it using `!cmd load <file>`.

To create a fresh login, stop the bot and remove `bot/auth-baileys/`, then launch it again and scan the new QR code.

## Security and compatibility

- Never publish session credentials, database files, or secrets.
- Restrict developer IDs carefully; `!eval` executes code inside the bot process.
- Baileys is an unofficial WhatsApp Web protocol library. WhatsApp changes may affect APIs and event behavior.
