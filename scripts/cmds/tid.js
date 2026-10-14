'use strict';

module.exports = {
  config: {
    name: 'tid',
    version: '1.0.0',
    author: 'Jsux',
    role: 0,
    countDown: 10,
    category: 'utility',
    description: 'Get ThreadID.',
    usage: '{pn}'
  },

  async onStart({ args, message, event }) {
    message.reply(event.threadID)
  }
}