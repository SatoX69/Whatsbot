'use strict';

const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

const loadModels = require('./loadModels');
const {
  DataStore,
  LocalDataStore,
  SerialQueue,
  createError,
  clone,
  isPlainObject,
  assertIdentifier
} = require('./core/DataStore');

function splitSchema(schema) {
  return String(schema)
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean)
    .map(statement => `${statement};`);
}

function tableColumns(db, table) {
  return db
    .all(`PRAGMA table_info(${assertIdentifier(table, 'table')})`)
    .map(row => row.name);
}

function addColumn(db, table, column, definition) {
  const columns = tableColumns(db, table);
  if (columns.includes(column)) return false;

  db.sql.run(
    `ALTER TABLE ${assertIdentifier(table, 'table')} ADD COLUMN ${assertIdentifier(column, 'column')} ${definition};`
  );

  return true;
}

function dropColumn(db, table, column, logger) {
  const columns = tableColumns(db, table);
  if (!columns.includes(column)) return false;

  const version = String(
    db.get('SELECT sqlite_version() AS version')?.version || '0.0.0'
  );
  const [major, minor] = version.split('.').map(Number);
  const supported = major > 3 || (major === 3 && minor >= 35);

  if (!supported) {
    if (typeof logger?.warn === 'function') {
      logger.warn(
        'DATABASE',
        `SQLite ${version} cannot DROP COLUMN directly; legacy column "${column}" was left untouched.`
      );
    }
    return false;
  }

  try {
    db.sql.run(
      `ALTER TABLE ${assertIdentifier(table, 'table')} DROP COLUMN ${assertIdentifier(column, 'column')};`
    );
    return true;
  } catch (error) {
    if (typeof logger?.warn === 'function') {
      logger.warn(
        'DATABASE',
        `Could not remove legacy column "${column}" from ${table}: ${error.message}`
      );
    }
    return false;
  }
}

function migrateSchema(db, logger) {
  // User columns that were not present in the earliest WhatsApp DB version.
  const userColumns = {
    gender: 'TEXT',
    exp: 'INTEGER NOT NULL DEFAULT 0',
    money: 'INTEGER NOT NULL DEFAULT 0',
    banned: `TEXT NOT NULL DEFAULT '{}'`,
    settings: `TEXT NOT NULL DEFAULT '{}'`,
    label: `TEXT NOT NULL DEFAULT 'user'`
  };

  // Canonical thread fields. threadThemeID and emoji are intentionally absent.
  const threadColumns = {
    threadName: 'TEXT',
    adminIDs: `TEXT NOT NULL DEFAULT '[]'`,
    imageSrc: 'TEXT',
    approvalMode: 'INTEGER',
    members: `TEXT NOT NULL DEFAULT '[]'`,
    banned: `TEXT NOT NULL DEFAULT '{}'`,
    settings: `TEXT NOT NULL DEFAULT '{}'`,
    isGroup: 'INTEGER NOT NULL DEFAULT 0'
  };

  for (const [column, definition] of Object.entries(userColumns)) {
    addColumn(db, 'users', column, definition);
  }

  for (const [column, definition] of Object.entries(threadColumns)) {
    addColumn(db, 'threads', column, definition);
  }

  // The old refactor introduced these two fields. They are no longer part of
  // the schema and are removed from existing databases where SQLite supports it.
  dropColumn(db, 'threads', 'threadThemeID', logger);
  dropColumn(db, 'threads', 'emoji', logger);

  // Backfill the canonical thread name from the legacy name column when needed.
  const threadCols = tableColumns(db, 'threads');
  if (threadCols.includes('threadName') && threadCols.includes('name')) {
    db.sql.run(
      `UPDATE threads\n       SET threadName = name\n       WHERE (threadName IS NULL OR threadName = '') AND name IS NOT NULL;`
    );
  }
}

