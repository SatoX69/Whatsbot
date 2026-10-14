'use strict';

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const EVENT_DIR = path.join(process.cwd(), 'scripts', 'events');
const EVENT_NAME = 'event';
const MAX_CODE_SIZE = 4 * 1024 * 1024;
const HTTP_TIMEOUT = 15_000;
const CONFIRMATION_TTL = 60_000;

const logger = global.log || console;

function normalizeFilename(value) {
	const filename = String(value || '').trim();

	if (!filename) {
		throw new Error('Filename is required.');
	}

	if (!/^[A-Za-z0-9_-]+\.js$/i.test(filename)) {
		throw new Error(
			'Invalid filename. Use only letters, numbers, _ or - and the .js extension.'
		);
	}

	return filename;
}

function getEventPath(filename) {
	const root = path.resolve(EVENT_DIR);
	const target = path.resolve(root, filename);

	if (
		target === root ||
		path.dirname(target) !== root ||
		!target.startsWith(`${root}${path.sep}`)
	) {
		throw new Error('Invalid event path.');
	}

	return target;
}

function eventExists(filename) {
	return fs.existsSync(getEventPath(filename));
}

function getEventName(filename) {
	return path.basename(filename, '.js').toLowerCase();
}

function normalizeName(value) {
	return String(value || '')
		.trim()
		.toLowerCase();
}

function normalizeSource(source) {
	if (typeof source !== 'string') {
		throw new Error('Event source must be text.');
	}

	source = source.replace(/^\uFEFF/, '').trim();

	if (!source) {
		throw new Error('Event source is empty.');
	}

	if (Buffer.byteLength(source, 'utf8') > MAX_CODE_SIZE) {
		throw new Error('Event source exceeds the 4 MB limit.');
	}

	if (source.includes('\0')) {
		throw new Error('Event source contains invalid binary data.');
	}

	const beginning = source.slice(0, 2000).toLowerCase();

	if (
		beginning.includes('<!doctype html') ||
		beginning.includes('<html') ||
		beginning.includes('<head') ||
		beginning.includes('<body')
	) {
		throw new Error('Source does not appear to be JavaScript.');
	}

	if (!/\b(?:module\.exports|exports)\b/.test(source)) {
		throw new Error(
			'Source does not appear to be a CommonJS event module.'
		);
	}

	return `${source}\n`;
}

async function fetchRemoteSource(url) {
	let parsed;

	try {
		parsed = new URL(url);
	} catch {
		throw new Error('Invalid source URL.');
	}

	if (!['http:', 'https:'].includes(parsed.protocol)) {
		throw new Error('Source URL must use HTTP or HTTPS.');
	}

	if (parsed.username || parsed.password) {
		throw new Error('Authenticated source URLs are not allowed.');
	}

	try {
		const response = await axios.get(parsed.href, {
			responseType: 'text',
			timeout: HTTP_TIMEOUT,
			maxContentLength: MAX_CODE_SIZE,
			maxBodyLength: MAX_CODE_SIZE,
			maxRedirects: 5,
			validateStatus: status => status >= 200 && status < 300,
			headers: {
				Accept:
					'text/plain, text/javascript, application/javascript, */*',
				'User-Agent': 'WhatsApp-Bot-Event-Installer/1.0'
			}
		});

		if (typeof response?.data !== 'string') {
			throw new Error('Source response was not text.');
		}

		return response.data;
	} catch (error) {
		if (error instanceof Error && error.message === 'Source response was not text.') {
			throw error;
		}

		if (error.response) {
			throw new Error(
				`Source request failed with HTTP ${error.response.status}.`
			);
		}

		if (
			error.code === 'ECONNABORTED' ||
			error.code === 'ETIMEDOUT'
		) {
			throw new Error('Source request timed out.');
		}

		throw new Error(
			`Unable to reach source: ${error.message || 'Unknown error'}`
		);
	}
}

async function resolveSource(args) {
	const sourceArgs = args.slice(2);

	if (!sourceArgs.length) {
		throw new Error('Provide JavaScript code or a source URL.');
	}

	if (
		sourceArgs.length === 1 &&
		/^https?:\/\//i.test(sourceArgs[0])
	) {
		return {
			type: 'url',
			value: await fetchRemoteSource(sourceArgs[0])
		};
	}

	if (/^https?:\/\//i.test(sourceArgs[0])) {
		throw new Error(
			'When using a source URL, it must be the only source argument.'
		);
	}

	return {
		type: 'code',
		value: sourceArgs.join(' ')
	};
}

