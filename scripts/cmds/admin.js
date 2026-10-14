'use strict';

module.exports = {
  config: {
    name: 'admin',
    version: '5.0.0',
    author: 'Jsux',
    role: 2,
    category: 'System',
    description: 'Manage admin-only command mode and administrators.',
    usage: '!admin [on|off|add|remove] [adminID]'
  },

  async onStart({ args, event, message, localData, config }) {
    const action = String(args[0] || '').toLowerCase();

    // ── Admin mode ──────────────────────────────────────────────
    if (!action) {
      const current = await localData.get('adminMode', 'enabled', true);
      const enabled = current === undefined
        ? !!config.adminModeDefault
        : !!current;

      await message.reply(
        `Admin mode: ${enabled ? 'ON' : 'OFF'}`
      );
      return;
    }

    if (action === 'on' || action === 'off') {
      const enabled = action === 'on';

      await localData.set('adminMode', { enabled });

      const key = enabled ? 'adminOn' : 'adminOff';

      if (config.textlogs?.admin !== false) {
        await message.reply(
          config.texts?.[key] ||
          `Admin mode is now ${enabled ? 'ON' : 'OFF'}.`
        );
      }

      return;
    }

    // ── Admin management ───────────────────────────────────────
    if (action !== 'add' && action !== 'remove') {
      await message.reply(
        `Usage:\n` +
        `${config.prefix}admin on | off\n` +
        `${config.prefix}admin add <adminID>\n` +
        `${config.prefix}admin remove <adminID>\n` +
        `Or reply to a user's message with "${config.prefix}admin add/remove".`
      );
      return;
    }

    /*
     * Resolve target:
     *
     * !admin add 123456789
     *             ^ args[1]
     *
     * !admin add   ← replied message
     *               ^ event.messageReply.senderID
     */
    const targetID =
      String(args[1] || '').trim() ||
      String(event.messageReply?.senderID || '').trim();

    if (!targetID) {
      await message.reply(
        `Please provide an admin ID or reply to the user's message.\n` +
        `Usage: ${config.prefix}admin ${action} <adminID>`
      );
      return;
    }

    // Never allow an admin to add/remove themselves.
    if (targetID === String(event.senderID)) {
      await message.reply(
        `You cannot ${action} yourself.`
      );
      return;
    }

    // Stored separately from adminMode.
    const admins = await localData.get('admins', 'admins', true);

    // Normalize the datastore value defensively.
    const adminIDs = Array.isArray(admins)
      ? admins.map(String)
      : [];

    if (action === 'add') {
      if (adminIDs.includes(targetID)) {
        await message.reply(`${targetID} is already an admin.`);
        return;
      }

      adminIDs.push(targetID);

      await localData.set('admins', adminIDs);

      await message.reply(
        `Added ${targetID} as an admin.`
      );

      return;
    }

    // remove
    const index = adminIDs.indexOf(targetID);

    if (index === -1) {
      await message.reply(`${targetID} is not an admin.`);
      return;
    }

    adminIDs.splice(index, 1);

    await localData.set('admins', adminIDs);

    await message.reply(
      `Removed ${targetID} from admins.`
    );
  }
};