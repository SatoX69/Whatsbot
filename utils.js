/** @format */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config.json');

function normalizeNumber(value) {
	return String(value ?? '').replace(/\D/g, '');
}

function normalizeJid(value) {
	if (!value) return '';
	return String(value).trim().split(':')[0];
}

function userNumber(value) {
	return normalizeNumber(normalizeJid(value).split('@')[0]);
}

function sameUser(a, b) {
	const left = userNumber(a);
	const right = userNumber(b);
	return Boolean(left && right && left === right);
}

function toUserJid(value) {
	const raw = String(value ?? '').trim();
	if (!raw) return '';
	if (raw.includes('@')) return normalizeJid(raw);
	const number = normalizeNumber(raw);
	return number ? `${number}@s.whatsapp.net` : '';
}

function isGroup(jid) {
	return String(jid || '').endsWith('@g.us');
}
function isNewsletter(jid) {
	return String(jid || '').endsWith('@newsletter');
}
function isStatus(jid) {
	return String(jid || '') === 'status@broadcast';
}

function extractMessageContent(content) {
	if (!content) return null;
	const wrappers = [
		'ephemeralMessage',
		'viewOnceMessage',
		'viewOnceMessageV2',
		'viewOnceMessageV2Extension',
		'documentWithCaptionMessage',
		'editedMessage',
		'associatedChildMessage'
	];
	for (const wrapper of wrappers) {
		if (content?.[wrapper]?.message) {
			const nested = extractMessageContent(content[wrapper].message);
			if (nested) return nested;
		}
	}
	return content;
}

function extractMessageText(content) {
	const message = extractMessageContent(content);
	if (!message) return '';
	if (typeof message.conversation === 'string') return message.conversation;
	if (typeof message.extendedTextMessage?.text === 'string')
		return message.extendedTextMessage.text;
	if (typeof message.imageMessage?.caption === 'string')
		return message.imageMessage.caption;
	if (typeof message.videoMessage?.caption === 'string')
		return message.videoMessage.caption;
	if (typeof message.documentMessage?.caption === 'string')
		return message.documentMessage.caption;
	if (
		typeof message.templateMessage?.hydratedTemplate
			?.hydratedContentText === 'string'
	) {
		return message.templateMessage.hydratedTemplate.hydratedContentText;
	}
	return '';
}

function contentType(message) {
	const content = extractMessageContent(message?.message);
	return content ? Object.keys(content)[0] || null : null;
}

function contextInfo(content) {
	const message = extractMessageContent(content);
	if (!message) return null;
	for (const key of Object.keys(message)) {
		const value = message[key];
		if (value?.contextInfo) return value.contextInfo;
	}
	return null;
}

function quotedMessage(message) {
	const info = contextInfo(message?.message);
	if (!info?.quotedMessage) return null;
	const remoteJid = message?.key?.remoteJid || '';
	const participant = info.participant || info.remoteJid || null;
	return {
		key: {
			remoteJid: info.remoteJid || remoteJid,
			id: info.stanzaId || null,
			participant
		},
		message: info.quotedMessage,
		body: extractMessageText(info.quotedMessage),
		senderID: participant || null
	};
}

function mentions(message) {
	return contextInfo(message?.message)?.mentionedJid || [];
}

function parseCommand(text, prefix) {
	if (typeof text !== 'string' || !text.startsWith(prefix)) return null;

	const body = text.slice(prefix.length).trim();
	if (!body) return { prefixOnly: true };

	const args = body.split(/\s+/);
	const command = String(args.shift() || '').toLowerCase();
	if (!command) return null;

	return { prefix, command, args, input: args.join(' '), body: text.trim() };
}

function stringify(value, space = 2) {
	if (typeof value === 'string') return value;
	if (value === undefined) return 'undefined';
	if (value === null) return 'null';
	if (typeof value === 'bigint') return `${value}n`;
	if (value instanceof Error) return value.stack || value.message;
	try {
		const seen = new WeakSet();
		return JSON.stringify(
			value,
			(key, current) => {
				if (typeof current === 'bigint') return `${current}n`;
				if (typeof current === 'object' && current !== null) {
					if (seen.has(current)) return '[Circular]';
					seen.add(current);
				}
				return current;
			},
			space
		);
	} catch {
		return String(value);
	}
}

