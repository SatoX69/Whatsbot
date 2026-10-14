/** @format */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const initialConfig = require('./config.json');
const credentialConfig = require('./cred.json');
const logger = require('./logger');
const utils = require('./utils');
const database = require('./database');
const createConfigManager = require('./configManager');
const createCommandManager = require('./scripts/loadCommands');
const createEventManager = require('./scripts/loadEvents');
const createActionHandler = require('./bot/handler/actionHandler');
const createEventHandler = require('./bot/handler/eventHandler');
const autoUptime = require('./bot/autoUptime');

const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

let delegacy = null;

let socket = null;
let db = null;
let configManager = null;
let commandManager = null;
let eventManager = null;
let actionHandler = null;
let eventHandler = null;
let baileysModule = null;

let shuttingDown = false;
let shutdownPromise = null;

let reconnectTimer = null;
let reconnectAttempts = 0;
let reconnecting = false;

let connectionGeneration = 0;
let lastQR = null;
let lastQRAt = 0;
let qrSavePromise = Promise.resolve();

const MAX_RECONNECT_DELAY = 30_000;
const BASE_RECONNECT_DELAY = 2_000;
const QR_DUPLICATE_WINDOW = 1_500;

function initializeGlobals() {
	global.config = { ...initialConfig };
	global.db = null;

	global.expiredEventIndex = 0; // specifically for counting expired messages

	global.credential = credentialConfig; // for credentials

	global.client = {
		socket: null,
		commands: new Map(),
		events: new Map(),
		commandConfig: {},
		eventConfig: {},
		commandManager: null,
		eventManager: null,
		revokeType: undefined,
		connectedAt: null,
		botJid: null,
		isReady: false,
		configVersion: Date.now(),

		runtime: {
			autoRestart: initialConfig.autoReboot?.enabled
				? {
						endTime:
							Date.now() +
							(initialConfig.autoReboot?.timeMs ?? 0),

						timeRemaining() {
							const ms = Math.max(0, this.endTime - Date.now());
							const minutes = Math.ceil(ms / 60000);

							return {
								ms,
								readable: `${minutes} minute${minutes === 1 ? '' : 's'} remaining`
							};
						}
					}
				: false,
			startedAt: Date.now(),
			pid: process.pid,
			restartRequested: false
		},

		shutdown: async (reason) => shutdown(reason, 0)
	};

	global.utils = utils;
	global.log = logger;

	global.whatsbot = {
		onReply: new Map(),
		onReaction: new Map()
	};

	global.temp = {
		spamTracker: new Map(),
		recentOutgoing: new Map(),
		cooldowns: new Map(),
		groupCache: new Map(),
		locks: new Set()
	};
}

function getRestartExitCode() {
	const code = global.config?.runtime?.restartExitCode;
	return Number.isInteger(code) ? code : 2;
}

function clearReconnectTimer() {
	if (!reconnectTimer) return;

	clearTimeout(reconnectTimer);
	reconnectTimer = null;
}

function getDisconnectStatus(lastDisconnect) {
	return (
		lastDisconnect?.error?.output?.statusCode ??
		lastDisconnect?.error?.statusCode ??
		null
	);
}

function isTermux() {
	return !!(
		process.env.TERMUX_VERSION ||
		process.env.PREFIX?.includes('/com.termux/')
	);
}

function cleanupResource(resource, name) {
	if (!resource) return Promise.resolve();

	return Promise.resolve()
		.then(() => resource.shutdown?.())
		.catch((error) => {
			logger.warn('SYSTEM', `${name} cleanup failed`, error);
		});
}

async function closeSocket(targetSocket, reason) {
	if (!targetSocket) return;

	try {
		targetSocket.end?.(new Error(reason));
	} catch (error) {
		logger.warn('WHATSAPP', 'Socket end failed', error);
	}

	try {
		targetSocket.ws?.close?.();
	} catch (error) {
		logger.warn('WHATSAPP', 'WebSocket close failed', error);
	}
}

