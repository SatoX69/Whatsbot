/** @format */

'use strict';

module.exports = {
	config: {
		name: 'user',
		version: '5.0.0',
		role: 2,
		author: 'Jsux',
		category: 'System',
		description: 'Manage users',
		usage: '{pn}user [ban|unban] [userID]'
	},

	async onStart({ args, event, message, usersData }) {
		const action = String(args[0] || '').toLowerCase();
		const targetID = String(event.quoted?.senderID || args[1] || '').trim();

		switch (action) {
			case 'ban':
			case 'unban': {
				if (!targetID) {
					return message.reply(
						`Usage: ${action === 'ban' ? 'ban' : 'unban'} <userID>\n` +
							"Alternatively, reply to a user's message."
					);
				}

				let found = false;

				try {
					found = !!(await usersData.existsSync(targetID));
				} catch {}

				await usersData.set(
					targetID,
					action === 'ban',
					'settings.isBanned'
				);

				const status = action === 'ban' ? 'banned' : 'unbanned';

				return message.reply(
					found
						? `User ${targetID} has been ${status}.`
						: `User ${targetID} wasn't found. Their static ID has been ${status}.`
				);
			}
			case 'count': {
				const users = await usersData.getAll();
				return message.reply(
					users.length > 0
						? `There are currently ${users.length} users in the system`
						: 'No user detected in the system'
				);
			}

			default:
				return message.reply(
					'Available options: ban, unban\n' +
						'Usage: /user <option> [userID]'
				);
		}
	}
};