function writeEventFile(filename, source, overwrite = false) {
	const target = getEventPath(filename);

	if (!overwrite && fs.existsSync(target)) {
		throw new Error(`An event named ${filename} already exists.`);
	}

	fs.mkdirSync(EVENT_DIR, {
		recursive: true
	});

	const tempPath = path.join(
		EVENT_DIR,
		`.${filename}.${process.pid}.${Date.now()}.tmp`
	);

	try {
		fs.writeFileSync(tempPath, source, {
			encoding: 'utf8',
			flag: 'wx',
			mode: 0o644
		});

		fs.renameSync(tempPath, target);
	} catch (error) {
		try {
			if (fs.existsSync(tempPath)) {
				fs.unlinkSync(tempPath);
			}
		} catch {}

		throw error;
	}

	return target;
}

function readEventFile(filename) {
	const target = getEventPath(filename);

	if (!fs.existsSync(target)) {
		return null;
	}

	return fs.readFileSync(target, 'utf8');
}

function removeEventFile(filename) {
	const target = getEventPath(filename);

	try {
		if (fs.existsSync(target)) {
			fs.unlinkSync(target);
		}
	} catch (error) {
		logger.error(
			`[event] Failed to remove "${filename}":`,
			error
		);
	}
}

function getActiveEvents(eventManager) {
	if (
		!eventManager ||
		typeof eventManager.list !== 'function'
	) {
		throw new Error(
			'Event manager does not support event inspection.'
		);
	}

	const events = eventManager.list();

	if (!Array.isArray(events)) {
		throw new Error(
			'Event manager returned an invalid event list.'
		);
	}

	return events;
}

function loadEvent(eventManager, filename) {
	if (
		!eventManager ||
		typeof eventManager.load !== 'function'
	) {
		throw new Error(
			'Event manager does not support loading events.'
		);
	}

	return eventManager.load(filename);
}

function unloadEvent(eventManager, filename) {
	if (
		!eventManager ||
		typeof eventManager.unload !== 'function'
	) {
		throw new Error(
			'Event manager does not support unloading events.'
		);
	}

	return eventManager.unload(filename);
}

function getEventIdentities(event) {
	const config =
		event?.config &&
		typeof event.config === 'object'
			? event.config
			: {};

	return [
		config.name
	]
		.map(normalizeName)
		.filter(Boolean);
}

function extractConfigBody(source) {
	const match = /\bconfig\s*:\s*\{/m.exec(source);

	if (!match) {
		return null;
	}

	const openingBrace = source.indexOf('{', match.index);

	let depth = 0;
	let quote = null;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;

	for (let i = openingBrace; i < source.length; i++) {
		const char = source[i];
		const next = source[i + 1];

		if (lineComment) {
			if (char === '\n') {
				lineComment = false;
			}

			continue;
		}

		if (blockComment) {
			if (char === '*' && next === '/') {
				blockComment = false;
				i++;
			}

			continue;
		}

		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}

			if (char === '\\') {
				escaped = true;
				continue;
			}

			if (char === quote) {
				quote = null;
			}

			continue;
		}

		if (char === '/' && next === '/') {
			lineComment = true;
			i++;
			continue;
		}

		if (char === '/' && next === '*') {
			blockComment = true;
			i++;
			continue;
		}

		if (
			char === '"' ||
			char === "'" ||
			char === '`'
		) {
			quote = char;
			continue;
		}

		if (char === '{') {
			depth++;
			continue;
		}

		if (char === '}') {
			depth--;

			if (depth === 0) {
				return source.slice(
					openingBrace + 1,
					i
				);
			}
		}
	}

	return null;
}