function createUsersData(db) {
  return new DataStore(db, {
    name: 'usersData',
    table: 'users',
    keyName: 'userID',
    columns: [
      'username',
      'name',
      'phone',
      'pushName',
      'verifiedName',
      'gender',
      'exp',
      'money',
      'label',
      'isAdmin',
      'isDev'
    ],
    jsonColumns: ['banned', 'settings', 'data'],
    booleanColumns: ['isAdmin', 'isDev'],
    autoCreateOnGet: true,
    queue: db.operationQueue,
    defaults: {
      username: null,
      name: null,
      phone: null,
      pushName: null,
      verifiedName: null,
      gender: null,
      exp: 0,
      money: 0,
      banned: {},
      settings: {},
      label: 'user',
      isAdmin: false,
      isDev: false,
      data: {}
    }
  });
}

function createThreadsData(db) {
  return new DataStore(db, {
    name: 'threadsData',
    table: 'threads',
    keyName: 'threadID',
    columns: [
      'threadName',
      'imageSrc',
      'approvalMode',
      'isGroup',

      // Legacy fields retained so existing bot code does not break.
      'name',
      'subject',
      'owner',
      'type',
      'participants_json'
    ],
    jsonColumns: ['adminIDs', 'members', 'banned', 'settings', 'data'],
    booleanColumns: ['isGroup'],
    autoCreateOnGet: true,
    queue: db.operationQueue,
    defaults: {
      threadName: null,
      adminIDs: [],
      imageSrc: null,
      approvalMode: null,
      members: [],
      banned: {},
      settings: {
        sendWelcomeMessage: true,
        sendLeaveMessage: true,
        sendRankupMessage: false,
        customCommand: true
      },
      isGroup: false,
      data: {}
    }
  });
}

function createLocalData(db) {
  return new LocalDataStore(db, {
    name: 'localData',
    table: 'local_data',
    keyName: 'key',
    columns: [],
    jsonColumns: ['data'],
    autoCreateOnGet: false,
    queue: db.operationQueue,
    defaults: {
      data: {}
    }
  });
}

