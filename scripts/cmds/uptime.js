/** @format */

'use strict';

const os = require('node:os');

const formatBytes = (bytes) => {
	if (!Number.isFinite(bytes) || bytes < 0) return 'N/A';

	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let size = bytes;
	let index = 0;

	while (size >= 1024 && index < units.length - 1) {
		size /= 1024;
		index++;
	}

	return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
};

const formatDuration = (seconds) => {
	seconds = Math.max(0, Math.floor(seconds));

	const units = [
		['d', 86400],
		['h', 3600],
		['m', 60],
		['s', 1]
	];

	const parts = [];

	for (const [label, divisor] of units) {
		const value = Math.floor(seconds / divisor);

		if (value > 0) {
			parts.push(`${value}${label}`);
			seconds %= divisor;
		}
	}

	return parts.join(' ') || '0s';
};

const percent = (used, total) =>
	Number.isFinite(used) && Number.isFinite(total) && total > 0
		? `${((used / total) * 100).toFixed(1)}%`
		: 'N/A';

const section = (title, rows) =>
	`╭─「 *${title}* 」\n${rows
		.map(([label, value]) => `│ ${label}: ${value}`)
		.join('\n')}\n╰────────────`;

const formatDate = (date) =>
	new Intl.DateTimeFormat('en-GB', {
		dateStyle: 'medium',
		timeStyle: 'short'
	}).format(date);

const getCpuSnapshot = () => {
	const cpus = os.cpus();

	let idle = 0;
	let total = 0;

	for (const cpu of cpus) {
		for (const [name, time] of Object.entries(cpu.times)) {
			total += time;

			if (name === 'idle') idle += time;
		}
	}

	return {
		cores: cpus.length,
		model: cpus[0]?.model?.trim() || 'Unknown',
		idle,
		total
	};
};

const getProcessCpuAverage = () => {
	const usage = process.cpuUsage();
	const elapsedMs = process.uptime() * 1000;

	if (elapsedMs <= 0) return 'N/A';

	const cpuMs = (usage.user + usage.system) / 1000;

	return `${((cpuMs / elapsedMs) * 100).toFixed(1)}%`;
};

module.exports = {
	config: {
		name: 'uptime',
		version: '7.1.0',
		author: 'Jsux',
		role: 0,
		category: 'Utility',
		description:
			'Display bot uptime, restart countdown, and resource statistics.',
		usage: '!uptime'
	},

	async onStart({ message, client }) {
		const now = Date.now();
		const runtime = client?.runtime || {};
		const startedAt = Number(runtime.startedAt);

		const processUptime =
			Number.isFinite(startedAt) && startedAt > 0
				? Math.max(0, (now - startedAt) / 1000)
				: process.uptime();

		const mem = process.memoryUsage();
		const totalMemory = os.totalmem();
		const freeMemory = os.freemem();
		const usedMemory = totalMemory - freeMemory;
		const cpu = getCpuSnapshot();

		const autoRestart = global.client?.runtime?.autoRestart;
		const endTime = Number(autoRestart?.endTime);
		const restartActive = Number.isFinite(endTime) && endTime > now;

		const restartRows = [
			['Status', restartActive ? 'Scheduled' : 'Inactive']
		];

		if (restartActive) {
			try {
				const remaining = await autoRestart.timeRemaining();

				if (
					remaining &&
					Number.isFinite(remaining.ms) &&
					typeof remaining.readable === 'string'
				) {
					restartRows.push(
						['Countdown', remaining.readable],
						[
							'Remaining',
							`${remaining.ms.toLocaleString('en-US')} ms`
						],
						['Restart at', formatDate(new Date(endTime))]
					);
				} else {
					// Fall back to the stored end timestamp if the helper
					// returns an unexpected value.
					restartRows.push(
						['Countdown', formatDuration((endTime - now) / 1000)],
						['Restart at', formatDate(new Date(endTime))]
					);
				}
			} catch {
				restartRows.push(
					['Countdown', formatDuration((endTime - now) / 1000)],
					['Restart at', formatDate(new Date(endTime))]
				);
			}
		}

		const lines = [
			'*⌁ UPTIME REPORT*',
			'',
			section('RUNTIME', [
				[
					'Bot uptime',
					global.utils?.duration
						? global.utils.duration(
								Math.floor(processUptime * 1000)
							)
						: formatDuration(processUptime)
				],
				[
					'Started',
					Number.isFinite(startedAt) && startedAt > 0
						? formatDate(new Date(startedAt))
						: 'Unknown'
				],
				['Checked', formatDate(new Date(now))],
				['PID', process.pid]
			]),
			'',
			section('AUTO-RESTART', restartRows),
			'',
			section('PROCESS', [
				[
					'RAM / RSS',
					`${formatBytes(mem.rss)} (${percent(mem.rss, totalMemory)} of system RAM)`
				],
				[
					'Heap',
					`${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)} (${percent(mem.heapUsed, mem.heapTotal)})`
				],
				['External', formatBytes(mem.external)],
				['Array buffers', formatBytes(mem.arrayBuffers ?? 0)],
				['Avg. CPU', `${getProcessCpuAverage()} of one core`]
			]),
			'',
			section('SYSTEM', [
				['Uptime', formatDuration(os.uptime())],
				[
					'RAM used',
					`${formatBytes(usedMemory)} / ${formatBytes(totalMemory)} (${percent(usedMemory, totalMemory)})`
				],
				['RAM free', formatBytes(freeMemory)],
				['CPU', cpu.model],
				['Logical cores', cpu.cores],
				[
					'Load 1/5/15m',
					os
						.loadavg()
						.map((value) => value.toFixed(2))
						.join(' / ')
				]
			]),
			'',
			section('ENVIRONMENT', [
				['Node.js', process.version],
				['Platform', `${process.platform} / ${process.arch}`],
				['OS', `${os.type()} ${os.release()}`],
				['Hostname', os.hostname()]
			])
		];

		await message.reply(lines.join('\n'));
	}
};
