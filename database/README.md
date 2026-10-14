# WhatsApp Bot Database

A refactored `sql.js` database layer for the WhatsApp bot with three primary data stores:

- `usersData`
- `threadsData`
- `localData`

The implementation uses one reusable `DataStore` core instead of maintaining separate CRUD implementations for every store.

## Requirements

The database layer only requires `sql.js`:

```bash
npm install sql.js
```

It does **not** require `lodash`, `moment-timezone`, `axios`, `fs-extra`, `TaskQueue`, or any `global.utils` helper.

Timestamps are stored as Unix milliseconds from `Date.now()`.

---

# 1. Initialization

```js
const { initialize } = require('./Database');

const db = await initialize({
  file: './runtime/database.sqlite',
  config: {
    database: {
      saveAfterWrite: true,
      backupKeep: 5
    }
  },
  logger
});
```

The returned object contains:

```js
const {
  usersData,
  threadsData,
  localData,
  messagesData,
  commandUsage
} = db;
```

---

# 2. Standard API shared by all three stores

The following methods are available on `usersData`, `threadsData`, and `localData`:

```text
existsSync
getSync
create
ensure
get
getAll
set
increment
decrement
getNumber
deleteKey
remove
delete
refresh
refreshInfo
```

The methods are asynchronous unless their name is explicitly `existsSync` or `getSync`.

## `existsSync(id)`

Checks whether a record exists without creating it.

```js
const exists = db.usersData.existsSync(userID);
const existsThread = db.threadsData.existsSync(threadID);
const existsLocal = db.localData.existsSync('botSettings');
```

Returns:

```js
true | false
```

This is intentionally synchronous because it only performs a local SQLite lookup.

## `getSync(id)`

Synchronous full-record lookup. It never creates a missing record and does not accept a path argument.

```js
const user = db.usersData.getSync(userID);
const thread = db.threadsData.getSync(threadID);
const settings = db.localData.getSync('botSettings');
```

It returns the complete record or `null` when the record does not exist. Use asynchronous `get()` when you want path lookup or automatic creation.

---

## `create(id, data = {})`

Creates a new record.

If the record already exists, it throws an error with name:

```text
DATA_ALREADY_EXISTS
```

### Users

```js
await db.usersData.create(userID, {
  name: 'Maher',
  money: 100,
  exp: 25,
  data: {
    level: 2
  }
});
```

### Threads

```js
await db.threadsData.create(threadID, {
  threadName: 'My Group',
  isGroup: true,
  data: {
    prefix: '!'
  }
});
```

### Local data

```js
await db.localData.create('botSettings', {
  prefix: '!',
  maintenance: false
});
```

For `localData`, the object is stored below the record's `data` property automatically.

---

## `ensure(id, defaults = {})`

Returns the existing record or creates it when it does not exist.

Unlike `create()`, calling `ensure()` repeatedly is safe.

```js
const user = await db.usersData.ensure(userID, {
  money: 0,
  exp: 0
});
```

This is useful when a message handler needs user data but does not know whether the user has already been inserted.

---

## `get(id, path?, defaultValue?, query?)`

Reads a record or a value inside it.

### Full record

```js
const user = await db.usersData.get(userID);
```

For `usersData` and `threadsData`, a missing record is automatically created with the store defaults.

For `localData`, a missing key remains missing unless `defaultValue` is supplied.

### Read a field

```js
const money = await db.usersData.get(userID, 'money', 0);
const level = await db.usersData.get(userID, 'data.level', 1);
```

### Read multiple fields

```js
const [money, exp] = await db.usersData.get(
  userID,
  ['money', 'exp'],
  [0, 0]
);
```

### `localData` paths

`localData` makes its payload convenient to access. These are equivalent:

```js
await db.localData.get('botSettings', 'prefix', '!');
await db.localData.get('botSettings', 'data.prefix', '!');
```

### Default creation for `localData`

```js
const prefix = await db.localData.get(
  'botSettings',
  'prefix',
  '!'
);
```

When `botSettings` does not exist, the key is created and `data.prefix` becomes `!`.

### Query function

The optional final argument may be a function that transforms the returned record before the selected path is read.

```js
const result = await db.usersData.get(
  userID,
  undefined,
  undefined,
  user => ({
    id: user.userID,
    money: user.money
  })
);
```

The database does not depend on the old project's `fakeGraphql` implementation.

---

