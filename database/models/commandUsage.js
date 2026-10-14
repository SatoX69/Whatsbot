'use strict';

module.exports = {
  name: 'commandUsage',
  table: 'command_usage',
  key: 'id',
  schema: `
    CREATE TABLE IF NOT EXISTS command_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_name TEXT NOT NULL,
      threadID TEXT,
      userID TEXT,
      fromMe INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_command_usage_name_time
      ON command_usage(command_name, created_at);
  `
};
