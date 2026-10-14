'use strict';

module.exports = {
  name: 'usersData',
  table: 'users',
  key: 'userID',
  schema: `
    CREATE TABLE IF NOT EXISTS users (
      userID TEXT PRIMARY KEY,
      creation_date INTEGER NOT NULL,
      last_update INTEGER NOT NULL,

      username TEXT,
      name TEXT,
      phone TEXT,
      pushName TEXT,
      verifiedName TEXT,

      exp INTEGER NOT NULL DEFAULT 0,
      money INTEGER NOT NULL DEFAULT 0,
      banned TEXT NOT NULL DEFAULT '{}',
      settings TEXT NOT NULL DEFAULT '{}',
      label TEXT NOT NULL DEFAULT 'user',

      isAdmin INTEGER NOT NULL DEFAULT 0,
      isDev INTEGER NOT NULL DEFAULT 0,

      data TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    CREATE INDEX IF NOT EXISTS idx_users_last_update ON users(last_update);
  `
};