## `getAll(path?, defaultValue?, query?)`

Returns all records, optionally reduced to a path.

```js
const users = await db.usersData.getAll();
const money = await db.usersData.getAll('money', 0);
```

Multiple paths:

```js
const result = await db.usersData.getAll(
  ['userID', 'money'],
  [null, 0]
);
```

Query transformation:

```js
const names = await db.usersData.getAll(
  'name',
  null,
  user => user.name
);
```

For `localData`:

```js
const prefixes = await db.localData.getAll('prefix', '!');
```

Here `prefix` is automatically interpreted as `data.prefix`.

---

## `set(id, updateData, path?, query?)`

Updates data and returns the complete updated record.

There are two forms.

### Object form

```js
await db.usersData.set(userID, {
  name: 'New Name',
  money: 500,
  data: {
    level: 10
  }
});
```

Known SQL fields are updated directly. Unknown top-level fields are placed inside `data`.

For example:

```js
await db.usersData.set(userID, {
  inventory: {
    bread: 5,
    potion: 2
  }
});
```

stores the inventory as:

```js
user.data.inventory
```

### Path form

```js
await db.usersData.set(userID, 500, 'money');
await db.usersData.set(userID, 10, 'data.level');
await db.usersData.set(userID, 5, 'data.inventory.potion');
```

A missing user/thread is created automatically before an update.

### `localData`

The same API is available, but paths are automatically rooted at `data`:

```js
await db.localData.set('botSettings', '?', 'prefix');
await db.localData.set('stats', 123, 'messages');
```

These correspond to:

```js
local.data.prefix
local.data.messages
```

Object updates merge into the existing local payload:

```js
await db.localData.set('botSettings', {
  prefix: '?',
  maintenance: true
});
```

---

## `increment(id, path, amount = 1, query?)`

Serializes a numeric read-modify-write operation through the shared database queue, then saves it and returns the updated record.

```js
await db.usersData.increment(userID, 'money', 100);
await db.usersData.increment(userID, 'exp', 25);
await db.usersData.increment(userID, 'data.coins', 5);
```

This is the generic "add something" API.

For `localData`:

```js
await db.localData.increment('stats', 'messages', 1);
```

The shared operation queue prevents two queued bot updates from both using the same stale in-memory value.

---

## `decrement(id, path, amount = 1, query?)`

The inverse of `increment()`.

```js
await db.usersData.decrement(userID, 'money', 50);
await db.usersData.decrement(userID, 'data.coins', 1);
```

Negative amounts are rejected when they are not finite numbers.

---

## `getNumber(id, path, defaultValue = 0)`

Reads a value and converts it to a finite JavaScript number.

```js
const money = await db.usersData.getNumber(userID, 'money', 0);
const score = await db.usersData.getNumber(userID, 'data.score', 0);
```

An invalid numeric value throws:

```text
INVALID_NUMBER
```

---

## `deleteKey(id, path, query?)`

Deletes a nested property without deleting the entire record.

```js
await db.usersData.deleteKey(userID, 'data.inventory.potion');
await db.usersData.deleteKey(userID, 'settings.prefix');
```

Root properties cannot be removed with `deleteKey()`.

```js
await db.usersData.deleteKey(userID, 'money');
```

is rejected. Use `set()` to change a root SQL field, or `remove()` to delete the whole record.

For `localData`:

```js
await db.localData.deleteKey('botSettings', 'maintenance');
```

is equivalent to deleting `data.maintenance`.

---

## `remove(id)`

Deletes the complete record.

```js
const removed = await db.usersData.remove(userID);
```

Returns:

```js
true  // record existed and was removed
false // record did not exist
```

The same method works on threads and local keys.

---

## `delete(id)`

Alias for `remove()`.

```js
await db.usersData.delete(userID);
```

`remove()` is the preferred name because it cannot be confused with `deleteKey()`.

---

## `refresh(id, updateData = {})`

Creates the record when missing; otherwise updates it.

It is effectively a named create-or-update operation.

```js
await db.usersData.refresh(userID, {
  name: 'Updated Name',
  phone: '91XXXXXXXXX'
});
```

For threads:

```js
await db.threadsData.refresh(threadID, {
  threadName: 'Renamed Group'
});
```

For local data:

```js
await db.localData.refresh('botSettings', {
  prefix: '!',
  maintenance: false
});
```

---

## `refreshInfo(id, updateData = {})`

