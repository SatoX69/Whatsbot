/** @format */

'use strict';

const { getEffectivePrefix, roleName } = require('../../lib/access');

const ADMIN_ROLES = new Set(['admin', 'superadmin', 'devs']);
const MAP_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_OUTGOING_TTL_MS = 12_000;
const DEFAULT_GROUP_CACHE_TTL_MS = 300_000;

function createActionHandler({ socket, logger, commandManager, getConfig }) {
	const outgoing = new Map();
	const cooldowns = new Map();
	const groupCache = new Map();
	const groupMetadataPending = new Map();
	const persistedMessages = new WeakMap();

	let bound = false;
	let cleanupTimer = null;
	let upsertHandler = null;
	let reactionHandler = null;

	const cfg = () => getConfig?.() || {};
	const db = () => global.db;
	const u = () => global.utils;

	const stores = () => {
		const database = db();

		return {
			users: database?.usersData,
			threads: database?.threadsData,
			local: database?.localData,
			messages: database?.messagesData,
			usage: database?.commandUsage
		};
	};

	function duration(value, fallback) {
		const number = Number(value);

		return Number.isFinite(number) && number !== 0
			? Math.max(1000, number)
			: fallback;
	}

	function pruneExpired(map, getExpiry = (value) => value, now = Date.now()) {
		for (const [key, value] of map) {
			const expires = Number(getExpiry(value));

			if (!Number.isFinite(expires) || expires <= now) {
				map.delete(key);
			}
		}
	}

	function cleanupMaps() {
		const now = Date.now();

		pruneExpired(outgoing, undefined, now);
		pruneExpired(cooldowns, undefined, now);
		pruneExpired(groupCache, (value) => value?.expires, now);
	}

	function startCleanup() {
		if (cleanupTimer) {
			return;
		}

		cleanupTimer = setInterval(cleanupMaps, MAP_CLEANUP_INTERVAL_MS);
		cleanupTimer.unref?.();
	}

	function stopCleanup() {
		if (!cleanupTimer) {
			return;
		}

		clearInterval(cleanupTimer);
		cleanupTimer = null;
	}

	function outgoingTTL() {
		return duration(
			cfg().runtime?.dedupeOutgoingMs,
			DEFAULT_OUTGOING_TTL_MS
		);
	}

	function trackOwnMessage(key) {
		if (!key?.id) {
			return;
		}

		const now = Date.now();

		outgoing.set(key.id, now + outgoingTTL());
	}

	function consumeOwnMessage(id) {
		if (!id) {
			return false;
		}

		const expires = outgoing.get(id);

		if (expires === undefined) {
			return false;
		}

		outgoing.delete(id);

		return expires > Date.now();
	}

	function botJid() {
		return socket.user?.id || u().toUserJid(cfg().botNumber);
	}

	function matchesConfiguredUser(jid, configuredIDs) {
		if (!jid || !Array.isArray(configuredIDs)) {
			return false;
		}

		const utils = u();

		return configuredIDs.some((id) => id && utils.sameUser(jid, id));
	}

	function isBotDev(jid) {
		return matchesConfiguredUser(jid, cfg().botDevs);
	}

	function isBotAdmin(jid) {
		return isBotDev(jid) || matchesConfiguredUser(jid, cfg().botAdmins);
	}

	function participantJid(participant) {
		if (!participant) {
			return null;
		}

		if (typeof participant === 'string') {
			return participant;
		}

		return (
			participant.id ||
			participant.jid ||
			participant.phoneNumber ||
			participant.lid ||
			null
		);
	}

	function isGroupAdmin(jid, metadata) {
		const participants = metadata?.participants;

		if (!jid || !Array.isArray(participants)) {
			return false;
		}

		const utils = u();

		return participants.some(
			(participant) =>
				ADMIN_ROLES.has(participant?.admin) &&
				utils.sameUser(participantJid(participant), jid)
		);
	}

	async function refreshThreadMetadata(jid, metadata, participants) {
		const threads = stores().threads;

		if (!threads) {
			return;
		}

		try {
			const existing = threads.getSync(jid);

			const adminIDs = participants
				.filter((participant) => ADMIN_ROLES.has(participant?.admin))
				.map(participantJid)
				.filter(Boolean);

			const owner = metadata?.owner || existing?.owner || null;
			const utils = u();

			if (owner && !adminIDs.some((id) => utils.sameUser(id, owner))) {
				adminIDs.unshift(owner);
			}

			const threadName =
				metadata?.subject ||
				metadata?.name ||
				existing?.threadName ||
				existing?.subject ||
				null;

			const threadInfo = {
				threadName,
				adminIDs: adminIDs.length ? adminIDs : existing?.adminIDs || [],
				members: participants,
				isGroup: true
			};

			if (owner) {
				threadInfo.owner = owner;
			}

			if (metadata?.subject || metadata?.name) {
				threadInfo.subject = metadata.subject || metadata.name;
			}

			await threads.refresh(jid, threadInfo);
		} catch (error) {
			logger.debug('ACTION', 'Thread metadata refresh failed', {
				jid,
				error: String(error?.message || error)
			});
		}
	}

	async function getGroupMetadata(jid, fresh = false) {
		const utils = u();

		if (!jid || !utils.isGroup(jid)) {
			return null;
		}

		const now = Date.now();
		const cached = groupCache.get(jid);

		if (!fresh && cached?.expires > now) {
			return cached.data;
		}

		const pending = groupMetadataPending.get(jid);

		if (pending) {
			return pending;
		}

		const maxAge = duration(
			cfg().runtime?.groupMetadataCacheMs,
			DEFAULT_GROUP_CACHE_TTL_MS
		);

		const request = (async () => {
			try {
				const metadata = await socket.groupMetadata(jid);

				if (!metadata || typeof metadata !== 'object') {
					return cached?.data || null;
				}

				const participants = Array.isArray(metadata.participants)
					? metadata.participants
					: [];

				groupCache.set(jid, {
					data: metadata,
					expires: Date.now() + maxAge
				});

				await refreshThreadMetadata(jid, metadata, participants);

				return metadata;
			} catch (error) {
				logger.debug('ACTION', 'Group metadata lookup failed', {
					jid,
					error: String(error?.message || error)
				});

				return cached?.data || null;
			}
		})();

		groupMetadataPending.set(jid, request);

		request.then(
			() => {
				if (groupMetadataPending.get(jid) === request) {
					groupMetadataPending.delete(jid);
				}
			},
			() => {
				if (groupMetadataPending.get(jid) === request) {
					groupMetadataPending.delete(jid);
				}
			}
		);

		return request;
	}

	function isEventExpired(event, maxAge = 5 * 60 * 1000) {
		const timestamp = Number(event?.timestamp);

		if (!Number.isFinite(timestamp) || timestamp <= 0) {
			return true;
		}

		return Date.now() - timestamp > maxAge;
	}

	async function getAdminMode() {
		const local = stores().local;
		const defaultValue = Boolean(cfg().adminModeDefault);

		if (!local) {
			return defaultValue;
		}

		return Boolean(await local.get('adminMode', 'enabled', defaultValue));
	}

	async function setAdminMode(enabled) {
		const local = stores().local;

		if (!local) {
			return false;
		}

		await local.set('adminMode', Boolean(enabled), 'enabled');

		return Boolean(enabled);
	}

	function roleAllowed(role, context) {
		switch (Number(role || 0)) {
			case 0:
				return true;

			case 1:
				return Boolean(context.isGroupAdmin || context.isBotAdmin);

			case 2:
				return Boolean(context.isBotAdmin);

			case 3:
				return Boolean(context.isBotDev);

			default:
				return false;
		}
	}

	function text(key, values = {}) {
		const config = cfg();

		if (config.textlogs?.[key] === false) {
			return '';
		}

		return u().formatText(config.texts?.[key] || '', values);
	}

	function cooldownKey(command, userID, threadID) {
		return [
			command.config?.name || 'unknown',
			userID || '',
			threadID || ''
		].join(':');
	}

	function consumeCooldown(command, userID, threadID, isAdmin) {
		if (isAdmin) {
			return 0;
		}

		const config = cfg();

		const seconds = Number(
			command.config?.countDown ?? config.commandDefaults?.countDown ?? 5
		);

		if (!Number.isFinite(seconds) || seconds <= 0) {
			return 0;
		}

		const key = cooldownKey(command, userID, threadID);
		const now = Date.now();
		const expires = cooldowns.get(key) || 0;

		if (expires > now) {
			return expires - now;
		}

		cooldowns.set(key, now + seconds * 1000);

		return 0;
	}

	function buildQuoted(rawMessage) {
		const quoted = u().quotedMessage(rawMessage);

		if (!quoted) {
			return null;
		}

		return {
			messageID: quoted.key?.id || quoted.messageID || null,
			senderID: quoted.senderID || null,
			body: quoted.body || '',
			key: quoted.key || null,
			raw: quoted.message || null
		};
	}

	function getStoredMessage(messageID) {
		if (!messageID) {
			return null;
		}

		const messages = stores().messages;

		if (!messages) {
			return null;
		}

		try {
			return messages.getSync(messageID) || null;
		} catch {
			return null;
		}
	}

	function parseStoredRaw(raw) {
		if (!raw) {
			return null;
		}

		if (Buffer.isBuffer(raw)) {
			raw = raw.toString('utf8');
		} else if (typeof raw === 'object') {
			return raw;
		}

		if (typeof raw !== 'string') {
			return null;
		}

		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}

	function buildReactionQuoted(targetKey) {
		if (!targetKey?.id) {
			return null;
		}

		const stored = getStoredMessage(targetKey.id);

		const fallbackSenderID = targetKey.fromMe
			? botJid()
			: targetKey.participantAlt ||
				targetKey.participant ||
				targetKey.remoteJid ||
				null;

		const raw = parseStoredRaw(stored?.raw_json);

		return {
			messageID: targetKey.id,
			senderID: stored?.userID || fallbackSenderID,
			body: String(stored?.body || '').trim(),
			key: targetKey,
			raw
		};
	}

	function applyBotRoles(event) {
		event.isBotDev = isBotDev(event.senderID);
		event.isBotAdmin =
			event.isBotDev ||
			matchesConfiguredUser(event.senderID, cfg().botAdmins);
		event.isAdmin = event.isBotAdmin;
		event.isGroupAdmin = Boolean(
			event.isGroup && isGroupAdmin(event.senderID, event.groupMetadata)
		);

		return event;
	}

	function buildEvent(
		rawMessage,
		{ threadName = null, groupMetadata = null } = {}
	) {
		const key = rawMessage?.key || {};
		const threadID = key.remoteJid || '';
		const isSelf = Boolean(key.fromMe);
		const utils = u();
		const message = rawMessage?.message || {};
		const quoted = buildQuoted(rawMessage);

		const event = {
			type: 'message',
			messageID: key.id || '',
			senderID: isSelf
				? botJid()
				: key.participantAlt || key.participant || threadID,
			participantID: key.participant || key.participantAlt || null,
			threadID,
			threadName:
				threadName ||
				groupMetadata?.subject ||
				groupMetadata?.name ||
				null,
			body: String(utils.extractMessageText(message) || '').trim(),
			repliedMessageID: quoted?.messageID || null,
			repliedMessageBody: quoted?.body || '',
			repliedMessageSenderID: quoted?.senderID || null,
			quoted,
			timestamp:
				Number(rawMessage?.messageTimestamp) * 1000 || Date.now(),
			isSelf,
			isGroup: Boolean(utils.isGroup(threadID)),
			isNewsletter: Boolean(utils.isNewsletter(threadID)),
			isStatus: Boolean(utils.isStatus(threadID)),
			pushName: rawMessage?.pushName || null,
			mentions: utils.mentions(rawMessage),
			messageType: utils.contentType(message),
			contextInfo: utils.contextInfo(message),
			groupMetadata,
			key,
			raw: rawMessage
		};

		return applyBotRoles(event);
	}

	function getReactionSenderID(reactionUpdate) {
		const targetKey = reactionUpdate?.key || {};
		const reactionKey = reactionUpdate?.reaction?.key || {};

		const threadID = targetKey.remoteJid || reactionKey.remoteJid || '';

		const participant =
			reactionKey.participantAlt || reactionKey.participant || null;

		if (reactionKey.fromMe) {
			return botJid();
		}

		if (u().isGroup(threadID)) {
			return participant;
		}

		return (
			participant ||
			reactionKey.remoteJid ||
			targetKey.participantAlt ||
			targetKey.participant ||
			targetKey.remoteJid ||
			null
		);
	}

	function reactionTimestamp(reaction) {
		const value = reaction?.senderTimestampMs;

		if (value === undefined || value === null) {
			return Date.now();
		}

		const timestamp = Number(value);

		return Number.isFinite(timestamp) && timestamp > 0
			? timestamp
			: Date.now();
	}

	function buildReactionEvent(
		reactionUpdate,
		{ threadName = null, groupMetadata = null } = {}
	) {
		const targetKey = reactionUpdate?.key || {};
		const reaction = reactionUpdate?.reaction || {};
		const reactionKey = reaction.key || {};

		const threadID = targetKey.remoteJid || reactionKey.remoteJid || '';

		if (!threadID) {
			return null;
		}

		const utils = u();
		const reactionText =
			typeof reaction.text === 'string' ? reaction.text.trim() : '';

		const quoted = buildReactionQuoted(targetKey);
		const senderID = getReactionSenderID(reactionUpdate);
		const timestamp = reactionTimestamp(reaction);

		const event = {
			type: 'reaction',
			messageID:
				reactionKey.id ||
				[
					targetKey.id || 'unknown',
					senderID || 'unknown',
					timestamp
				].join(':'),
			senderID,
			participantID:
				reactionKey.participant || reactionKey.participantAlt || null,
			threadID,
			threadName:
				threadName ||
				groupMetadata?.subject ||
				groupMetadata?.name ||
				null,
			body: reactionText,
			reaction: reactionText,
			reactionText,
			isReactionRemoval: !reactionText,
			reactedMessageID: targetKey.id || null,
			reactedMessageKey: targetKey,
			repliedMessageID: targetKey.id || null,
			repliedMessageBody: quoted?.body || '',
			repliedMessageSenderID: quoted?.senderID || null,
			quoted,
			timestamp,
			isSelf: Boolean(reactionKey.fromMe),
			isGroup: Boolean(utils.isGroup(threadID)),
			isNewsletter: Boolean(utils.isNewsletter(threadID)),
			isStatus: Boolean(utils.isStatus(threadID)),
			pushName: reactionUpdate?.pushName || null,
			mentions: [],
			messageType: 'reaction',
			contextInfo: null,
			groupMetadata,
			key: targetKey,
			reactionKey,
			reactionUpdate,
			raw: reactionUpdate
		};

		return applyBotRoles(event);
	}

	async function persistMessage(rawMessage, event) {
		const config = cfg();
		const messages = stores().messages;

		if (!config.persistMessages || !messages || !event?.messageID) {
			return;
		}

		const cacheable = rawMessage !== null && typeof rawMessage === 'object';

		if (cacheable) {
			const previous = persistedMessages.get(rawMessage);

			if (previous) {
				return previous;
			}
		}

		const operation = (async () => {
			try {
				await messages.create({
					messageID: event.messageID,
					threadID: event.threadID,
					userID: event.senderID,
					participantID: event.participantID,
					fromMe: event.isSelf,
					message_type: event.messageType,
					body: event.body,
					timestamp: event.timestamp,
					raw_json: u().stringify(rawMessage)
				});

				return true;
			} catch (error) {
				if (error?.name === 'DATA_ALREADY_EXISTS') {
					return true;
				}

				logger.debug('ACTION', 'Message persistence failed', {
					messageID: event.messageID,
					error: String(error?.message || error)
				});

				return false;
			}
		})();

		if (cacheable) {
			persistedMessages.set(rawMessage, operation);
		}

		const success = await operation;

		if (
			cacheable &&
			!success &&
			persistedMessages.get(rawMessage) === operation
		) {
			persistedMessages.delete(rawMessage);
		}
	}

	async function validateUsers(event, rawMessage) {
		const users = stores().users;

		if (!users || !event?.senderID) {
			return;
		}

		try {
			const existing = users.getSync(event.senderID);
			const pushName = event.pushName || existing?.pushName || null;

			const update = {
				username: pushName || existing?.username || null,
				name: pushName || existing?.name || null,
				phone: u().userNumber(event.senderID),
				pushName,
				verifiedName:
					rawMessage?.verifiedBizName ||
					rawMessage?.verifiedBusinessName ||
					existing?.verifiedName ||
					null,
				isAdmin: Number(isBotAdmin(event.senderID)),
				isDev: Number(isBotDev(event.senderID))
			};

			if (!existing) {
				await users.create(event.senderID, {
					...update,
					settings: {
						isBanned: false
						//  warn: 0
					}
				});

				logger.info('NEW_USER', 'User added to database', {
					userID: event.senderID,
					name: update.username || update.name || 'Unnamed'
				});

				return;
			}

			const changes = {};

			for (const [key, value] of Object.entries(update)) {
				if (value !== undefined && existing[key] !== value) {
					changes[key] = value;
				}
			}

			const existingSettings = existing.settings;

			if (
				!existingSettings ||
				typeof existingSettings !== 'object' ||
				!Object.prototype.hasOwnProperty.call(
					existingSettings,
					'isBanned'
				)
			) {
				changes.settings = {
					...(existingSettings && typeof existingSettings === 'object'
						? existingSettings
						: {}),
					isBanned: existingSettings?.isBanned ?? false
				};
			}

			if (Object.keys(changes).length) {
				await users.set(event.senderID, changes);
			}
		} catch (error) {
			logger.debug('ACTION', 'User validation failed', {
				userID: event.senderID,
				error: String(error?.message || error)
			});
		}
	}

	async function validateThreads(event) {
		const threads = stores().threads;

		if (!threads || !event?.threadID) {
			return;
		}

		try {
			const existing = threads.getSync(event.threadID);
			const isGroup = Boolean(event.isGroup);

			if (!existing) {
				await threads.create(event.threadID, {
					threadName: event.threadName || null,
					adminIDs: isGroup ? [] : null,
					imageSrc: null,
					approvalMode: false,
					members: [],
					banned: false,
					settings: {
						isBanned: false
					},
					isGroup,
					data: {}
				});

				logger.info('NEW_THREAD', 'Thread added to database', {
					threadID: event.threadID
				});

				return;
			}

			if (Boolean(existing.isGroup) !== isGroup) {
				await threads.set(event.threadID, isGroup, 'isGroup');
			}
		} catch (error) {
			logger.debug('ACTION', 'Thread validation failed', {
				threadID: event.threadID,
				error: String(error?.message || error)
			});
		}
	}

	async function resolveMetadata(event, groupMetadata) {
		if (groupMetadata) {
			return groupMetadata;
		}

		if (event?.groupMetadata) {
			return event.groupMetadata;
		}

		if (event?.isGroup) {
			return getGroupMetadata(event.threadID);
		}

		return null;
	}

	async function getAccess(event, groupMetadata) {
		const config = cfg();
		const botDev = isBotDev(event.senderID);
		const botAdmin =
			botDev || matchesConfiguredUser(event.senderID, config.botAdmins);

		const groupAdmin = Boolean(
			event.isGroup && isGroupAdmin(event.senderID, groupMetadata)
		);

		const adminMode = await getAdminMode();
		const { threads, users } = stores();

		const approvalMode = threads
			? Boolean(await threads.get(event.threadID, 'approvalMode', false))
			: false;

		const user = users ? await users.get(event.senderID) : null;

		const banned = user?.settings?.isBanned ?? false;

		const allowedLocation = event.isNewsletter
			? config.commandDefaults?.allowNewsletter !== false
			: event.isGroup
				? config.commandDefaults?.allowGroup !== false
				: config.commandDefaults?.allowPrivate !== false;

		return {
			adminMode,
			approvalMode,
			isBotAdmin: botAdmin,
			isBotDev: botDev,
			isGroupAdmin: groupAdmin,
			isAdmin: botAdmin,
			isGroup: Boolean(event.isGroup),
			isNewsletter: Boolean(event.isNewsletter),
			allowedLocation,
			banned,
			allowed:
				allowedLocation &&
				(!adminMode || botAdmin) &&
				(approvalMode || botAdmin)
		};
	}

	function shouldProcess(rawMessage, upsertType, eventType = 'message') {
		const config = cfg();

		if (eventType === 'reaction') {
			const targetKey = rawMessage?.key || {};
			const reactionKey = rawMessage?.reaction?.key || {};

			const threadID = targetKey.remoteJid || reactionKey.remoteJid;

			if (!threadID) {
				return false;
			}

			if (config.ignoreStatus !== false && u().isStatus(threadID)) {
				return false;
			}

			const selfReaction =
				reactionKey.fromMe &&
				config.selfBot?.enabled === true &&
				config.selfBot?.allowFromMeCommands === true;

			if (reactionKey.fromMe && !selfReaction) {
				return false;
			}

			return true;
		}

		const key = rawMessage?.key || {};
		const threadID = key.remoteJid;

		if (!threadID) {
			return false;
		}

		if (config.ignoreStatus !== false && u().isStatus(threadID)) {
			return false;
		}

		const selfCommand =
			key.fromMe &&
			config.selfBot?.enabled === true &&
			config.selfBot?.allowFromMeCommands === true;

		if (key.fromMe && !selfCommand) {
			return false;
		}

		return upsertType === 'notify';
	}

	function lookupCommand(name) {
		const caseSensitive = cfg().commandDefaults?.caseSensitive === true;

		const commands = commandManager.commands;
		const normalize = (value) =>
			caseSensitive ? value : value.toLowerCase();

		const input = normalize(String(name).trim());
		const exact = commands.get(input);

		if (exact) return exact;

		const levenshtein = (a, b) => {
			const row = Array.from({ length: b.length + 1 }, (_, i) => i);

			for (let i = 1; i <= a.length; i++) {
				let diagonal = row[0];
				row[0] = i;

				for (let j = 1; j <= b.length; j++) {
					const previous = row[j];
					row[j] = Math.min(
						row[j] + 1,
						row[j - 1] + 1,
						diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
					);
					diagonal = previous;
				}
			}

			return row[b.length];
		};

		const matches = [];

		for (const [key, command] of commands) {
			const names = [
				key,
				...(Array.isArray(command.aliases) ? command.aliases : []),
				...(Array.isArray(command.config?.aliases)
					? command.config.aliases
					: [])
			];

			const distance = Math.min(
				...names.map((alias) =>
					levenshtein(input, normalize(String(alias)))
				)
			);

			const threshold = Math.max(2, Math.floor(input.length * 0.4));

			if (distance <= threshold) {
				matches.push({ command, distance });
			}
		}

		matches.sort((a, b) => a.distance - b.distance);

		return matches.length
			? {
					suggestions: matches
						.slice(0, 5)
						.map(({ command }) => command)
				}
			: null;
	}

	function createContext({
		rawMessage = null,
		event,
		upsertType,
		command = null,
		commandName = null,
		args = [],
		input = '',
		prefix = null,
		groupMetadata = null,
		access,
		reply = undefined
	}) {
		const data = stores();
		const config = cfg();

		const context = {
			socket,
			client: global.client,
			rawMessage,
			messageKey: event.key,
			upsertType,
			event,
			command,
			commandName,
			commandManager,
			eventManager: global.client?.eventManager,
			args,
			input,
			body: event.body || '',
			prefix,
			isSelf: event.isSelf,
			isGroup: access.isGroup,
			isNewsletter: access.isNewsletter,
			groupMetadata,
			adminMode: access.adminMode,
			approvalMode: access.approvalMode,
			config,
			usersData: data.users,
			threadsData: data.threads,
			localData: data.local,
			logger,
			log: logger,
			trackOutgoing: trackOwnMessage,
			consumeOwnMessage,
			getGroupMetadata,
			isAdmin: access.isAdmin,
			isBotAdmin: access.isBotAdmin,
			isBotDev: access.isBotDev,
			isGroupAdmin: access.isGroupAdmin
		};

		if (reply !== undefined) {
			context.Reply = reply;
		}

		context.api = u().createApi(context);
		context.message = u().createMessage(context, context.api);

		return context;
	}

	async function prepare({ event, groupMetadata }) {
		const metadata = await resolveMetadata(event, groupMetadata);

		if (metadata) {
			event.groupMetadata = metadata;
			event.threadName ||= metadata.subject || metadata.name || null;
		}

		return metadata;
	}

	async function preparePrefix(event) {
		const data = stores();

		const prefix = getEffectivePrefix(
			data.threads,
			data.local,
			event.threadID,
			cfg().prefix,
			u()
		);

		event.prefix = prefix;

		return prefix;
	}

	async function sendPermission(context) {
		const message = text('permission');

		if (message) {
			await context.message.reply(message);
		}
	}

	async function sendError(context, error) {
		if (cfg().textlogs?.commandError === false) {
			return;
		}

		const prefix = cfg().texts?.error || 'Error';

		try {
			await context.message.send(
				`${prefix}\n${String(error?.stack || error)}`
			);
		} catch {
			// Sending an error response must not cause another failure.
		}
	}

	async function recordUsage(commandName, event, success, error = null) {
		const usage = stores().usage;

		if (!usage) {
			return;
		}

		try {
			await usage.create({
				command_name: commandName,
				threadID: event.threadID,
				userID: event.senderID,
				fromMe: event.isSelf,
				success,
				...(error
					? {
							error: String(error?.stack || error)
						}
					: {})
			});
		} catch (usageError) {
			logger.debug('ACTION', 'Command usage logging failed', {
				command: commandName,
				error: String(usageError?.message || usageError)
			});
		}
	}

	async function spamTracking(event) {
		if (event.isSelf || isBotAdmin(event.senderID))
			return {
				ban: false,
				warn: false
			};
		const WINDOW_MS = 5000;
		const SPAM_THRESHOLD = 2;
		const WARNING_LIMIT = 3;
		const TRACKER_TTL_MS = 5 * 60 * 1000;

		const senderID = event?.senderID;
		const timestamp = Date.now();

		if (!senderID || !Number.isFinite(timestamp) || timestamp <= 0) {
			return { warn: false, ban: false, warns: 0, rapidMessageCount: 0 };
		}

		const tracker =
			global.temp.spamTracker instanceof Map
				? global.temp.spamTracker
				: (global.temp.spamTracker = new Map());

		const users = global.db?.usersData;

		let record = tracker.get(senderID);
		try {
			if (!record) {
				const user = await users?.get(senderID);
				const storedWarns = Number(user?.settings?.warn) || 0;

				record = {
					timestamps: [],
					warns: Math.max(0, Math.floor(storedWarns)),
					lastWarnAt: 0,
					lastActivityAt: timestamp
				};
			}

			const recentTimestamps = record.timestamps.filter(
				(previous) =>
					Number.isFinite(previous) &&
					timestamp >= previous &&
					timestamp - previous < WINDOW_MS
			);

			const rapidMessageCount = recentTimestamps.length + 1;

			record.timestamps = [...recentTimestamps, timestamp];
			record.lastActivityAt = timestamp;

			let warn = false;
			let ban = false;

			if (
				rapidMessageCount > SPAM_THRESHOLD &&
				timestamp - record.lastWarnAt >= WINDOW_MS
			) {
				record.warns++;
				record.lastWarnAt = timestamp;
				warn = true;
				ban = record.warns >= WARNING_LIMIT;

				if (users) {
					await users.set(senderID, record.warns, 'settings.warn');

					if (ban) {
						await users.set(senderID, true, 'settings.isBanned');
					}
				}

				logger.warn(
					'ACTION',
					ban ? 'User banned for spam' : 'User warned for spam',
					{
						senderID,
						warns: record.warns,
						rapidMessageCount
					}
				);
			}

			tracker.set(senderID, record);

			for (const [id, entry] of tracker) {
				if (timestamp - entry.lastActivityAt > TRACKER_TTL_MS) {
					tracker.delete(id);
				}
			}

			return {
				warn,
				ban,
				warns: record.warns,
				rapidMessageCount
			};
		} catch (error) {
			console.error(error);
		}
	}

	async function runOnStart({
		rawMessage,
		upsertType = 'notify',
		event,
		groupMetadata = null
	}) {
		if (event?.type !== 'message' || !rawMessage?.key) {
			return;
		}
  console.log(event.senderID);
		if (!shouldProcess(rawMessage, upsertType, 'message')) {
			return;
		}

		const metadata = await prepare({
			event,
			groupMetadata
		});

		const access = await getAccess(event, metadata);

		if (!access.allowed || access.banned) {
			return;
		}

		await persistMessage(rawMessage, event);

		const prefix = await preparePrefix(event);
		const parsed = u().parseCommand(event.body, prefix);

		if (!parsed) return;

		const reply = (message) =>
			u()
				.createApi({
					socket,
					rawMessage,
					chatJid: event.threadID,
					senderJid: event.senderID,
					event,
					trackOutgoing: trackOwnMessage
				})
				.reply(message);

		if (parsed.prefixOnly) {
			return reply(global.utils.randomGreetings());
		}

		const command = lookupCommand(parsed.command);

		// Track only recognized, executable bot commands.
		if (command && !command.suggestions) {
			const spam = await spamTracking(event);

			if (!spam) {
				logger.error('ACTION', 'Spam tracker returned no result', {
					senderID: event.senderID
				});
			} else {
				if (spam.ban) {
					await global.db.usersData.set(
						event.senderID,
						true,
						'settings.isBanned'
					);

					await reply(
						'You have been permanently blacklisted from the system.'
					);

					return;
				}

				if (spam.warn) {
					await reply(
						'Please slow down.\nYou have been flagged for spam.\nMultiple flags will result in a system-wide blacklist.'
					);

					// Stop the command that triggered the warning.
					return;
				}
			}
		} else if (command.suggestions)
			return await reply(
				`No such command found.\nYou sure you don't mean "*/${command.suggestions[0].config.name}*"`
			);
		if (!command) {
			const standard = text('cmdnotfound');

			if (standard) {
				await u()
					.createApi({
						socket,
						rawMessage,
						chatJid: event.threadID,
						senderJid: event.senderID,
						event,
						trackOutgoing: trackOwnMessage
					})
					.reply(standard);
			}

			logger.debug('ACTION', 'Unknown command', {
				command: parsed?.command,
				threadID: event.threadID,
				senderID: event.senderID
			});

			return;
		}

		const metadataConfig = command.config || {};
		const commandName = metadataConfig.name || parsed.command;

		const context = createContext({
			rawMessage,
			event,
			upsertType,
			command,
			commandName,
			args: parsed.args || [],
			input: parsed.input || '',
			prefix,
			groupMetadata: metadata,
			access
		});

		if (!roleAllowed(metadataConfig.role, context)) {
			await sendPermission(context);
			return;
		}

		const remaining = consumeCooldown(
			command,
			event.senderID,
			event.threadID,
			access.isBotAdmin
		);

		if (remaining > 0) {
			const message = text('cooldown', {
				time: Math.ceil(remaining / 1000)
			});

			if (message) {
				await context.message.reply(message);
			}

			return;
		}

		if (typeof command.onStart !== 'function') {
			return;
		}

		const started = Date.now();

		try {
			await command.onStart(context);

			logger.info('ACTION', `Command ${commandName} completed`, {
				threadID: event.threadID,
				senderID: event.senderID,
				fromMe: event.isSelf,
				args: context.args,
				role: roleName(Number(metadataConfig.role || 0)),
				durationMs: Date.now() - started
			});

			await recordUsage(commandName, event, true);
		} catch (error) {
			logger.error('ACTION', `Command ${commandName} failed`, error);

			await recordUsage(commandName, event, false, error);
			await sendError(context, error);
		}
	}

	async function runOnLoad() {
		const commands = [...commandManager.commands.values()];

		for (const command of commands) {
			if (typeof command?.onLoad !== 'function') {
				continue;
			}

			const metadataConfig = command.config || {};
			const commandName = metadataConfig.name || 'unknown';

			try {
				const context = {
					socket,
					command,
					commandName,
					commandManager,
					config: cfg()
				};

				context.api = u().createApi(context);

				await command.onLoad(context);

				logger.debug('ACTION', `onLoad ${commandName} handled`);
			} catch (error) {
				logger.error('ACTION', `onLoad ${commandName} failed`, error);
			}
		}
	}

	async function runOnChat({
		rawMessage,
		upsertType = 'notify',
		event,
		groupMetadata = null
	}) {
		if (!rawMessage || !event) {
			return;
		}

		const eventType = event.type || 'message';

		if (!shouldProcess(rawMessage, upsertType, eventType)) {
			return;
		}

		if (
			eventType === 'message' &&
			rawMessage.key?.id &&
			consumeOwnMessage(rawMessage.key.id)
		) {
			return;
		}

		const metadata = await prepare({
			event,
			groupMetadata
		});

		const access = await getAccess(event, metadata);

		if (eventType === 'message') {
			await persistMessage(rawMessage, event);
		}

		const prefix = await preparePrefix(event);
		const body = String(event.body || '').trim();
		const args = body ? body.split(/\s+/) : [];

		for (const command of commandManager.commands.values()) {
			if (typeof command?.onChat !== 'function') {
				continue;
			}

			const metadataConfig = command.config || {};
			const commandName = metadataConfig.name || 'unknown';

			const context = createContext({
				rawMessage,
				event,
				upsertType,
				command,
				commandName,
				args,
				input: body,
				prefix,
				groupMetadata: metadata,
				access
			});

			try {
				await command.onChat(context);

				logger.debug('ACTION', `onChat ${commandName} handled`, {
					type: event.type,
					threadID: event.threadID,
					senderID: event.senderID,
					reaction:
						event.type === 'reaction'
							? event.reactionText
							: undefined,
					targetMessageID:
						event.type === 'reaction'
							? event.reactedMessageID
							: undefined
				});
			} catch (error) {
				logger.error('ACTION', `onChat ${commandName} failed`, error);
				await sendError(context, error);
			}
		}
	}

	async function runOnReply({
		rawMessage,
		upsertType = 'notify',
		event,
		groupMetadata = null
	}) {
		if (event?.type !== 'message' || !rawMessage?.key) {
			return;
		}

		if (!shouldProcess(rawMessage, upsertType, 'message')) {
			return;
		}

		const onReply = global.whatsbot?.onReply;

		if (!onReply?.size) {
			return;
		}

		if (rawMessage.key.id && consumeOwnMessage(rawMessage.key.id)) {
			return;
		}

		const metadata = await prepare({
			event,
			groupMetadata
		});

		const access = await getAccess(event, metadata);

		if (!access.allowed) {
			return;
		}

		const messageID =
			event.quoted?.messageID ||
			event.quoted?.stanzaId ||
			event.quoted?.id;

		if (!messageID) {
			return;
		}

		const reply = onReply.get(messageID);

		if (!reply) {
			return;
		}

		await persistMessage(rawMessage, event);

		const registeredName = reply.commandName;

		if (!registeredName) {
			logger.warn('ACTION', 'Reply handler has no command name', {
				messageID,
				threadID: event.threadID
			});

			return;
		}

		const command = lookupCommand(registeredName);
		const metadataConfig = command?.config || {};
		const commandName = metadataConfig.name || registeredName;

		if (typeof command?.onReply !== 'function') {
			const standard = text('cmdnotfound');

			if (standard) {
				await u()
					.createApi({
						socket,
						rawMessage,
						chatJid: event.threadID,
						senderJid: event.senderID,
						event,
						trackOutgoing: trackOwnMessage
					})
					.reply(standard);
			}

			logger.debug('ACTION', 'Unknown reply command', {
				command: registeredName,
				threadID: event.threadID,
				senderID: event.senderID
			});

			return;
		}

		const body = String(event.body || '').trim();
		const prefix = await preparePrefix(event);

		const context = createContext({
			rawMessage,
			event,
			upsertType,
			command,
			commandName,
			args: body ? body.split(/\s+/) : [],
			input: body,
			prefix,
			groupMetadata: metadata,
			access,
			reply
		});

		if (!roleAllowed(metadataConfig.role, context)) {
			await sendPermission(context);
			return;
		}

		const started = Date.now();

		try {
			await command.onReply(context);

			logger.info('ACTION', `onReply ${commandName} completed`, {
				threadID: event.threadID,
				senderID: event.senderID,
				fromMe: event.isSelf,
				args: context.args,
				durationMs: Date.now() - started
			});
		} catch (error) {
			logger.error('ACTION', `onReply ${commandName} failed`, error);
			await sendError(context, error);
		}
	}

	async function runOnAnyEvent({ rawMessage, event }) {
		if (!rawMessage || !event?.threadID) {
			return;
		}

		await validateUsers(event, rawMessage);
		await validateThreads(event);
	}

	async function dispatchMessage(rawMessage, upsertType) {
		const key = rawMessage?.key;
		const threadID = key?.remoteJid;

		if (!threadID) {
			return;
		}

		if (key.id && consumeOwnMessage(key.id)) {
			return;
		}

		const groupMetadata = u().isGroup(threadID)
			? await getGroupMetadata(threadID)
			: null;

		const event = buildEvent(rawMessage, {
			groupMetadata
		});

		if (isEventExpired(event)) {
			global.expiredEventIndex =
				Number(global.expiredEventIndex || 0) + 1;

			return;
		}

		const context = {
			rawMessage,
			upsertType,
			event,
			groupMetadata
		};

		await runOnAnyEvent(context);
		await runOnStart(context);
		await runOnChat(context);
		await runOnReply(context);
	}

	async function dispatchReaction(reactionUpdate) {
		if (!reactionUpdate) {
			return;
		}

		const targetKey = reactionUpdate.key || {};
		const reactionKey = reactionUpdate.reaction?.key || {};

		const threadID = targetKey.remoteJid || reactionKey.remoteJid;

		if (!threadID) {
			return;
		}

		const groupMetadata = u().isGroup(threadID)
			? await getGroupMetadata(threadID)
			: null;

		const event = buildReactionEvent(reactionUpdate, {
			groupMetadata
		});

		if (!event?.threadID) {
			return;
		}

		const context = {
			rawMessage: reactionUpdate,
			upsertType: 'reaction',
			event,
			groupMetadata
		};

		await runOnAnyEvent(context);
		await runOnChat(context);
	}

	function removeListener(eventName, handler) {
		if (!handler) {
			return;
		}

		if (typeof socket.ev.off === 'function') {
			socket.ev.off(eventName, handler);
			return;
		}

		if (typeof socket.ev.removeListener === 'function') {
			socket.ev.removeListener(eventName, handler);
		}
	}

	function bind() {
		if (bound) {
			return;
		}

		bound = true;
		startCleanup();

		upsertHandler = async ({ messages, type }) => {
			for (const rawMessage of Array.isArray(messages) ? messages : []) {
				try {
					await dispatchMessage(rawMessage, type);
				} catch (error) {
					logger.error(
						'ACTION',
						'messages.upsert processing failed',
						error
					);
				}
			}
		};

		reactionHandler = async (reactions) => {
			for (const reactionUpdate of Array.isArray(reactions)
				? reactions
				: []) {
				try {
					await dispatchReaction(reactionUpdate);
				} catch (error) {
					logger.error(
						'ACTION',
						'messages.reaction processing failed',
						error
					);
				}
			}
		};

		socket.ev.on('messages.upsert', upsertHandler);
		socket.ev.on('messages.reaction', reactionHandler);
	}

	function shutdown() {
		removeListener('messages.upsert', upsertHandler);
		removeListener('messages.reaction', reactionHandler);

		upsertHandler = null;
		reactionHandler = null;
		bound = false;

		stopCleanup();

		outgoing.clear();
		cooldowns.clear();
		groupCache.clear();
		groupMetadataPending.clear();
	}

	startCleanup();

	return {
		bind,
		shutdown,

		runOnChat,
		runOnStart,
		runOnAnyEvent,
		runOnReply,
		runOnLoad,

		trackOutgoing: trackOwnMessage,
		consumeOwnMessage,

		getGroupMetadata,

		isBotAdmin,
		isBotDev,
		isGroupAdmin,

		buildEvent,
		buildReactionEvent,

		getAdminMode,
		setAdminMode,

		createContext,
		getAccess,
		lookupCommand,
		roleAllowed
	};
}

module.exports = createActionHandler;
