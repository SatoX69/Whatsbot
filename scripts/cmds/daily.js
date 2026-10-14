const COOLDOWN = 24 * 60 * 60 * 1000;
const REWARD_MIN = 500;
const REWARD_MAX = 1500;

module.exports = {
	config: {
		name: "daily",
		version: "2.2",
		author: "Jsux",
		countDown: 5,
		role: 0,
		description: "Claim your daily money reward.",
		category: "game",
		guide: "{pn} - Claim your daily reward"
	},

	async onStart({ event, message, usersData }) {
		const uid = event.senderID;

		if (!uid)
			return;

		try {
			const now = Date.now();
			const lastClaim = Number(
				await usersData.get(uid, "data.lastDailyClaim", 0)
			) || 0;

			const remaining = COOLDOWN - (now - lastClaim);

			if (remaining > 0) {
				const totalMinutes = Math.ceil(remaining / 60000);
				const hours = Math.floor(totalMinutes / 60);
				const minutes = totalMinutes % 60;

				return message.reply(
					`You've already claimed your daily reward. Try again in ${hours} hours and ${minutes} minutes.`
				);
			}

			await usersData.set(uid, now, "data.lastDailyClaim");

			const reward =
				Math.floor(Math.random() * (REWARD_MAX - REWARD_MIN + 1)) +
				REWARD_MIN;

			await usersData.addMoney(uid, reward);

			return message.reply(
				`Daily reward claimed! You received $${reward.toLocaleString("en-US")}. Come back in 24 hours for your next reward.`
			);
		} catch (error) {
			console.error("[daily]", error);

			return message.reply(
				"Failed to claim your daily reward. Please try again later."
			);
		}
	}
};