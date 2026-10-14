/** @format */

const fs = require('fs');
const path = require('path');

const FILE = path.join(process.cwd(), 'scripts/assets/count.json');
const INTERVAL = 60 * 60 * 1000;
const KEY = 'messageCounts';

const state = (global.messageCounts ||= {
	users: Object.create(null),
	total: 0,
	ready: false,
	dirty: false,
	init: null,
	flush: null,
	timer: null
});

async function save() {
	if (!state.ready || !state.dirty) return;
	if (state.flush) return state.flush;

	state.flush = (async () => {
		const data = {
			users: { ...state.users },
			total: state.total,
			updatedAt: Date.now()
		};

		fs.mkdirSync(path.dirname(FILE), { recursive: true });
		const temp = `${FILE}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(data));
		fs.renameSync(temp, FILE);

		await global.db.localData.set(KEY, data);

		state.dirty = false;
	})();

	try {
		await state.flush;
	} catch (error) {
		console.error('[count]', error.message);
	} finally {
		state.flush = null;
	}
}

async function init() {
	if (state.ready) return;
	if (state.init) return state.init;

	state.init = (async () => {
		let file = {};
		let db = {};

		try {
			file = JSON.parse(fs.readFileSync(FILE, 'utf8'));
		} catch {}

		try {
			db = (await global.db.localData.get(KEY)) || {};
		} catch {}

		const users = Object.create(null);

		for (const source of [file.users, db.users]) {
			if (!source || typeof source !== 'object') continue;

			for (const [id, value] of Object.entries(source)) {
				const count = Number(value);
				if (Number.isSafeInteger(count) && count >= 0) {
					users[id] = Math.max(users[id] || 0, count);
				}
			}
		}

		state.users = users;
		state.total = Object.values(users).reduce(
			(sum, count) => sum + count,
			0
		);
		state.ready = true;
		state.dirty = true;

		await save();

		state.timer ||= setInterval(save, INTERVAL);
		state.timer.unref?.();
	})();

	try {
		await state.init;
	} finally {
		state.init = null;
	}
}

module.exports = {
	config: {
		name: 'count',
		version: '2.0.0',
		author: 'Jsux',
		category: 'info',
		description: 'Track message counts',
		role: 0,
		countDown: 3
	},

	onChat: async ({ event }) => {
		if (!event?.senderID || event.type === 'reaction') return;

		if (!state.ready) await init();

		const id = String(event.senderID);
		state.users[id] = (state.users[id] || 0) + 1;
		state.total++;
		state.dirty = true;
	},

	onStart: async ({ event, message, usersData }) => {
		await init();

		const count = state.users[String(event.senderID)] || 0;
		const usersAll = await usersData.getAll();
		return message.reply(
			`Your messages: ${count.toLocaleString()}\n` +
				`Total messages: ${state.total.toLocaleString()}\n` +
				`Tracked users: ${usersAll.length.toLocaleString()}`
		);
	}
};