Alias for `refresh()` kept for compatibility with the older database style.

```js
await db.usersData.refreshInfo(userID, {
  name: 'Updated Name'
});
```

No external Facebook/WhatsApp API call is made by this method. The caller supplies the information to store.

---

# 3. usersData

`usersData` is the main per-user persistent store.

## Standard fields

```text
userID
creation_date
last_update
username
name
phone
pushName
verifiedName
gender
exp
money
banned
settings
label
isAdmin
isDev
data
```

### `data`

`data` is the extensible user payload. It is intended for bot-specific values:

```js
{
  data: {
    level: 5,
    inventory: {
      bread: 3,
      potion: 2
    },
    cooldowns: {
      daily: 1750000000000
    }
  }
}
```

You can also omit `data` explicitly when using `set()`:

```js
await db.usersData.set(userID, {
  level: 5,
  inventory: {
    bread: 3
  }
});
```

Those unknown top-level properties are stored inside `data`.

## `getName(userID)`

Gets the user's stored `name`.

```js
const name = await db.usersData.getName(userID);
```

Returns `null` when the stored name is empty.

## `getNameInDB(userID)`

Synchronous version that never creates the record.

```js
const name = db.usersData.getNameInDB(userID);
```

Returns the stored name or `null`.

## `getMoney(userID, defaultValue = 0)`

Returns the user's money as a finite number.

```js
const money = await db.usersData.getMoney(userID);
```

## `addMoney(userID, amount, query?)`

Adds money through the same queued numeric update mechanism as `increment()`.

```js
await db.usersData.addMoney(userID, 100);
```

## `subtractMoney(userID, amount, query?)`

Subtracts money.

```js
await db.usersData.subtractMoney(userID, 50);
```

The database layer does not impose a "money cannot go below zero" rule. If the bot needs that rule, check the balance before subtracting or implement a transaction/business-rule layer above this database.

## `addExp(userID, amount, query?)`

Adds experience.

```js
await db.usersData.addExp(userID, 25);
```

## `subtractExp(userID, amount, query?)`

Subtracts experience.

```js
await db.usersData.subtractExp(userID, 5);
```

---

# 4. threadsData

`threadsData` stores persistent information about WhatsApp threads/groups.

## Standard fields

```text
threadID
creation_date
last_update
threadName
adminIDs
imageSrc
approvalMode
members
banned
settings
isGroup
data
```

Legacy fields are also retained for compatibility with existing bot code:

```text
name
subject
owner
type
participants_json
```

The following fields are intentionally **not part of the new schema**:

```text
threadThemeID
emoji
```

If an existing database still contains those two legacy columns, initialization attempts to remove them using SQLite's `DROP COLUMN` support. If the SQLite build is too old or the migration cannot safely remove a column, it is left physically untouched but is never read or written by the new store.

## Thread example

```js
const thread = await db.threadsData.ensure(threadID, {
  threadName: 'My Group',
  isGroup: true,
  adminIDs: [],
  members: [],
  settings: {
    sendWelcomeMessage: true,
    sendLeaveMessage: true,
    sendRankupMessage: false,
    customCommand: true
  }
});
```

Update group settings:

```js
await db.threadsData.set(
  threadID,
  false,
  'settings.customCommand'
);
```

Update a member value:

```js
await db.threadsData.set(
  threadID,
  Date.now(),
  'data.lastActivity'
);
```

Get the stored thread name:

```js
const name = await db.threadsData.getName(threadID);
```

---

# 5. localData

`localData` is generic bot-wide storage keyed by a string.

Typical uses:

```text
bot settings
feature flags
caches
counters
maintenance state
scheduled-task metadata
miscellaneous persistent state
```

A local record has the logical shape:

```js
{
  key: 'botSettings',
  creation_date: 1750000000000,
  last_update: 1750000000000,
  data: {
    prefix: '!',
    maintenance: false
  }
}
```

## Convenient paths

For `localData`, these are equivalent:

```js
await db.localData.get('botSettings', 'prefix');
await db.localData.get('botSettings', 'data.prefix');
```

The first form is recommended.

Likewise:

```js
await db.localData.set('botSettings', '?', 'prefix');
await db.localData.increment('stats', 'messages', 1);
await db.localData.deleteKey('botSettings', 'maintenance');
```

All operate under the record's `data` object.

## Missing-key behavior

Unlike users and threads, `localData.get()` does not create a missing key unless a default is supplied.

