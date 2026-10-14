'use strict';

module.exports = {
  config: {
    name: 'approval',
    version: '1.0.0',
    author: 'Jsux',
    role: 2,
    category: 'System',
    description: 'Add or remove approval mode.',
    usage: '{pn} approval [add/remove] [threadID/this]'
  },

  async onStart({ args, message, event, threadsData }) {
    const action = args[0]?.toLowerCase();

    if (!['add', 'remove'].includes(action)) {
      return message.reply(`Usage: ${this.config.usage}`);
    }

    let tid = args[1];

    if (!tid) {
      return message.reply('Provide a valid TID.');
    }

    if (tid.toLowerCase() === 'this') {
      tid = event.threadID;
    }

    tid = String(tid);

    const exists = await threadsData.existsSync(tid);

    if (!exists) {
      return message.reply("Thread doesn't exist.");
    }

    const approvalMode = action === 'add';

    const threadData = await threadsData.set(tid, {
      approvalMode
    });

    const threadName = threadData?.threadName || 'Untitled';
    const threadID = threadData?.threadID || tid;

    return message.reply(
      `${approvalMode ? 'Added approval for' : 'Removed approval from'}: ${threadName} (${threadID})`
    );
  }
};