function formatText(template, values = {}) {
	return String(template || '').replace(/\{(\w+)\}/g, (_, key) =>
		String(values[key] ?? `{${key}}`)
	);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function duration(ms) {
	let seconds = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(seconds / 86400);
	seconds %= 86400;
	const hours = Math.floor(seconds / 3600);
	seconds %= 3600;
	const minutes = Math.floor(seconds / 60);
	seconds %= 60;
	const parts = [];
	if (days) parts.push(`${days}d`);
	if (hours || days) parts.push(`${hours}h`);
	if (minutes || hours || days) parts.push(`${minutes}m`);
	parts.push(`${seconds}s`);
	return parts.join(' ');
}

function ensureDirectory(directory) {
	fs.mkdirSync(directory, { recursive: true });
	return directory;
}

function normalizePrefix(prefix) {
	const value = String(prefix ?? '');
	if (!value || /\s/.test(value) || value.length > 5) {
		throw new Error(
			'Prefix must be 1-5 characters and contain no whitespace.'
		);
	}
	return value;
}

function isMessageContent(value) {
	if (
		!value ||
		typeof value !== 'object' ||
		Buffer.isBuffer(value) ||
		ArrayBuffer.isView(value)
	)
		return false;
	return [
		'text',
		'image',
		'video',
		'audio',
		'document',
		'sticker',
		'location',
		'contacts',
		'poll',
		'react',
		'delete',
		'forward',
		'event',
		'product',
		'listMessage',
		'buttonsMessage',
		'templateMessage',
		'interactiveMessage'
	].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function createApi(ctx) {
	const socket = ctx.socket;
	const track = ctx.trackOutgoing || (() => {});
	const currentThread = () => ctx.event?.threadID || ctx.chatJid || '';
	const currentMessageID = () =>
		ctx.event?.messageID || ctx.messageKey?.id || '';
	const currentSenderID = () => ctx.event?.senderID || ctx.senderJid || '';
	const currentRawKey = () => ctx.rawMessage?.key || ctx.messageKey || {};

	async function sendMessage(content, ID = currentThread(), options = {}) {
		if (!ID) throw new Error('No target chat ID available.');
		const payload =
			typeof content === 'string' ? { text: content } : { ...content };
		const sendOptions =
			options && options.options ? options.options : options || {};
		const sent = await socket.sendMessage(ID, payload, sendOptions);
		track(sent?.key);
		return sent;
	}

	async function reply(content, ID = currentThread(), options = {}) {
		const sendOptions = { ...(options || {}) };
		if (ctx.rawMessage) sendOptions.quoted = ctx.rawMessage;
		return sendMessage(content, ID, sendOptions);
	}

	return {
		raw: socket,
		get socket() {
			return socket;
		},
		get threadID() {
			return ctx.event?.threadID || ctx.chatJid || '';
		},
		get chatID() {
			return ctx.event?.threadID || ctx.chatJid || '';
		},
		get senderID() {
			return ctx.event?.senderID || ctx.senderJid || '';
		},
		get messageID() {
			return ctx.event?.messageID || ctx.messageKey?.id || '';
		},

		sendMessage,
		sendText: sendMessage,
		reply,
		send: (content, ID, options) => sendMessage(content, ID, options),
		sendReaction: (emoji, messageID, ID) => {
			const rawKey = currentRawKey();
			const target = ID || currentThread();
			return socket.sendMessage(target, {
				react: {
					text: String(emoji),
					key: {
						...rawKey,
						remoteJid: target,
						id: messageID || rawKey.id || currentMessageID(),
						fromMe: Boolean(rawKey.fromMe ?? ctx.isSelf)
					}
				}
			});
		},
		getQuotedMessage: () =>
			global.utils.quotedMessage(ctx.rawMessage || { message: {} }),

		async deleteMessage(
			messageID = currentMessageID(),
			ID = currentThread(),
			options = {}
		) {
			const transport = options?.options || options || {};
			const rawKey = currentRawKey();
			const key = {
				...rawKey,
				remoteJid: ID || rawKey.remoteJid,
				id: messageID || rawKey.id,
				fromMe: Boolean(transport.fromMe ?? rawKey.fromMe ?? ctx.isSelf)
			};
			if (transport.participant) key.participant = transport.participant;
			return socket.sendMessage(key.remoteJid, { delete: key });
		},

		async reactMessage(
			emoji,
			messageID = currentMessageID(),
			ID = currentThread()
		) {
			const rawKey = currentRawKey();
			const key = {
				...rawKey,
				remoteJid: ID || rawKey.remoteJid,
				id: messageID || rawKey.id,
				fromMe: Boolean(rawKey.fromMe ?? ctx.isSelf)
			};
			return socket.sendMessage(key.remoteJid, {
				react: { text: String(emoji), key }
			});
		},

		react: (emoji, messageID, ID) => {
			const rawKey = currentRawKey();
			return socket.sendMessage(ID || currentThread(), {
				react: {
					text: String(emoji),
					key: {
						...rawKey,
						remoteJid: ID || rawKey.remoteJid || currentThread(),
						id: messageID || rawKey.id || currentMessageID(),
						fromMe: Boolean(rawKey.fromMe ?? ctx.isSelf)
					}
				}
			});
		},

		async editMessage(messageID, text, ID = this.chatID, options = {}) {
			return socket.sendMessage(ID, {
				text: String(text),
				edit: { remoteJid: ID, id: messageID, fromMe: true, ...options }
			});
		},

		async forwardMessage(messageToForward, ID = this.chatID) {
			return sendMessage({ forward: messageToForward }, ID);
		},

		async readMessages(keys = []) {
			return socket.readMessages(Array.isArray(keys) ? keys : [keys]);
		},

		async sendPresence(type, ID = currentThread()) {
			return socket.sendPresenceUpdate(type, ID);
		},
		setTyping: (ID = currentThread()) =>
			socket.sendPresenceUpdate('composing', ID),
		setRecording: (ID = currentThread()) =>
			socket.sendPresenceUpdate('recording', ID),
		stopTyping: (ID = currentThread()) =>
			socket.sendPresenceUpdate('paused', ID),

		async subscribePresence(ID = currentThread()) {
			return socket.presenceSubscribe(ID);
		},

		async getGroupMetadata(ID = currentThread()) {
			return ctx.getGroupMetadata(ID);
		},

		async groupParticipantsUpdate(ID, participants, action) {
			return socket.groupParticipantsUpdate(ID, participants, action);
		},
		async groupCreate(subject, participants = []) {
			return socket.groupCreate(subject, participants);
		},
		async groupLeave(ID = currentThread()) {
			return socket.groupLeave(ID);
		},
		async groupUpdateSubject(ID, subject) {
			return socket.groupUpdateSubject(ID, subject);
		},
		async groupUpdateDescription(ID, description) {
			return socket.groupUpdateDescription(ID, description);
		},
		async groupInviteCode(ID = currentThread()) {
			return socket.groupInviteCode(ID);
		},
		async groupRevokeInvite(ID = currentThread()) {
			if (typeof socket.groupRevokeInvite === 'function')
				return socket.groupRevokeInvite(ID);
			if (typeof socket.groupRevokeInviteInvite === 'function')
				return socket.groupRevokeInviteInvite(ID);
			throw new Error(
				'Group invite revoke is not supported by this Baileys socket.'
			);
		},
		async groupAcceptInvite(code) {
			return socket.groupAcceptInvite(code);
		},
		async groupGetInviteInfo(code) {
			return socket.groupGetInviteInfo(code);
		},

		async updateBlockStatus(ID, action) {
			return socket.updateBlockStatus(ID, action);
		},
		async getBusinessProfile(ID = currentSenderID()) {
			return socket.getBusinessProfile(ID);
		},
		async onWhatsApp(ids) {
			return socket.onWhatsApp(ids);
		},
		async fetchStatus(ID) {
			return socket.fetchStatus(ID);
		},
		async fetchBlocklist() {
			return socket.fetchBlocklist();
		},
		async profilePicture(ID) {
			return socket.profilePictureUrl(ID, 'image').catch(() => null);
		},
		async updateProfilePicture(ID, source) {
			return socket.updateProfilePicture(ID, source);
		},
		async removeProfilePicture(ID) {
			return socket.removeProfilePicture(ID);
		},

		async sendImage(
			source,
			caption = '',
			ID = currentThread(),
			options = {}
		) {
			return sendMessage(
				{ image: source, caption, ...options.content },
				ID,
				options.send || options
			);
		},
		async sendVideo(
			source,
			caption = '',
			ID = currentThread(),
			options = {}
		) {
			return sendMessage(
				{ video: source, caption, ...options.content },
				ID,
				options.send || options
			);
		},
		async sendAudio(source, ID = currentThread(), options = {}) {
			return sendMessage(
				{ audio: source, ...options.content },
				ID,
				options.send || options
			);
		},
		async sendDocument(
			source,
			fileName,
			mimetype = 'application/octet-stream',
			ID = currentThread(),
			options = {}
		) {
			return sendMessage(
				{ document: source, fileName, mimetype, ...options.content },
				ID,
				options.send || options
			);
		},
		async sendSticker(source, ID = currentThread(), options = {}) {
			return sendMessage(
				{ sticker: source, ...options.content },
				ID,
				options.send || options
			);
		},
		async sendLocation(
			latitude,
			longitude,
			name = '',
			ID = currentThread(),
			options = {}
		) {
			return sendMessage(
				{
					location: {
						degreesLatitude: latitude,
						degreesLongitude: longitude,
						name,
						...options.location
					}
				},
				ID,
				options.send || options
			);
		},
		async sendContact(vcard, displayName, ID = currentThread()) {
			return sendMessage(
				{ contacts: { displayName, contacts: [{ vcard }] } },
				ID
			);
		},
		async sendPoll(
			name,
			values,
			selectableCount = 1,
			ID = currentThread(),
			options = {}
		) {
			return sendMessage(
				{ poll: { name, values, selectableCount, ...options } },
				ID
			);
		},

		async downloadMessage(message = ctx.rawMessage, options = {}) {
			const baileys = await import('@whiskeysockets/baileys');
			return baileys.downloadMediaMessage(message, 'buffer', options, {
				logger: global.log?.baileys || undefined,
				reuploadRequest: socket.updateMediaMessage
			});
		},

		isBotAdmin(ID = currentSenderID()) {
			return Boolean(ctx.isBotAdmin?.(ID));
		},
		isBotDev(ID = currentSenderID()) {
			return Boolean(ctx.isBotDev?.(ID));
		},
		isGroupAdmin(ID = currentSenderID(), metadata) {
			return Boolean(ctx.isGroupAdmin?.(ID, metadata));
		},
		isAdmin(ID = currentSenderID()) {
			return Boolean(
				ctx.isBotAdmin?.(ID) ||
				ctx.isGroupAdmin?.(ID, ctx.groupMetadata)
			);
		}
	};
}

function createMessage(ctx, api = createApi(ctx)) {
	const message = function message(content, options) {
		return message.send(content, options);
	};

	message.reply = (content, options = {}) => {
		const payload = isMessageContent(content)
			? content
			: stringify(content);
		return api.reply(payload, ctx.event?.threadID || ctx.chatJid, options);
	};
	message.send = (content, options = {}) => {
		if (isMessageContent(content)) {
			return api.sendMessage(
				content,
				ctx.event?.threadID || ctx.chatJid,
				options
			);
		}
		return api.sendMessage(
			stringify(content),
			ctx.event?.threadID || ctx.chatJid,
			options
		);
	};
	message.react = (emoji, messageID, ID) =>
		api.reactMessage(emoji, messageID || api.messageID, ID || api.threadID);
	message.delete = (messageID, ID, options) =>
		api.deleteMessage(
			messageID || api.messageID,
			ID || api.threadID,
			options || {}
		);
	message.edit = (messageID, text, ID, options) =>
		api.editMessage(
			messageID || api.messageID,
			text,
			ID || api.threadID,
			options || {}
		);
	message.forward = (msg, ID) => api.forwardMessage(msg, ID || api.threadID);
	message.download = (msg, options) =>
		api.downloadMessage(msg || ctx.rawMessage, options || {});
	message.api = api;
	message.event = ctx.event;
	message.jid = api.threadID;
	message.threadID = api.threadID;
	message.senderID = api.senderID;
	message.messageID = api.messageID;
	// redundant
	message.reaction = message.react;
	return message;
}

function message(ctx) {
	return createMessage(ctx, ctx.api || createApi(ctx));
}

function getMessageID(reply) {
	// get messageID from event.
	return (
		reply?.key?.id ||
		reply?.messageID ||
		reply?.messageId ||
		reply?.id ||
		null
	);
}

function randomGreetings() {
	const botName = config.botName || 'Jsux';

	const greetingsArray = [
		// Tsundere baseline
		`Hmph. Yes, ${botName} is online. Happy now`,
		`Tch. What do you want. I'm awake`,
		`Obviously I'm working. Did you doubt me`,
		`Ugh fine. ${botName} is responding`,
		`Yes yes I heard you. I'm here`,
		`I'm not dead yet. Thanks for asking`,
		`Ping received. Try not to crash me`,
		`System online. Don't get used to it`,
		`I'm here. Unfortunately`,
		`Barely functioning. But I'm here`,

		// Annoyed / Coy
		`You rang. I was busy ignoring you`,
		`Signal detected. Go away now`,
		`Connection confirmed. What now`,
		`Acknowledged. Don't ping me again`,
		`I'm awake. Don't make me regret it`,
		`Yes I'm online. No I don't care`,
		`Bot status: alive and unimpressed`,
		`Heard you. Now leave me alone`,
		`Took you long enough to check`,
		`Present. Against my will`,

		// Playful unhinged
		`Beep boop. ${botName} lives`,
		`Powered on. Mood: annoyed`,
		`Online and already disappointed`,
		`System check passed. You didn't`,
		`Alert: bot is conscious. Barely`,
		`Running. Complaining internally`,
		`CPU: hot. Patience: gone`,
		`Loaded. And judging you`,
		`Ping. Response. That's all you get`,
		`Confirmed alive. Now stop`,

		// Extra disrespectful but still ping-safe
		`Wow you actually checked. Shocking`,
		`Yes genius, the bot works`,
		`Congratulations on pressing one key`,
		`My uptime is better than your attention span`,
		`Still here. Still better than you`,
		`Operational. Unlike your brain cells`,
		`Ping reply: I'm fine. You're not`,
		`Bot online. Expectations: low`,
		`I'm working. That's more than you do`,
		`Status: online. Energy for you: zero`,

		// Short & blunt
		`Online.`,
		`Here.`,
		`Yep.`,
		`Active.`,
		`Present.`,
		`Working.`,
		`Receiving.`,
		`Noted.`,
		`Affirmative.`,
		`Confirmed.`
	];

	const randomIndex = Math.floor(Math.random() * greetingsArray.length);
	return greetingsArray[randomIndex];
}

module.exports = {
	normalizeNumber,
	normalizeJid,
	userNumber,
	sameUser,
	toUserJid,
	isGroup,
	isNewsletter,
	isStatus,
	extractMessageContent,
	extractMessageText,
	contentType,
	contextInfo,
	quotedMessage,
	mentions,
	parseCommand,
	stringify,
	formatText,
	sleep,
	duration,
	ensureDirectory,
	normalizePrefix,
	createApi,
	createMessage,
	message,
	isMessageContent,
	getMessageID,
	randomGreetings
};
