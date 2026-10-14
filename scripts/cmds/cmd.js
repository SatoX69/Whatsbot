'use strict';

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const COMMAND_DIR = path.join(process.cwd(), 'scripts', 'cmds');
const MAX_CODE_SIZE = 4 * 1024 * 1024;
const HTTP_TIMEOUT = 15_000;
const COMMAND_NAME = 'cmd';

const logger = global.log || console;

/* -------------------------------------------------------------------------- */
/* Filename / path                                                            */
/* -------------------------------------------------------------------------- */

function normalizeFilename(value) {
	const filename = String(value || '').trim();

	if (!filename) {
		throw new Error('Filename is required.');
	}

	/*
	 * Keep this compatible with commandManager.load()/unload().
	 * The command manager only accepts [a-z0-9_-]+ as the filename stem.
	 */
	if (!/^[A-Za-z0-9_-]+\.js$/i.test(filename)) {
		throw new Error(
			'Invalid filename. Use only letters, numbers, _ or - and the .js extension.'
		);
	}

	return filename;
}

function getCommandPath(filename) {
	const root = path.resolve(COMMAND_DIR);
	const target = path.resolve(root, filename);

	if (
		path.dirname(target) !== root ||
		target === root ||
		!target.startsWith(`${root}${path.sep}`)
	) {
		throw new Error('Invalid command path.');
	}

	return target;
}

function fileExists(filename) {
	return fs.existsSync(getCommandPath(filename));
}

