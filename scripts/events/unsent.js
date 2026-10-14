'use strict';

module.exports = {
  config: {
    name: 'unsent',
    event: 'message.unsent',
    version: '4.0.0',
    author: 'Jsux',
    description: 'Record normalized information about WhatsApp revoke/unsend events.'
  },

  async onEvent({ event, localData, logger }) {
    await localData.set(`lastUnsent:${event.threadID}`, {
      messageID: event.data?.revokedKey?.id || event.messageID || null,
      senderID: event.actorID || null,
      timestamp: Date.now()
    });
    logger.debug('EVENT', 'Message unsent', {
      threadID: event.threadID,
      actorID: event.actorID,
      revokedMessageID: event.data?.revokedKey?.id || null
    });
  }
};
