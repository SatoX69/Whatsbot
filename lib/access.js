'use strict';

function getEffectivePrefix(threadsData, localData, chatJid, globalPrefix, utils) {
  if (!chatJid) return globalPrefix;

  if (utils.isGroup(chatJid) || utils.isNewsletter(chatJid)) {
    try {
      const thread = threadsData.getSync(chatJid);
      const prefix = thread?.data?.prefix;

      if (prefix != null && prefix !== '') {
        return utils.normalizePrefix(prefix);
      }
    } catch {}
  }

  try {
    const local = localData.getSync(`threadPrefix:${chatJid}`);
    const prefix = local?.data?.prefix;

    if (prefix != null && prefix !== '') {
      return utils.normalizePrefix(prefix);
    }
  } catch {}

  return globalPrefix;
}

function roleName(role) {
  return {
    0: 'everyone',
    1: 'group admins',
    2: 'bot admins',
    3: 'bot devs'
  }[Number(role)] || 'unknown';
}

module.exports = {
  getEffectivePrefix,
  roleName
};