async function shutdown(reason = 'shutdown', exitCode = 0) {
	if (shutdownPromise) return shutdownPromise;

	shuttingDown = true;
	clearReconnectTimer();

	shutdownPromise = (async () => {
		if (global.client?.runtime) {
			global.client.runtime.restartRequested =
				exitCode === getRestartExitCode();
		}

		logger.info('SYSTEM', `Shutting down (${reason})`, { exitCode });

		try {
			configManager?.stop?.();
		} catch (error) {
			logger.warn('SYSTEM', 'Config watcher cleanup failed', error);
		}

		try {
			commandManager?.stopWatch?.();
		} catch (error) {
			logger.warn('SYSTEM', 'Command watcher cleanup failed', error);
		}

		try {
			eventManager?.stopWatch?.();
		} catch (error) {
			logger.warn('SYSTEM', 'Event watcher cleanup failed', error);
		}

		try {
			await autoUptime.stop?.();
		} catch (error) {
			logger.warn('SYSTEM', 'Auto-uptime cleanup failed', error);
		}

		await cleanupResource(actionHandler, 'Action handler');
		await cleanupResource(eventHandler, 'Event handler');

		actionHandler = null;
		eventHandler = null;

		const activeSocket = socket;

		socket = null;

		if (global.client) {
			global.client.socket = null;
			global.client.isReady = false;
		}

		await closeSocket(activeSocket, 'Application shutting down');

		try {
			await db?.save?.();
		} catch (error) {
			logger.error('DATABASE', 'Final save failed', error);
		}

		try {
			await db?.close?.();
		} catch (error) {
			logger.error('DATABASE', 'Database close failed', error);
		}

		db = null;
		global.db = null;

		process.exit(exitCode);
	})();

	return shutdownPromise;
}

function installProcessSafety() {
	process.on('uncaughtException', (error) => {
		logger.fatal('PROCESS', 'Uncaught exception', error);
		void shutdown('uncaughtException', getRestartExitCode());
	});

	process.on('unhandledRejection', (reason) => {
		const error =
			reason instanceof Error ? reason : new Error(String(reason));

		logger.fatal('PROCESS', 'Unhandled rejection', error);
		void shutdown('unhandledRejection', getRestartExitCode());
	});

	process.on('warning', (warning) => {
		logger.warn('PROCESS', 'Node warning', warning);
	});

	process.once('SIGINT', () => {
		void shutdown('SIGINT', 0);
	});

	process.once('SIGTERM', () => {
		void shutdown('SIGTERM', 0);
	});
}

function normalizeQRLink(qr) {
	if (typeof qr !== 'string' || !qr.length) {
		return null;
	}

	try {
		return new URL(qr).href;
	} catch {
		return qr;
	}
}

async function saveLoginQR(qr) {
	const qrPath = path.join(__dirname, 'LOGIN.png');
	const link = normalizeQRLink(qr);

	if (link) {
		logger.info('WHATSAPP', `QR link: ${link}`);
	}

	try {
		await QRCode.toFile(qrPath, qr, {
			type: 'png',
			errorCorrectionLevel: 'M',
			width: 640,
			margin: 4
		});

		logger.info('WHATSAPP', `Login QR saved to ${qrPath}`);
	} catch (error) {
		logger.error('WHATSAPP', 'Failed to save QR image', error);
	}

	try {
		console.log('');
		qrcodeTerminal.generate(qr, { small: true });
		console.log('');

		logger.info('WHATSAPP', 'Scan using WhatsApp → Linked devices');
	} catch (error) {
		logger.error('WHATSAPP', 'Failed to render terminal QR', error);
	}
}

function handleQR(qr) {
	const now = Date.now();

	if (qr === lastQR && now - lastQRAt < QR_DUPLICATE_WINDOW) {
		return;
	}

	lastQR = qr;
	lastQRAt = now;

	qrSavePromise = qrSavePromise
		.catch(() => {})
		.then(() => saveLoginQR(qr))
		.catch((error) => {
			logger.error('WHATSAPP', 'QR processing failed', error);
		});
}

function getReconnectDelay() {
	const exponent = Math.min(reconnectAttempts, 10);

	const delay = Math.min(
		BASE_RECONNECT_DELAY * 2 ** exponent,
		MAX_RECONNECT_DELAY
	);

	return Math.round(delay * (0.9 + Math.random() * 0.2));
}

