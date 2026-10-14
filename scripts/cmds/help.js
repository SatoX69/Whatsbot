'use strict';

const ROLE_NAMES = {
	0: 'all',
	1: 'group admins',
	2: 'bot admins',
	3: 'bot devs'
};

const roleName = role => ROLE_NAMES[Number(role)] || 'unknown';

const titleCase = value =>
	String(value || 'General')
		.trim()
		.toLowerCase()
		.replace(/\b\w/g, char => char.toUpperCase());

const replacePrefix = (value, prefix) =>
	String(value || '').replace(/\{pn\}/gi, prefix);

function getLocalized(value) {
	if (value == null) return '';

	if (typeof value === 'string' || typeof value === 'number') {
		return String(value);
	}

	if (typeof value === 'object') {
		return String(
			value.en ??
			value.english ??
			Object.values(value)[0] ??
			''
		);
	}

	return '';
}

function getDescription(commandConfig) {
	return (
		getLocalized(commandConfig.description) ||
		getLocalized(commandConfig.shortDescription) ||
		getLocalized(commandConfig.longDescription) ||
		'No description available.'
	);
}

function getUsage(commandConfig, name, prefix) {
	const guide = getLocalized(commandConfig.guide);

	if (guide) {
		const firstLine = guide
			.split('\n')
			.map(line => line.trim())
			.find(Boolean);

		if (firstLine) {
			return replacePrefix(firstLine, prefix);
		}
	}

	return replacePrefix(
		getLocalized(commandConfig.usage) || `${prefix}${name}`,
		prefix
	);
}

module.exports = {
	config: {
		name: 'help',
		version: '5.0.0',
		author: 'Jsux',
		role: 0,
		category: 'Utility',
		description: 'List loaded commands or show one command in detail.',
		usage: '{pn} [command]'
	},

	async onStart({ args, message, commandManager, config }) {
		const prefix = String(config.prefix || '');
		const commands = commandManager.list();

		const lookup = new Map();

		for (const command of commands) {
			const commandConfig = command?.config || {};
			const name = String(commandConfig.name || '').trim();

			if (!name) continue;

			lookup.set(name.toLowerCase(), command);

			for (const alias of commandConfig.aliases || []) {
				const value = String(alias).trim().toLowerCase();
				if (value) lookup.set(value, command);
			}
		}

		const requested = String(args[0] || '').trim().toLowerCase();

		if (requested) {
			const command = lookup.get(requested);

			if (!command) {
				if (config.textlogs?.cmdnotfound !== false) {
					await message.reply(
						config.texts?.cmdnotfound || 'No such command found.'
					);
				}
				return;
			}

			const commandConfig = command.config || {};
			const name = String(commandConfig.name || 'unknown');

			const aliases = (commandConfig.aliases || [])
				.map(String)
				.map(alias => alias.trim())
				.filter(Boolean);

			const author =
				String(commandConfig.author || '').toLowerCase() === 'local'
					? 'Jsux'
					: commandConfig.author || 'unknown';

			const description = replacePrefix(
				getDescription(commandConfig),
				prefix
			);

			const usage = getUsage(
				commandConfig,
				name,
				prefix
			);

			const cooldown =
				commandConfig.countDown ??
				config.commandDefaults?.countDown;

			const lines = [
				`*${name}*`,
				'',
				`*Description:* ${description}`,
				`*Usage:* \`${usage}\``,
				`*Category:* ${titleCase(commandConfig.category)}`,
				`*Author:* ${author}`,
				`*Permission:* ${roleName(commandConfig.role ?? 0)}`
			];

			if (aliases.length) {
				lines.push(`*Aliases:* ${aliases.join(', ')}`);
			}

			if (cooldown != null) {
				lines.push(`*Cooldown:* ${cooldown}s`);
			}

			await message.reply(lines.join('\n'));
			return;
		}

		const grouped = new Map();

		for (const command of commands) {
			const commandConfig = command?.config || {};
			const rawCategory = String(
				commandConfig.category || 'General'
			).trim();

			const categoryKey = rawCategory.toLowerCase();

			if (!grouped.has(categoryKey)) {
				grouped.set(categoryKey, {
					name: titleCase(rawCategory),
					commands: []
				});
			}

			grouped.get(categoryKey).commands.push(command);
		}

		const sortedCategories = [...grouped.values()]
			.sort((a, b) => a.name.localeCompare(b.name));

		const lines = [
			'*COMMANDS*',
			'',
			`_${commands.length} commands available_`
		];

		for (const category of sortedCategories) {
			const names = category.commands
				.sort((a, b) =>
					String(a.config.name).localeCompare(
						String(b.config.name)
					)
				)
				.map(command => String(command.config.name));

			lines.push(
				'',
				`*${category.name}*`,
				names.join(' • ')
			);
		}

		lines.push(
			'',
			`_Use ${prefix}help <command> for command details._`
		);

		await message.reply(lines.join('\n'));
	}
};
