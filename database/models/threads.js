'use strict';

module.exports = {
  name: 'threadsData',
  table: 'threads',
  key: 'threadID',
  schema: `
    CREATE TABLE IF NOT EXISTS threads (
      threadID TEXT PRIMARY KEY,
      creation_date INTEGER NOT NULL,
      last_update INTEGER NOT NULL,

      threadName TEXT,
      adminIDs TEXT NOT NULL DEFAULT '[]',
      imageSrc TEXT,
      approvalMode INTEGER,

      members TEXT NOT NULL DEFAULT '[]',
      banned TEXT NOT NULL DEFAULT '{}',
      settings TEXT NOT NULL DEFAULT '{}',
      isGroup INTEGER NOT NULL DEFAULT 0,

      data TEXT NOT NULL DEFAULT '{}',

      -- Legacy fields retained for compatibility with older bot code.
      name TEXT,
      subject TEXT,
      owner TEXT,
      type TEXT,
      participants_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_threads_last_update
      ON threads(last_update);
  `
};