function scheduleReconnect(reason, previousSocket) {
	if (shuttingDown || reconnectTimer || reconnecting) {
		return;
	}

	const delay = getReconnectDelay();

	reconnectAttempts++;
	connectionGeneration++;

	if (socket === previousSocket) {
		socket = null;
	}

	if (global.client?.socket === previousSocket) {
		global.client.socket = null;
		global.client.isReady = false;
	}

	logger.warn('WHATSAPP', 'Scheduling reconnection', {
		reason,
		attempt: reconnectAttempts,
		delay
	});

	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		void reconnect(previousSocket);
	}, delay);

	reconnectTimer.unref?.();
}

async function reconnect(previousSocket) {
	if (shuttingDown || reconnecting) return;

	reconnecting = true;

	try {
		await cleanupResource(actionHandler, 'Action handler');

		await cleanupResource(eventHandler, 'Event handler');

		actionHandler = null;
		eventHandler = null;

		await closeSocket(previousSocket, 'Replacing disconnected socket');

		if (shuttingDown) return;

		await connect(baileysModule);
	} catch (error) {
		logger.error('WHATSAPP', 'Reconnection attempt failed', error);

		if (!shuttingDown) {
			scheduleReconnect(error.message, socket);
		}
	} finally {
		reconnecting = false;
	}
}

async function connect(baileys) {
	if (shuttingDown) return;

	const {
		default: makeWASocket,
		DisconnectReason,
		useMultiFileAuthState,
		Browsers,
		proto
	} = baileys;

	if (typeof makeWASocket !== 'function') {
		throw new TypeError('Invalid Baileys socket constructor');
	}

	const generation = ++connectionGeneration;

	const authPath = path.resolve(
		__dirname,
		isTermux()
			? global.config.auth.directoryForLocalDebug
			: global.config.auth.directory
	);

	console.log(`Using ${authPath}`);
	fs.mkdirSync(authPath, { recursive: true });

	const { state, saveCreds } = await useMultiFileAuthState(authPath);

	if (shuttingDown || generation !== connectionGeneration) {
		return;
	}

	const newSocket = makeWASocket({
		auth: state,
		logger: logger.baileys,

		browser: Browsers.ubuntu('Termux SelfBot'),

		markOnlineOnConnect: false,

		emitOwnEvents: Boolean(global.config.selfBot?.processOwnMessageEvents),

		syncFullHistory: false
	});

	socket = newSocket;

	global.client.socket = newSocket;
	global.client.isReady = false;

	global.client.revokeType = proto?.Message?.ProtocolMessage?.Type?.REVOKE;

	newSocket.ev.on('creds.update', () => {
		void saveCreds().catch((error) => {
			logger.error('WHATSAPP', 'Failed to save credentials', error);
		});
	});

	newSocket.ev.on('connection.update', (update) => {
		if (
			shuttingDown ||
			newSocket !== socket ||
			generation !== connectionGeneration
		) {
			return;
		}

		void handleConnectionUpdate(
			update,
			newSocket,
			DisconnectReason,
			generation
		).catch((error) => {
			logger.error(
				'WHATSAPP',
				'Connection update handling failed',
				error
			);
		});
	});

	actionHandler = createActionHandler({
		socket: newSocket,
		logger,
		commandManager,
		getConfig: () => global.config
	});

	delegacy = actionHandler;

	eventHandler = createEventHandler({
		socket: newSocket,
		logger,
		eventManager,
		getConfig: () => global.config,
		getEventConfig: () => global.client.eventConfig,
		actionHandler
	});

	actionHandler.bind();
	eventHandler.bind();

	logger.info('WHATSAPP', 'Socket and handlers initialized');
}