function getBaseName(filename) {
	return path.basename(filename, '.js').toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Source                                                                     */
/* -------------------------------------------------------------------------- */

function normalizeSource(source) {
	if (typeof source !== 'string') {
		throw new Error('Command source must be text.');
	}

	source = source.replace(/^\uFEFF/, '').trim();

	if (!source) {
		throw new Error('Command source is empty.');
	}

	if (Buffer.byteLength(source, 'utf8') > MAX_CODE_SIZE) {
		throw new Error('Command source exceeds the 4 MB limit.');
	}

	if (source.includes('\0')) {
		throw new Error('Command source contains invalid binary data.');
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
			'Source does not appear to be a CommonJS command module.'
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

	let response;

	try {
		response = await axios.get(parsed.href, {
			responseType: 'text',
			timeout: HTTP_TIMEOUT,
			maxContentLength: MAX_CODE_SIZE,
			maxBodyLength: MAX_CODE_SIZE,
			maxRedirects: 5,
			validateStatus: status => status >= 200 && status < 300,
			headers: {
				Accept:
					'text/plain, text/javascript, application/javascript, */*',
				'User-Agent': 'WhatsApp-Bot-Command-Installer/1.0'
			}
		});
	} catch (error) {
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

		throw new Error(`Unable to reach source: ${error.message}`);
	}

	if (!response || typeof response.data !== 'string') {
		throw new Error('Source response was not text.');
	}

	return response.data;
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

/* -------------------------------------------------------------------------- */
/* File writing                                                               */
/* -------------------------------------------------------------------------- */

function writeCommandFile(filename, source, overwrite = false) {
	const target = getCommandPath(filename);

	if (!overwrite && fs.existsSync(target)) {
		throw new Error(`A command named ${filename} already exists.`);
	}

	fs.mkdirSync(COMMAND_DIR, {
		recursive: true
	});

	const tempPath = path.join(
		COMMAND_DIR,
		`.${filename}.${process.pid}.${Date.now()}.tmp`
	);

	try {
		fs.writeFileSync(tempPath, source, {
			encoding: 'utf8',
			flag: 'wx',
			mode: 0o644
		});

		/*
		 * renameSync() replaces the destination atomically on the same
		 * filesystem. This prevents partially written command files.
		 */
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

function readCommandFile(filename) {
	const target = getCommandPath(filename);

	if (!fs.existsSync(target)) {
		return null;
	}

	return fs.readFileSync(target, 'utf8');
}

function removeCommandFile(filename) {
	const target = getCommandPath(filename);

	try {
		if (fs.existsSync(target)) {
			fs.unlinkSync(target);
		}
	} catch (error) {
		logger.error(
			`[cmd] Failed to remove command "${filename}":`,
			error
		);
	}
}

/* -------------------------------------------------------------------------- */
/* Command manager                                                            */
/* -------------------------------------------------------------------------- */

async function loadCommand(commandManager, filename) {
	if (
		!commandManager ||
		typeof commandManager.load !== 'function'
	) {
		throw new Error(
			'Command manager does not support loading commands.'
		);
	}

	return commandManager.load(filename);
}

async function unloadCommand(commandManager, filename) {
	if (
		!commandManager ||
		typeof commandManager.unload !== 'function'
	) {
		throw new Error(
			'Command manager does not support unloading commands.'
		);
	}

	return commandManager.unload(filename);
}

/* -------------------------------------------------------------------------- */
/* Active command inspection                                                 */
/* -------------------------------------------------------------------------- */

function getActiveCommands(commandManager) {
	if (
		!commandManager ||
		typeof commandManager.list !== 'function'
	) {
		throw new Error(
			'Command manager does not support command inspection.'
		);
	}

	const commands = commandManager.list();

	if (!Array.isArray(commands)) {
		throw new Error(
			'Command manager returned an invalid command list.'
		);
	}

	return commands;
}

function normalizeName(value) {
	return String(value || '')
		.trim()
		.toLowerCase();
}

function getCommandIdentities(command) {
	const config =
		command?.config &&
		typeof command.config === 'object'
			? command.config
			: {};

	return [
		config.name,
		...(Array.isArray(config.aliases)
			? config.aliases
			: [])
	]
		.map(normalizeName)
		.filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/* Static metadata extraction                                                 */
/*                                                                            */
/* We do NOT require() the new command just to inspect its name/aliases,      */
/* because require() executes arbitrary command code.                         */
/* -------------------------------------------------------------------------- */

function extractConfigBody(source) {
	const match = /\bconfig\s*:\s*\{/m.exec(source);

	if (!match) {
		return null;
	}

	const openingBrace =
		source.indexOf('{', match.index);

	let depth = 0;
	let quote = null;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;

	for (
		let i = openingBrace;
		i < source.length;
		i++
	) {
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

	function add(value) {
		const normalized = normalizeName(value);

		if (normalized) {
			identities.add(normalized);
		}
	}

	if (configBody) {
		/*
		 * name: 'test'
		 * name: "test"
		 * name: `test`
		 */
		const nameMatch =
			/\bname\s*:\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`)/m.exec(
				configBody
			);

		if (nameMatch) {
			add(decodeStaticString(nameMatch[1]));
		}

		/*
		 * aliases: ['a', 'b']
		 */
		const arrayMatch =
			/\baliases?\s*:\s*\[([\s\S]*?)\]/m.exec(
				configBody
			);

		if (arrayMatch) {
			const values =
				arrayMatch[1].match(
					/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`/g
				) || [];

			for (const value of values) {
				add(decodeStaticString(value));
			}
		} else {
			/*
			 * aliases: 'a b'
			 * aliases: "a,b"
			 */
			const stringAliasMatch =
				/\baliases?\s*:\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`)/m.exec(
					configBody
				);

			if (stringAliasMatch) {
				const value = decodeStaticString(
					stringAliasMatch[1]
				);

				if (value) {
					for (const alias of value.split(/[,\s]+/)) {
						add(alias);
					}
				}
			}
		}
	}

	/*
	 * If config.name does not exist, your command manager falls back to the
	 * filename stem.
	 */
	if (!identities.size) {
		add(getBaseName(filename));
	}

	return [...identities];
}

/* -------------------------------------------------------------------------- */
/* Conflict detection                                                         */
/* -------------------------------------------------------------------------- */

function findConflicts(
	commandManager,
	filename,
	source
) {
	const incoming = new Set(
		extractStaticMetadata(source, filename)
	);

	const conflicts = [];

	for (const command of getActiveCommands(commandManager)) {
		if (!command?.config) {
			continue;
		}

		/*
		 * The command occupying this exact filename is the command being
		 * replaced, not a name/alias conflict.
		 */
		if (
			normalizeName(command.fileName) ===
			normalizeName(filename)
		) {
			continue;
		}

		const activeIdentities =
			getCommandIdentities(command);

		const matches = activeIdentities.filter(
			name => incoming.has(name)
		);

		if (!matches.length) {
			continue;
		}

		conflicts.push({
			name:
				command.config.name ||
				command.fileName ||
				'unknown',
			fileName: command.fileName,
			matches: [...new Set(matches)]
		});
	}

	return conflicts;
}

function formatConflicts(conflicts) {
	return conflicts
		.map(conflict => {
			const matchText =
				conflict.matches.join(', ');

			return conflict.fileName &&
				conflict.fileName !==
					conflict.name
				? `${conflict.name} (${conflict.fileName}; matched: ${matchText})`
				: `${conflict.name} (matched: ${matchText})`;
		})
		.join(', ');
}

/* -------------------------------------------------------------------------- */
/* Confirmation                                                               */
/* -------------------------------------------------------------------------- */

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
	if (a == null || b == null) {
		return false;
	}

	return String(a) === String(b);
}

async function removeConfirmationMessage(
	message,
	messageID
) {
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
			'[cmd] Failed to remove confirmation message:',
			error?.message || error
		);
	}
}

/* -------------------------------------------------------------------------- */
/* Persistent unloaded state                                                  */
/* -------------------------------------------------------------------------- */

/*
 * Your manager stores unloaded commands in commandConfig.json.
 *
 * We use commandManager.unload(filename) for conflict cases so the command
 * remains installed on disk but is explicitly excluded from reloadAll().
 */
async function markUnloaded(
	commandManager,
	filename
) {
	await unloadCommand(
		commandManager,
		filename
	);
}

/* -------------------------------------------------------------------------- */
/* Installation                                                               */
/* -------------------------------------------------------------------------- */

async function installCommand({
	filename,
	code,
	commandManager,
	message
}) {
	const existedBefore = fileExists(filename);
	const previousSource = existedBefore
		? readCommandFile(filename)
		: null;

	const conflicts = findConflicts(
		commandManager,
		filename,
		code
	);

	/*
	 * ----------------------------------------------------------------------
	 * CONFLICT
	 * ----------------------------------------------------------------------
	 *
	 * The command is installed on disk but NOT loaded.
	 */
	if (conflicts.length) {
		writeCommandFile(
			filename,
			code,
			existedBefore
		);

		/*
		 * Persist the command as unloaded so the automatic fs.watch reload
		 * cannot immediately try to load it again.
		 *
		 * Important:
		 * For an overwrite, unload() removes the OLD command from the active
		 * registry. We only want to do that if the old command was actually
		 * active. So check before calling it.
		 */
		const wasActive = getActiveCommands(
			commandManager
		).some(
			command =>
				normalizeName(command?.fileName) ===
				normalizeName(filename)
		);

		if (wasActive) {
			await markUnloaded(
				commandManager,
				filename
			);
		} else {
			/*
			 * The manager has no public "mark unloaded without unloading"
			 * method, so directly maintain its persisted config through
			 * persistConfig(), which your manager exposes.
			 */
			if (
				typeof commandManager.persistConfig ===
				'function'
			) {
				const cfg =
					commandManager.config || {};

				const unloaded = new Set(
					Array.isArray(cfg.unloadedCommands)
						? cfg.unloadedCommands.map(
								value =>
									String(value).toLowerCase()
							)
						: []
				);

				unloaded.add(
					getBaseName(filename)
				);

				await commandManager.persistConfig({
					...cfg,
					unloadedCommands: [
						...unloaded
					].sort()
				});

				/*
				 * Reload manager state so the persisted exclusion becomes
				 * part of its internal "unloaded" set as well.
				 */
				await commandManager.reloadAll();
			}
		}

		await message.reply(
			`Command ${filename} was installed but not loaded because its name or alias conflicts with an active command: ${formatConflicts(conflicts)}.`
		);

		return {
			loaded: false,
			conflicted: true
		};
	}

	/*
	 * ----------------------------------------------------------------------
	 * NO CONFLICT
	 * ----------------------------------------------------------------------
	 */

	const wasActive = getActiveCommands(
		commandManager
	).some(
		command =>
			normalizeName(command?.fileName) ===
			normalizeName(filename)
	);

	let unloadedOld = false;

	try {
		/*
		 * If replacing a currently active command, unload it before
		 * replacing the file.
		 */
		if (wasActive) {
			await unloadCommand(
				commandManager,
				filename
			);

			unloadedOld = true;
		}

		writeCommandFile(
			filename,
			code,
			existedBefore
		);

		const loadedName = await loadCommand(
			commandManager,
			filename
		);

		await message.reply(
			existedBefore
				? `Command ${loadedName || getBaseName(filename)} overwritten and loaded successfully.`
				: `Command ${loadedName || getBaseName(filename)} installed and loaded successfully.`
		);

		return {
			loaded: true,
			conflicted: false,
			name:
				loadedName ||
				getBaseName(filename)
		};
	} catch (error) {
		logger.error(
			`[cmd] Failed to load command "${filename}":`,
			error
		);

		/*
		 * Restore the previous file if this was an overwrite.
		 */
		if (existedBefore && previousSource != null) {
			try {
				writeCommandFile(
					filename,
					previousSource,
					true
				);

				/*
				 * The old command was explicitly unloaded, so try to restore
				 * it as active.
				 */
				if (unloadedOld) {
					try {
						await loadCommand(
							commandManager,
							filename
						);
					} catch (restoreError) {
						logger.error(
							`[cmd] Failed to restore previous command "${filename}":`,
							restoreError
						);
					}
				}
			} catch (restoreFileError) {
				logger.error(
					`[cmd] Failed to restore command file "${filename}":`,
					restoreFileError
				);
			}
		} else {
			/*
			 * New command failed to load, so do not leave a broken file
			 * pretending to be installed.
			 */
			removeCommandFile(filename);
		}

		throw error;
	}
}

/* -------------------------------------------------------------------------- */
/* Command module                                                             */
/* -------------------------------------------------------------------------- */

module.exports = {
	config: {
		name: COMMAND_NAME,
		version: '6.1.0',
		author: 'Jsux',
		role: 3,
		category: 'system',
		description: 'Manage command plugins dynamically.',
		usage:
			'!cmd load <filename.js> | ' +
			'!cmd unload <filename.js> | ' +
			'!cmd install <filename.js> <code|source URL>'
	},

	async onStart({
		args = [],
		message,
		event,
		commandManager,
		config
	}) {
		const action = String(
			args[0] || ''
		)
			.trim()
			.toLowerCase();

		const rawFile = String(
			args[1] || ''
		).trim();

		const prefix =
			config?.prefix || '!';

		const reply = text =>
			message.reply(String(text));

		if (
			!['load', 'unload', 'install']
				.includes(action)
		) {
			await reply(
				`Usage: ${prefix}cmd load|unload|install <filename.js> [code|source URL]`
			);

			return;
		}

		if (!rawFile) {
			await reply(
				'Please provide a filename ending in .js.'
			);

			return;
		}

		let filename;

		try {
			filename = normalizeFilename(
				rawFile
			);
		} catch (error) {
			await reply(
				`Failed: ${error.message}`
			);

			return;
		}

		/* ------------------------------------------------------------------ */
		/* LOAD                                                               */
		/* ------------------------------------------------------------------ */

		if (action === 'load') {
			try {
				if (!fileExists(filename)) {
					throw new Error(
						`Command file ${filename} does not exist.`
					);
				}

				const name =
					await loadCommand(
						commandManager,
						filename
					);

				if (
					config?.textlogs
						?.commandLoaded !== false
				) {
					const template =
						config?.texts
							?.commandLoaded ||
						`Command {name} loaded successfully.`;

					await reply(
						global.utils?.formatText
							? global.utils.formatText(
									template,
									{
										name:
											name ||
											getBaseName(
												filename
											)
									}
								)
							: template.replace(
									'{name}',
									name ||
										getBaseName(
											filename
										)
								)
					);
				}
			} catch (error) {
				logger.error(
					`[cmd] Failed to load command "${filename}":`,
					error
				);

				await reply(
					`Failed to load command: ${error.message}`
				);
			}

			return;
		}

		/* ------------------------------------------------------------------ */
		/* UNLOAD                                                             */
		/* ------------------------------------------------------------------ */

		if (action === 'unload') {
			try {
				const name =
					await unloadCommand(
						commandManager,
						filename
					);

				if (
					config?.textlogs
						?.commandUnloaded !== false
				) {
					const template =
						config?.texts
							?.commandUnloaded ||
						`Command {name} unloaded successfully.`;

					await reply(
						global.utils?.formatText
							? global.utils.formatText(
									template,
									{
										name:
											name ||
											getBaseName(
												filename
											)
									}
								)
							: template.replace(
									'{name}',
									name ||
										getBaseName(
											filename
										)
								)
					);
				}
			} catch (error) {
				logger.error(
					`[cmd] Failed to unload command "${filename}":`,
					error
				);

				await reply(
					`Failed to unload command: ${error.message}`
				);
			}

			return;
		}

		/* ------------------------------------------------------------------ */
		/* INSTALL                                                            */
		/* ------------------------------------------------------------------ */

		try {
			const sourceInfo =
				await resolveSource(args);

			const code =
				normalizeSource(
					sourceInfo.value
				);

			const author =
				event?.senderID;

			if (!author) {
				throw new Error(
					'Unable to determine the installer.'
				);
			}

			/*
			 * NEW FILE:
			 * Install immediately.
			 */
			if (!fileExists(filename)) {
				await installCommand({
					filename,
					code,
					commandManager,
					message
				});

				return;
			}

			/*
			 * EXISTING FILE:
			 * Ask for explicit confirmation.
			 */
			const confirm =
				await message.reply(
					`Command ${filename} already exists.\n\n` +
					`React with ✅ to overwrite and install the new version.\n` +
					`React with anything else to cancel.`
				);

			const messageID =
				confirm?.key?.id;

			if (!messageID) {
				throw new Error(
					'Failed to create the installation confirmation message.'
				);
			}

			if (
				!global.whatsbot?.onReaction ||
				typeof global.whatsbot
					.onReaction.set !== 'function'
			) {
				throw new Error(
					'Reaction handler is not available.'
				);
			}

			global.whatsbot.onReaction.set(
				messageID,
				{
					author,
					commandName:
						COMMAND_NAME,
					messageID,
					code,
					filename,
					createdAt:
						Date.now()
				}
			);
		} catch (error) {
			logger.error(
				`[cmd] Failed to prepare installation for "${filename}":`,
				error
			);

			await reply(
				`Failed to install command: ${error.message}`
			);
		}
	},

	async onReaction({
		event,
		message,
		Reaction
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
			commandName
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
			commandName !== COMMAND_NAME
		) {
			return;
		}

		const reactor =
			event?.senderID ??
			event?.actorID;

		if (
			!sameAuthor(
				reactor,
				author
			)
		) {
			return;
		}

		const emoji =
			getReactionEmoji(event);

		/*
		 * Consume confirmation state immediately so the same reaction
		 * cannot trigger the operation twice.
		 */
		global.whatsbot?.onReaction?.delete?.(
			messageID
		);

		/* ------------------------------------------------------------------ */
		/* CANCEL                                                             */
		/* ------------------------------------------------------------------ */

		if (emoji !== '✅') {
			await removeConfirmationMessage(
				message,
				messageID
			);

			await message.reply(
				'Command installation cancelled.'
			);

			return;
		}

		/* ------------------------------------------------------------------ */
		/* CONFIRM                                                            */
		/* ------------------------------------------------------------------ */

		try {
			await installCommand({
				filename,
				code,
				commandManager:
					global.client?.commandManager,
				message
			});
		} catch (error) {
			logger.error(
				`[cmd] Failed to install confirmed command "${filename}":`,
				error
			);

			await message.reply(
				`Failed to install command: ${error.message}`
			);
		}
	}
};