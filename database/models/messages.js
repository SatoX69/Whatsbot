'use strict';

module.exports = {
  name: 'messagesData',
  table: 'messages',
  key: 'messageID',
  schema: `
    CREATE TABLE IF NOT EXISTS messages (
      messageID TEXT PRIMARY KEY,
      threadID TEXT,
      userID TEXT,
      participantID TEXT,
      fromMe INTEGER NOT NULL DEFAULT 0,
      message_type TEXT,
      body TEXT,
      timestamp INTEGER,
      raw_json TEXT NOT NULL DEFAULT '{}',
      deleted INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread_time
      ON messages(threadID, timestamp);

    CREATE INDEX IF NOT EXISTS idx_messages_user_time
      ON messages(userID, timestamp);
  `
};