function buildMessagesData(db) {
  const get = messageID => {
    if (messageID === undefined || messageID === null || messageID === '') return null;
    return db.get(
      'SELECT * FROM messages WHERE messageID = ? LIMIT 1',
      [String(messageID)]
    );
  };

  return {
    existsSync: messageID => Boolean(get(messageID)),

    get,

    getAll: ({ threadID, userID, limit = 100 } = {}) => {
      const params = [];
      const where = [];

      if (threadID !== undefined) {
        where.push('threadID = ?');
        params.push(String(threadID));
      }

      if (userID !== undefined) {
        where.push('userID = ?');
        params.push(String(userID));
      }

      const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
      const sql = `
        SELECT * FROM messages
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY timestamp DESC
        LIMIT ${safeLimit}
      `;

      return db.all(sql, params);
    },

    create: row => db.enqueue(async () => {
      if (!row || row.messageID === undefined || row.messageID === null || row.messageID === '') {
        throw createError('INVALID_MESSAGE', 'messageID is required.');
      }

      const messageID = String(row.messageID);
      const existing = get(messageID);
      if (existing) return existing;

      await db.run(
        `INSERT INTO messages
        (messageID, threadID, userID, participantID, fromMe,
         message_type, body, timestamp, raw_json, deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          messageID,
          row.threadID == null ? null : String(row.threadID),
          row.userID == null ? null : String(row.userID),
          row.participantID == null ? null : String(row.participantID),
          row.fromMe ? 1 : 0,
          row.message_type ?? null,
          row.body ?? '',
          row.timestamp ?? Date.now(),
          typeof row.raw_json === 'string' ? row.raw_json : JSON.stringify(row.raw_json ?? {}),
          row.deleted ? 1 : 0
        ]
      );

      return get(messageID);
    }),

    set: (messageID, patch = {}) => db.enqueue(async () => {
      const existing = get(messageID);
      if (!existing) {
        throw createError('MESSAGE_NOT_FOUND', `Message "${messageID}" does not exist.`);
      }

      const allowed = new Set([
        'threadID',
        'userID',
        'participantID',
        'fromMe',
        'message_type',
        'body',
        'timestamp',
        'raw_json',
        'deleted'
      ]);

      if (!isPlainObject(patch)) {
        throw createError('INVALID_UPDATE_DATA', 'Message patch must be an object.');
      }

      const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
      if (!entries.length) return existing;


      // Rebuild the values by field to avoid ambiguity when two fields contain the same value.
      const encoded = entries.map(([key, value]) => {
        if (value === undefined) return null;
        if (['fromMe', 'deleted'].includes(key)) return value ? 1 : 0;
        if (['threadID', 'userID', 'participantID'].includes(key)) return value == null ? null : String(value);
        if (key === 'raw_json') return typeof value === 'string' ? value : JSON.stringify(value);
        return value;
      });

      await db.run(
        `UPDATE messages SET ${entries.map(([key]) => `${assertIdentifier(key, 'column')} = ?`).join(', ')} WHERE messageID = ?`,
        [...encoded, String(messageID)]
      );

      return get(messageID);
    }),

    markDeleted: messageID => db.enqueue(async () => {
      const id = String(messageID);
      if (!get(id)) {
        throw createError('MESSAGE_NOT_FOUND', `Message "${id}" does not exist.`);
      }

      await db.run(
        'UPDATE messages SET deleted = 1 WHERE messageID = ?',
        [id]
      );

      return get(id);
    }),

    remove: messageID => db.enqueue(async () => {
      const result = await db.run(
        'DELETE FROM messages WHERE messageID = ?',
        [String(messageID)]
      );
      return Boolean(result);
    })
  };
}

function buildCommandUsage(db) {
  return {
    create: row => db.enqueue(async () => {
      if (!row?.command_name) {
        throw createError('INVALID_COMMAND_USAGE', 'command_name is required.');
      }

      await db.run(
        `INSERT INTO command_usage
        (command_name, threadID, userID, fromMe, success, created_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          String(row.command_name),
          row.threadID == null ? null : String(row.threadID),
          row.userID == null ? null : String(row.userID),
          row.fromMe ? 1 : 0,
          row.success === false ? 0 : 1,
          row.created_at ?? Date.now(),
          row.error ?? null
        ]
      );

      return true;
    }),

    getAll: ({ command, threadID, userID, limit = 100 } = {}) => {
      const params = [];
      const where = [];

      if (command !== undefined) {
        where.push('command_name = ?');
        params.push(String(command));
      }
      if (threadID !== undefined) {
        where.push('threadID = ?');
        params.push(String(threadID));
      }
      if (userID !== undefined) {
        where.push('userID = ?');
        params.push(String(userID));
      }

      const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));

      return db.all(
        `SELECT * FROM command_usage\n         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}\n         ORDER BY created_at DESC\n         LIMIT ${safeLimit}`,
        params
      );
    },

    clearBefore: timestamp => db.enqueue(async () => {
      const time = Number(timestamp);
      if (!Number.isFinite(time)) {
        throw createError('INVALID_TIMESTAMP', 'timestamp must be a finite number.');
      }

      const result = await db.run(
        'DELETE FROM command_usage WHERE created_at < ?',
        [time]
      );

      return Boolean(result);
    })
  };
}