async function handleConnectionUpdate(
	{ connection, lastDisconnect, qr },
	currentSocket,
	DisconnectReason,
	generation
) {
	if (
		shuttingDown ||
		currentSocket !== socket ||
		generation !== connectionGeneration
	) {
		return;
	}

	if (qr) {
		handleQR(qr);
	}

	if (connection === 'connecting') {
		logger.info('WHATSAPP', 'Connecting to WhatsApp...');
	}

	if (connection === 'open') {
		clearReconnectTimer();

		reconnectAttempts = 0;

		lastQR = null;
		lastQRAt = 0;

		global.client.connectedAt = Date.now();
		global.client.botJid = currentSocket.user?.id ?? null;
		global.client.isReady = true;

		logger.success(
			'WHATSAPP',
			`Connected as ${global.client.botJid || 'unknown'}`
		);
		// onLoad
		await delegacy.runOnLoad();
		return;
	}

	if (connection !== 'close') {
		return;
	}

	global.client.isReady = false;

	const statusCode = getDisconnectStatus(lastDisconnect);

	const loggedOut =
		statusCode === DisconnectReason.loggedOut || statusCode === 401;

	logger.warn('WHATSAPP', 'Connection closed', {
		statusCode,
		loggedOut,
		error: lastDisconnect?.error?.message
	});

	if (loggedOut) {
		await shutdown('whatsapp-logged-out', 1);

		return;
	}

	scheduleReconnect(`disconnect-${statusCode ?? 'unknown'}`, currentSocket);
}

async function initializeApplication() {
	initializeGlobals();

	configManager = createConfigManager({
		root: __dirname,
		logger,
		globalConfig: global.config
	});

	commandManager = createCommandManager({
		directory: path.join(__dirname, 'scripts', 'cmds'),
		configPath: configManager.paths.commands,
		logger,
		getConfig: () => global.config
	});

	eventManager = createEventManager({
		directory: path.join(__dirname, 'scripts', 'events'),
		configPath: configManager.paths.events,
		logger,
		getConfig: () => global.config
	});

	global.client.commandManager = commandManager;

	global.client.eventManager = eventManager;

	db = await database.initialize({
		file: path.resolve(__dirname, global.config.database.file),
		logger,
		config: global.config
	});

	global.db = db;

	if (global.config.database.backupOnStart) {
		try {
			await db.backup();
		} catch (error) {
			logger.warn('DATABASE', 'Startup backup failed', error);
		}
	}

	await db.localData.ensure('adminMode', {
		enabled: Boolean(global.config.adminModeDefault)
	});

	await commandManager.reloadAll();
	await eventManager.reloadAll();

	if (global.config.autoReload?.enabled) {
		commandManager.startWatch();
		eventManager.startWatch();
	}

	configManager.start(() => {
		void commandManager.reloadAll().catch((error) => {
			logger.error('COMMANDS', 'Main config reload failed', error);
		});

		void eventManager.reloadAll().catch((error) => {
			logger.error('EVENTS', 'Main config reload failed', error);
		});

		if (global.config.autoReload?.enabled) {
			commandManager.startWatch();
			eventManager.startWatch();
		} else {
			commandManager.stopWatch();
			eventManager.stopWatch();
		}
	});

	configManager.watchCommandConfig(() => {
		void commandManager.reloadAll().catch((error) => {
			logger.error('COMMANDS', 'Command config reload failed', error);
		});
	});

	configManager.watchEventConfig(() => {
		void eventManager.reloadAll().catch((error) => {
			logger.error('EVENTS', 'Event config reload failed', error);
		});
	});

	autoUptime.start();

	baileysModule = await import('@whiskeysockets/baileys');

	await connect(baileysModule);
}

function scheduleAutoReboot(reason = 'auto-reboot') {
	const autoReboot = initialConfig.autoReboot;

	if (!autoReboot?.enabled) return;

	const timeMs = Number(autoReboot.timeMs);
	if (!Number.isFinite(timeMs) || timeMs < 0) return;

	const minutes = Math.round(timeMs / 60000);
	const exitCode = 2;

	logger.info('SYSTEM', `System rebooting in ${minutes} minutes`);

	setTimeout(() => {
		logger.info('SYSTEM', `Shutting down (${reason})`, { exitCode });
		process.exit(exitCode);
	}, timeMs);
}

async function main() {
	installProcessSafety();

	try {
		await initializeApplication();
		logger.success(
			'SYSTEM',
			`Started • ${commandManager.count} commands • ${
				eventManager.count
			} events`
		);
		scheduleAutoReboot();
	} catch (error) {
		logger.fatal('SYSTEM', 'Fatal startup failure', error);

		void shutdown('startup-failure', getRestartExitCode());
	}
}

main();
