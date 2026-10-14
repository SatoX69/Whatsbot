/** @format */

'use strict';

module.exports = {
	config: {
		name: 'eval',
		version: '4.0.0',
		author: 'Jsux',
		role: 3,
		category: 'system',
		description: 'Evaluate asynchronous JavaScript inside the bot process.',
		usage: '!eval <javascript>'
	},

	async onStart({
		args,
		message,
		api,
		event,
		client,
		config,
		usersData,
		threadsData,
		localData,
		log
	}) {
		const out = (...values) => {
			const result =
				values.length === 1
					? global.utils.stringify(values[0])
					: values
							.map((value) => global.utils.stringify(value))
							.join('\n');
			return message.reply(result);
		};
		const errorText = JSON.stringify(config.texts?.error || 'Error');

		const cmd = `
      (async () => {
        try {
          ${args.join(' ')}
        }
        catch(err) {
          log.err("eval command", err);
          await message.send(
            ${errorText} + "\\n" +
            (err.stack || JSON.stringify(err, null, 2) || "")
          );
        }
      })()`;

		// Lexically available inside eval: args, message, api, event, client,
		// config, usersData, threadsData, localData, out, and log.
		try {
			await eval(cmd);
		} catch (err) {
			log.err('eval command', err);
			await message.send(
				`${config.texts?.error || 'Error'}\n${err.stack || JSON.stringify(err, null, 2) || ''}`
			);
		}
	}
};