async function initialize({
  file,
  logger,
  config = {},
} = {}) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new TypeError('initialize() requires a database file path.');
  }

  const databaseConfig = {
    saveAfterWrite: true,
    backupKeep: 5,
    ...(config.database || {})
  };

  databaseConfig.saveAfterWrite = databaseConfig.saveAfterWrite !== false;
  databaseConfig.backupKeep = Math.max(1, Number(databaseConfig.backupKeep) || 5);

  const absoluteFile = path.resolve(file);
  fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });

  const SQL = await initSqlJs({
    locateFile: filename => require.resolve(`sql.js/dist/${filename}`)
  });

  const sql = fs.existsSync(absoluteFile)
    ? new SQL.Database(fs.readFileSync(absoluteFile))
    : new SQL.Database();

  const db = {
    SQL,
    file: absoluteFile,
    sql,
    closed: false,
    saveChain: Promise.resolve(),
    operationQueue: new SerialQueue(),
    config: databaseConfig
  };

  db.assertOpen = () => {
    if (db.closed) throw new Error('Database is closed.');
  };

  db.run = (statement, params = []) => {
    db.assertOpen();
    db.sql.run(statement, params);
    const changes = db.sql.getRowsModified?.() ?? 0;

    return (databaseConfig.saveAfterWrite === false
      ? Promise.resolve()
      : db.save()
    ).then(() => changes);
  };

  db.get = (statement, params = []) => {
    db.assertOpen();

    const stmt = db.sql.prepare(statement);
    try {
      stmt.bind(params);
      return stmt.step() ? stmt.getAsObject() : null;
    } finally {
      stmt.free();
    }
  };

  db.all = (statement, params = []) => {
    db.assertOpen();

    const stmt = db.sql.prepare(statement);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  };

  db.enqueue = task => db.operationQueue.push(task);

  db.save = () => {
    db.assertOpen();

    db.saveChain = db.saveChain
      .catch(() => undefined)
      .then(async () => {
        const bytes = db.sql.export();
        const tempFile = `${absoluteFile}.tmp-${process.pid}`;
        fs.writeFileSync(tempFile, Buffer.from(bytes));
        fs.renameSync(tempFile, absoluteFile);
      });

    return db.saveChain;
  };

  db.backup = async () => {
    db.assertOpen();
    await db.operationQueue.tail.catch(() => undefined);
    await db.save();

    if (!fs.existsSync(absoluteFile)) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = `${absoluteFile}.${stamp}.bak`;

    fs.copyFileSync(absoluteFile, backupFile);

    const directory = path.dirname(absoluteFile);
    const basename = path.basename(absoluteFile);
    const keep = Math.max(1, Number(databaseConfig.backupKeep) || 5);

    const backups = fs
      .readdirSync(directory)
      .filter(fileName =>
        fileName.startsWith(`${basename}.`) && fileName.endsWith('.bak')
      )
      .sort()
      .reverse();

    for (const oldBackup of backups.slice(keep)) {
      try {
        fs.unlinkSync(path.join(directory, oldBackup));
      } catch {}
    }

    return backupFile;
  };

  db.close = async () => {
    if (db.closed) return;
    await db.operationQueue.tail.catch(() => undefined);
    await db.save();
    db.sql.close();
    db.closed = true;
  };

  const models = loadModels(path.join(__dirname, 'models'));

  for (const model of models) {
    for (const statement of splitSchema(model.schema)) {
      db.sql.run(statement);
    }
  }

  migrateSchema(db, logger);

  if (databaseConfig.saveAfterWrite !== false) {
    await db.save();
  }

  db.usersData = createUsersData(db);
  db.threadsData = createThreadsData(db);
  db.localData = createLocalData(db);


  // User helpers inspired by the other project, but kept local to the DB layer.
  db.usersData.getNameInDB = userID =>
    db.usersData.getSync(userID)?.name ?? null;

  db.usersData.getName = async (userID, checkData = true) => {
    if (!checkData) return db.usersData.get(userID, 'name', null);
    return db.usersData.get(userID, 'name', null);
  };

  db.usersData.getMoney = (userID, defaultValue = 0) =>
    db.usersData.getNumber(userID, 'money', defaultValue);

  db.usersData.addMoney = (userID, amount, queryFn) =>
    db.usersData.increment(userID, 'money', amount, queryFn);

  db.usersData.subtractMoney = (userID, amount, queryFn) =>
    db.usersData.decrement(userID, 'money', amount, queryFn);

  db.usersData.addExp = (userID, amount, queryFn) =>
    db.usersData.increment(userID, 'exp', amount, queryFn);

  db.usersData.subtractExp = (userID, amount, queryFn) =>
    db.usersData.decrement(userID, 'exp', amount, queryFn);

  db.threadsData.getName = async threadID =>
    db.threadsData.get(threadID, 'threadName', null);

  db.messagesData = buildMessagesData(db);
  db.commandUsage = buildCommandUsage(db);


  if (typeof logger?.info === 'function') {
    logger.info('DATABASE', 'SQLite database initialized', { file: absoluteFile });
  }

  return db;
}

module.exports = {
  initialize,
  DataStore,
  LocalDataStore,
  SerialQueue,
  DataFacade: DataStore
};
