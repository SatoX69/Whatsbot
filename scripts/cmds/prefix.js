'use strict';

const fs = require('node:fs');
const path = require('node:path');

function saveGlobalPrefix(prefix) {
  const file = path.resolve(__dirname, '../../config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.prefix = prefix;
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

module.exports = {
  config: {
    name: 'prefix',
    version: '4.0.0',
    author: 'Jsux',
    role: 2,
    category: 'System',
    description: 'Read or change the global or current-thread command prefix.',
    usage: '!prefix | !prefix <new> | !prefix all <new>'
  },

   onStart: async function({ args, message, event, localData, threadsData, config }) {
    if (!args.length) {
      const local = await localData.get(`threadPrefix:${event.threadID}`)?.data?.prefix;
      const thread = await threadsData.get(event.threadID)?.data?.prefix;
      await message.reply([
        `Global prefix: ${config.prefix}`,
        `Current thread prefix: ${local || thread || config.prefix}`
      ].join('\n'));
      return;
    }

    const globalChange = String(args[0]).toLowerCase() === 'all';
    const candidate = globalChange ? args[1] : args[0];
    const prefix = global.utils.normalizePrefix(candidate);

    if (globalChange) {
      saveGlobalPrefix(prefix);
      if (config.textlogs?.prefix !== false) await message.reply(global.utils.formatText(config.texts?.prefixGlobal || 'Global prefix changed to {prefix}.', { prefix }));
      return;
    }

    if (global.utils.isGroup(event.threadID) || global.utils.isNewsletter(event.threadID)) {
      await threadsData.set(event.threadID, { prefix });
    } else {
      await localData.set(`threadPrefix:${event.threadID}`, { prefix });
    }
    if (config.textlogs?.prefix !== false) await message.reply(global.utils.formatText(config.texts?.prefixThread || 'Current thread prefix changed to {prefix}', { prefix }));
  },
   onChat: async function({ event, message, localData, threadsData, config }) {
    if (event?.body?.toLowerCase() == "jsux") {
      const local = await localData.get(`threadPrefix:${event.threadID}`)?.data?.prefix;
      const thread = await threadsData.get(event.threadID)?.data?.prefix;
      await message.reply([
        `Mm? Bot: ${local || thread || config.prefix}`
      ].join('\n'));
      return;
    }
  }
};