function decodeStaticString(value) {
	value = String(value || '').trim();

	if (!value) {
		return null;
	}

	try {
		if (
			value.startsWith('"') &&
			value.endsWith('"')
		) {
			return JSON.parse(value);
		}
	} catch {}

	if (
		value.startsWith("'") &&
		value.endsWith("'")
	) {
		return value
			.slice(1, -1)
			.replace(/\\(['"\\`])/g, '$1')
			.replace(/\\n/g, '\n')
			.replace(/\\r/g, '\r')
			.replace(/\\t/g, '\t');
	}

	if (
		value.startsWith('`') &&
		value.endsWith('`') &&
		!value.includes('${')
	) {
		return value
			.slice(1, -1)
			.replace(/\\`/g, '`')
			.replace(/\\\\/g, '\\');
	}

	return null;
}

function extractStaticMetadata(source, filename) {
	const configBody = extractConfigBody(source);
	const identities = new Set();

	const add = value => {
		const normalized = normalizeName(value);

		if (normalized) {
			identities.add(normalized);
		}
	};

	if (configBody) {
		const nameMatch =
			/\bname\s*:\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`)/m.exec(
				configBody
			);

		if (nameMatch) {
			add(decodeStaticString(nameMatch[1]));
		}

		const aliasesArrayMatch =
			/\baliases?\s*:\s*\[([\s\S]*?)\]/m.exec(
				configBody
			);

		if (aliasesArrayMatch) {
			const values =
				aliasesArrayMatch[1].match(
					/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`/g
				) || [];

			for (const value of values) {
				add(decodeStaticString(value));
			}
		} else {
			const aliasesStringMatch =
				/\baliases?\s*:\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`)/m.exec(
					configBody
				);

			if (aliasesStringMatch) {
				const value = decodeStaticString(
					aliasesStringMatch[1]
				);

				if (value) {
					for (const alias of value.split(/[,\s]+/)) {
						add(alias);
					}
				}
			}
		}
	}

	if (!identities.size) {
		add(getEventName(filename));
	}

	return [...identities];
}

function findConflicts(eventManager, filename, source) {
	const incoming = new Set(
		extractStaticMetadata(source, filename)
	);

	const conflicts = [];

	for (const event of getActiveEvents(eventManager)) {
		if (!event?.config) {
			continue;
		}

		if (
			normalizeName(event.fileName) ===
			normalizeName(filename)
		) {
			continue;
		}

		const activeIdentities =
			getEventIdentities(event);

		const matches = activeIdentities.filter(
			name => incoming.has(name)
		);

		if (!matches.length) {
			continue;
		}

		conflicts.push({
			name:
				event.config.name ||
				event.fileName ||
				'unknown',
			fileName: event.fileName,
			matches: [...new Set(matches)]
		});
	}

	return conflicts;
}

function formatConflicts(conflicts) {
	return conflicts
		.map(conflict => {
			const matches = conflict.matches.join(', ');

			return conflict.fileName &&
				conflict.fileName !== conflict.name
				? `${conflict.name} (${conflict.fileName}; matched: ${matches})`
				: `${conflict.name} (matched: ${matches})`;
		})
		.join(', ');
}

function getReactionEmoji(event) {
	const candidates = [
		event?.reaction,
		event?.emoji,
		event?.reactionEmoji,
		event?.text,
		event?.body,
		event?.message?.reaction,
		event?.message?.emoji,
		event?.message?.reactionEmoji,
		event?.message?.reactionMessage?.reaction,
		event?.message?.message?.reactionMessage?.reaction,
		event?.reactionMessage?.reaction
	];

	for (const candidate of candidates) {
		if (
			typeof candidate === 'string' &&
			candidate.trim()
		) {
			return candidate.trim();
		}

		if (
			candidate &&
			typeof candidate === 'object'
		) {
			for (const value of [
				candidate.text,
				candidate.emoji,
				candidate.reaction
			]) {
				if (
					typeof value === 'string' &&
					value.trim()
				) {
					return value.trim();
				}
			}
		}
	}

	return null;
}

function sameAuthor(a, b) {
	return a != null &&
		b != null &&
		String(a) === String(b);
}

async function removeConfirmationMessage(message, messageID) {
	if (
		!message ||
		!messageID ||
		typeof message.unsend !== 'function'
	) {
		return;
	}

	try {
		await message.unsend(messageID);
	} catch (error) {
		logger.debug?.(
			'[event] Failed to remove confirmation message:',
			error?.message || error
		);
	}
}

function formatText(template, values) {
	if (typeof global.utils?.formatText === 'function') {
		return global.utils.formatText(template, values);
	}

	return String(template).replace(
		/\{(\w+)\}/g,
		(_, key) => values[key] ?? `{${key}}`
	);
}

async function reply(message, text) {
	return message.reply(String(text));
}

function isActiveEvent(eventManager, filename) {
	return getActiveEvents(eventManager).some(
		event =>
			normalizeName(event?.fileName) ===
			normalizeName(filename)
	);
}

async function installEvent({
	filename,
	code,
	eventManager,
	message
}) {
	const existedBefore = eventExists(filename);
	const previousSource = existedBefore
		? readEventFile(filename)
		: null;

	const conflicts = findConflicts(
		eventManager,
		filename,
		code
	);

	if (conflicts.length) {
		writeEventFile(
			filename,
			code,
			existedBefore
		);

		if (isActiveEvent(eventManager, filename)) {
			await unloadEvent(
				eventManager,
				filename
			);
		}

		await reply(
			message,
			`Event ${filename} was installed but not loaded because its name or alias conflicts with an active event: ${formatConflicts(conflicts)}.`
		);

		return {
			loaded: false,
			conflicted: true
		};
	}

	const wasActive = isActiveEvent(
		eventManager,
		filename
	);

	let unloadedOld = false;

	try {
		if (wasActive) {
			await unloadEvent(
				eventManager,
				filename
			);

			unloadedOld = true;
		}

		writeEventFile(
			filename,
			code,
			existedBefore
		);

		const loadedName = await loadEvent(
			eventManager,
			filename
		);

		await reply(
			message,
			existedBefore
				? `Event ${loadedName || getEventName(filename)} overwritten and loaded successfully.`
				: `Event ${loadedName || getEventName(filename)} installed and loaded successfully.`
		);

		return {
			loaded: true,
			conflicted: false,
			name:
				loadedName ||
				getEventName(filename)
		};
	} catch (error) {
		logger.error(
			`[event] Failed to load "${filename}":`,
			error
		);

		if (
			existedBefore &&
			previousSource != null
		) {
			try {
				writeEventFile(
					filename,
					previousSource,
					true
				);

				if (unloadedOld) {
					try {
						await loadEvent(
							eventManager,
							filename
						);
					} catch (restoreError) {
						logger.error(
							`[event] Failed to restore "${filename}":`,
							restoreError
						);
					}
				}
			} catch (restoreFileError) {
				logger.error(
					`[event] Failed to restore event file "${filename}":`,
					restoreFileError
				);
			}
		} else {
			removeEventFile(filename);
		}

		throw error;
	}
}

function registerConfirmation(data) {
	if (
		!global.whatsbot?.onReaction ||
		typeof global.whatsbot.onReaction.set !== 'function'
	) {
		throw new Error(
			'Reaction handler is not available.'
		);
	}

	global.whatsbot.onReaction.set(
		data.messageID,
		data
	);
}

function clearConfirmation(messageID) {
	global.whatsbot?.onReaction?.delete?.(
		messageID
	);
}

module.exports = {
	config: {
		name: EVENT_NAME,
		version: '6.1.0',
		author: 'Jsux',
		role: 3,
		category: 'system',
		description: 'Manage event plugins dynamically.',
		usage:
			'{pn}event load <filename.js> | ' +
			'{pn}event unload <filename.js> | ' +
			'{pn}event install <filename.js> <code|source URL>'
	},

	async onStart({
		args = [],
		message,
		event,
		eventManager,
		config
	}) {
		const action = String(args[0] || '')
			.trim()
			.toLowerCase();

		const rawFile = String(args[1] || '')
			.trim();

		const prefix = config?.prefix || '!';
		const usage =
			`${prefix}event load <filename.js> | ` +
			`${prefix}event unload <filename.js> | ` +
			`${prefix}event install <filename.js> <code|source URL>`;

		if (
			!['load', 'unload', 'install'].includes(action)
		) {
			await reply(message, `Usage: ${usage}`);
			return;
		}

		if (!rawFile) {
			await reply(
				message,
				'Please provide a filename ending in .js.'
			);
			return;
		}

		let filename;

		try {
			filename = normalizeFilename(rawFile);
		} catch (error) {
			await reply(
				message,
				`Failed: ${error.message}`
			);
			return;
		}

		if (action === 'load') {
			try {
				if (!eventExists(filename)) {
					throw new Error(
						`Event file ${filename} does not exist.`
					);
				}

				const name = await loadEvent(
					eventManager,
					filename
				);

				if (
					config?.textlogs?.eventLoaded !== false
				) {
					const template =
						config?.texts?.eventLoaded ||
						'Event {name} loaded successfully.';

					await reply(
						message,
						formatText(template, {
							name:
								name ||
								getEventName(filename)
						})
					);
				}
			} catch (error) {
				logger.error(
					`[event] Failed to load "${filename}":`,
					error
				);

				await reply(
					message,
					`Failed to load event: ${error.message}`
				);
			}

			return;
		}

		if (action === 'unload') {
			try {
				const name = await unloadEvent(
					eventManager,
					filename
				);

				if (
					config?.textlogs?.eventUnloaded !== false
				) {
					const template =
						config?.texts?.eventUnloaded ||
						'Event {name} unloaded successfully.';

					await reply(
						message,
						formatText(template, {
							name:
								name ||
								getEventName(filename)
						})
					);
				}
			} catch (error) {
				logger.error(
					`[event] Failed to unload "${filename}":`,
					error
				);

				await reply(
					message,
					`Failed to unload event: ${error.message}`
				);
			}

			return;
		}

		try {
			const sourceInfo =
				await resolveSource(args);

			const code =
				normalizeSource(
					sourceInfo.value
				);

			const author = event?.senderID;

			if (!author) {
				throw new Error(
					'Unable to determine the installer.'
				);
			}

			if (!eventExists(filename)) {
				await installEvent({
					filename,
					code,
					eventManager,
					message
				});

				return;
			}

			const confirmation =
				await reply(
					message,
					`Event ${filename} already exists.\n\n` +
					'React with ✅ to overwrite and install the new version.\n' +
					'React with anything else to cancel.'
				);

			const messageID =
				confirmation?.key?.id;

			if (!messageID) {
				throw new Error(
					'Failed to create the installation confirmation message.'
				);
			}

			registerConfirmation({
				messageID,
				author,
				code,
				filename,
				commandName: EVENT_NAME,
				createdAt: Date.now()
			});
		} catch (error) {
			logger.error(
				`[event] Failed to prepare installation for "${filename}":`,
				error
			);

			await reply(
				message,
				`Failed to install event: ${error.message}`
			);
		}
	},

	async onReaction({
		event,
		message,
		Reaction,
		eventManager
	}) {
		if (
			!Reaction ||
			typeof Reaction !== 'object'
		) {
			return;
		}

		const {
			messageID,
			author,
			code,
			filename,
			commandName,
			createdAt
		} = Reaction;

		if (
			!messageID ||
			!author ||
			!code ||
			!filename
		) {
			return;
		}

		if (
			commandName &&
			commandName !== EVENT_NAME
		) {
			return;
		}

		if (
			createdAt &&
			Date.now() - Number(createdAt) > CONFIRMATION_TTL
		) {
			clearConfirmation(messageID);
			await removeConfirmationMessage(
				message,
				messageID
			);
			return;
		}

		const reactor =
			event?.senderID ??
			event?.actorID;

		if (!sameAuthor(reactor, author)) {
			return;
		}

		const emoji = getReactionEmoji(event);

		clearConfirmation(messageID);

		if (emoji !== '✅') {
			await removeConfirmationMessage(
				message,
				messageID
			);

			await reply(
				message,
				'Event installation cancelled.'
			);

			return;
		}

		await removeConfirmationMessage(
			message,
			messageID
		);

		try {
			const manager =
				eventManager ||
				global.client?.eventManager;

			if (!manager) {
				throw new Error(
					'Event manager is not available.'
				);
			}

			await installEvent({
				filename,
				code,
				eventManager: manager,
				message
			});
		} catch (error) {
			logger.error(
				`[event] Failed to install confirmed event "${filename}":`,
				error
			);

			await reply(
				message,
				`Failed to install event: ${error.message}`
			);
		}
	}
};