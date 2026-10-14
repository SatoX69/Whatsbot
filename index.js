/** @format */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const chalk = require('chalk');

const config = require('./config.json');
const logger = require('./logger');

const ROOT_DIR = __dirname;
const BOT_FILE = path.join(ROOT_DIR, 'bot.js');
const TEMP_DIR = path.join(ROOT_DIR, 'temp');

const RESTART_EXIT_CODE = Number(config.runtime.restartExitCode);

let child = null;
let shuttingDown = false;

function logError(message, error) {
	logger.error('RUNTIME', message, error);
}

function resolvePath(value) {
	if (typeof value !== 'string' || !value.trim()) {
		throw new TypeError(`Invalid configured path: ${value}`);
	}

	return path.resolve(ROOT_DIR, value);
}

async function ensureRuntimeDirectories() {
	const directories = [
		config.auth.directory,
		path.dirname(resolvePath(config.database.file)),
		config.logger.directory
	];

	await Promise.all(
		directories.map((directory) =>
			fs.mkdir(resolvePath(directory), { recursive: true })
		)
	);

	await fs.mkdir(TEMP_DIR, { recursive: true });
}

async function clearTemp() {
	await fs.mkdir(TEMP_DIR, { recursive: true });

	const entries = await fs.readdir(TEMP_DIR);

	await Promise.all(
		entries.map((entry) =>
			fs.rm(path.join(TEMP_DIR, entry), {
				recursive: true,
				force: true
			})
		)
	);
}

async function launch() {
	if (shuttingDown || child) return;

	try {
		await clearTemp();

		if (shuttingDown || child) return;

		const currentChild = spawn(process.execPath, [BOT_FILE], {
			cwd: ROOT_DIR,
			stdio: 'inherit',
			env: process.env
		});

		child = currentChild;

		logger.success(
			'RUNTIME',
			`${chalk.bold('bot.js')} started (pid ${currentChild.pid ?? 'pending'})`
		);

		currentChild.once('error', (error) => {
			logError('Failed to run bot.js', error);
		});

		currentChild.once('exit', (code, signal) => {
			if (child === currentChild) child = null;

			logger.warn(
				'RUNTIME',
				`bot.js exited (code=${code ?? 'null'}, signal=${signal || 'none'})`
			);

			if (!shuttingDown && code === RESTART_EXIT_CODE) {
				launch();
			}
		});
	} catch (error) {
		logError('Failed to prepare or launch bot.js', error);
	}
}

function stop() {
	if (shuttingDown) return;

	shuttingDown = true;

	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill('SIGTERM');
	}

	process.exitCode = 0;
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

(async () => {
	try {
		await ensureRuntimeDirectories();

		console.log(chalk.cyan.bold(`\n◆ ${config.botNumber} • runtime\n`));

		await launch();
	} catch (error) {
		logError('Runtime initialization failed', error);
		process.exitCode = 1;
	}
})();
