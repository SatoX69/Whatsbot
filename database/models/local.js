'use strict';

module.exports = {
  name: 'localData',
  table: 'local_data',
  key: 'key',
  schema: `
    CREATE TABLE IF NOT EXISTS local_data (
      key TEXT PRIMARY KEY,
      creation_date INTEGER NOT NULL,
      last_update INTEGER NOT NULL,
      data TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_local_data_last_update
      ON local_data(last_update);
  `
};
