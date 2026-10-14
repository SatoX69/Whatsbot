'use strict';

module.exports = {
	config: {
		name: 'uid',
		version: '1.0',
		author: 'Jsux',
		countDown: 5,
		role: 0,
		description: {
			en: 'View WhatsApp user IDs'
		},
		category: 'utility',
		guide: {
			en: '   {pn}: view your own user ID'
				+ '\n   {pn} @mention: view the mentioned user ID'
				+ '\n   Reply to someone with the command to view their user ID'
		}
	},

	langs: {
		en: {
			syntaxError: 'Please mention someone or reply to their message.'
		}
	},

	onStart: async function ({ message, event, getLang }) {
		// Reply to a message
		if (event.quoted?.senderID)
			return message.reply(event.quoted.senderID);

		// Mentioned users
		const mentions =
			event.mentions ||
			event.raw?.extendedTextMessage?.contextInfo?.mentionedJid;

		if (mentions?.length) {
			const ids = Array.isArray(mentions)
				? mentions
				: Object.keys(mentions);

			return message.reply(ids.join('\n'));
		}

		// No reply/mention → own UID
		return message.reply(event.senderID);
	}
};