```js
await db.localData.get('cache');
// undefined if cache does not exist
```

With a default:

```js
await db.localData.get('cache', 'value', null);
```

The key is created with `data.value = null`.

---

# 6. Money/inventory style example

A typical command can be written without manually loading and saving a user object:

```js
const amount = 250;

await db.usersData.addMoney(userID, amount);
await db.usersData.increment(userID, 'data.stats.earned', amount);
await db.usersData.increment(userID, 'data.inventory.potion', 1);

const [money, potions] = await db.usersData.get(
  userID,
  ['money', 'data.inventory.potion'],
  [0, 0]
);

console.log({ money, potions });
```

Subtracting works the same way:

```js
await db.usersData.subtractMoney(userID, 100);
await db.usersData.decrement(userID, 'data.inventory.potion', 1);
```

---

# 7. Initialization and lifecycle helpers

These methods are on the database object rather than on a data store.

## `initialize(options)`

Creates or opens the SQLite database and returns the initialized database object.

```js
const db = await initialize({
  file: './runtime/database.sqlite'
});
```

## `save()`

Exports the in-memory `sql.js` database to the configured file.

```js
await db.save();
```

With `saveAfterWrite: true`, normal mutations save automatically.

## `backup()`

Saves the current database and creates a timestamped `.bak` copy. Old backups are pruned according to `backupKeep`.

```js
const backupFile = await db.backup();
console.log(backupFile);
```

## `close()`

Waits for queued database work, saves the database, and closes the `sql.js` connection.

```js
await db.close();
```

---

# 8. Optional existing helpers

The refactor also keeps two secondary stores used by the bot.

## `messagesData`

```js
await db.messagesData.create({
  messageID,
  threadID,
  userID,
  participantID,
  body: 'hello',
  message_type: 'conversation'
});

const message = db.messagesData.get(messageID);

await db.messagesData.markDeleted(messageID);
await db.messagesData.set(messageID, { body: 'edited' });
await db.messagesData.remove(messageID);
```

`messagesData.getAll({ threadID, userID, limit })` can retrieve recent messages for a thread/user.

## `commandUsage`

```js
await db.commandUsage.create({
  command_name: 'help',
  threadID,
  userID,
  success: true
});
```

Recent usage can be retrieved with:

```js
const usage = db.commandUsage.getAll({
  command: 'help',
  threadID,
  limit: 50
});
```

Old records can be removed with:

```js
await db.commandUsage.clearBefore(Date.now() - 7 * 24 * 60 * 60 * 1000);
```

---

# 9. Design rules

## One shared write queue

All three main stores share one serial operation queue. This avoids read-modify-write races such as:

```js
await Promise.all([
  db.usersData.addMoney(userID, 100),
  db.usersData.addMoney(userID, 100),
  db.usersData.addMoney(userID, 100)
]);
```

The updates are processed in order rather than all reading the same old balance.

## Cloned results

Returned objects are cloned. Mutating a returned object does not silently mutate the in-memory database.

```js
const user = await db.usersData.get(userID);
user.money = 999999;
```

The assignment above does not change the database. Use `set()` or `increment()` to persist changes.

## SQL fields versus `data`

For users and threads:

```js
await db.usersData.set(userID, {
  money: 100,       // SQL column
  name: 'John',     // SQL column
  inventory: {},    // stored in data
  level: 10         // stored in data
});
```

This keeps frequently accessed fields queryable while allowing arbitrary bot-specific data without constantly changing the database schema.

## No external API dependency

The database layer only stores and retrieves data. It does not assume a Facebook API, WhatsApp API, `global.utils`, `TaskQueue`, or any other project's global functions.

The caller can fetch WhatsApp/contacts/group information using whatever API the bot already uses and then pass the resulting fields to `create()` or `refreshInfo()`.

---

# 10. Recommended usage pattern

For most command/event handlers:

```js
const user = await db.usersData.get(userID);
const thread = await db.threadsData.get(threadID);
```

Then use direct operations rather than mutating and writing whole objects:

```js
await db.usersData.increment(userID, 'exp', 5);
await db.usersData.addMoney(userID, 100);
await db.usersData.set(userID, true, 'data.dailyClaimed');

await db.threadsData.set(threadID, false, 'settings.customCommand');
await db.localData.increment('stats', 'messages', 1);
```

This keeps reads, updates, and numeric changes consistent across the bot.
