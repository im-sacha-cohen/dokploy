import { db } from "@dokploy/server/db";
import { notifications } from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";
import {
	sendCustomNotification,
	sendDiscordNotification,
	sendEmailNotification,
	sendGotifyNotification,
	sendLarkNotification,
	sendMattermostNotification,
	sendNtfyNotification,
	sendPushoverNotification,
	sendResendNotification,
	sendSlackNotification,
	sendTeamsNotification,
	sendTelegramNotification,
} from "./utils";

export type UpdateNoticeOutcome = "success" | "failure" | "info";

export interface UpdateNotice {
	event: "dokployUpdate" | "appUpdate";
	title: string;
	outcome: UpdateNoticeOutcome;
	facts: { name: string; value: string }[];
	/** App updates go to that organization only; Dokploy's go to all. */
	organizationId?: string | null;
}

const ICON: Record<UpdateNoticeOutcome, string> = {
	success: "✅",
	failure: "⚠️",
	info: "ℹ️",
};
const COLOR: Record<UpdateNoticeOutcome, number> = {
	success: 0x57f287,
	failure: 0xed4245,
	info: 0x5865f2,
};

const escapeHtml = (text: string) =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

/** Sends a scheduled-update notice through every channel subscribed to it. */
export const sendUpdateNotifications = async (notice: UpdateNotice) => {
	const flag =
		notice.event === "dokployUpdate"
			? notifications.dokployUpdate
			: notifications.appUpdate;
	const list = await db.query.notifications.findMany({
		where: notice.organizationId
			? and(
					eq(flag, true),
					eq(notifications.organizationId, notice.organizationId),
				)
			: eq(flag, true),
		with: {
			email: true,
			discord: true,
			telegram: true,
			slack: true,
			resend: true,
			gotify: true,
			ntfy: true,
			mattermost: true,
			custom: true,
			lark: true,
			pushover: true,
			teams: true,
		},
	});

	const title = `${ICON[notice.outcome]} ${notice.title}`;
	const plain = notice.facts.map((f) => `${f.name}: ${f.value}`).join("\n");
	const markdown = notice.facts
		.map((f) => `**${f.name}:** ${f.value}`)
		.join("\n");
	const html = `<h2>${escapeHtml(title)}</h2><ul>${notice.facts
		.map((f) => `<li><b>${escapeHtml(f.name)}:</b> ${escapeHtml(f.value)}</li>`)
		.join("")}</ul>`;

	for (const n of list) {
		try {
			if (n.email) await sendEmailNotification(n.email, title, html);
			if (n.resend) await sendResendNotification(n.resend, title, html);
			if (n.discord) {
				await sendDiscordNotification(n.discord, {
					title,
					color: COLOR[notice.outcome],
					fields: notice.facts.map((f) => ({ name: f.name, value: f.value })),
					timestamp: new Date().toISOString(),
					footer: { text: "Dokploy scheduled update" },
				});
			}
			if (n.gotify) await sendGotifyNotification(n.gotify, title, plain);
			if (n.ntfy) {
				await sendNtfyNotification(
					n.ntfy,
					notice.title,
					notice.outcome === "failure" ? "warning" : "arrows_counterclockwise",
					"",
					plain,
				);
			}
			if (n.telegram) {
				await sendTelegramNotification(
					n.telegram,
					`<b>${escapeHtml(title)}</b>\n\n${notice.facts
						.map((f) => `<b>${escapeHtml(f.name)}:</b> ${escapeHtml(f.value)}`)
						.join("\n")}`,
				);
			}
			if (n.slack) {
				await sendSlackNotification(n.slack, {
					channel: n.slack.channel,
					attachments: [
						{
							color: `#${COLOR[notice.outcome].toString(16).padStart(6, "0")}`,
							pretext: `*${title}*`,
							fields: notice.facts.map((f) => ({
								title: f.name,
								value: f.value,
								short: false,
							})),
						},
					],
				});
			}
			if (n.mattermost) {
				await sendMattermostNotification(n.mattermost, {
					text: `**${title}**\n\n${markdown}`,
					channel: n.mattermost.channel,
					username: n.mattermost.username || "Dokploy",
				});
			}
			if (n.custom) {
				await sendCustomNotification(n.custom, {
					title: notice.title,
					message: plain,
					status: notice.outcome,
					type:
						notice.event === "dokployUpdate" ? "dokploy-update" : "app-update",
					facts: notice.facts,
					timestamp: new Date().toISOString(),
				});
			}
			if (n.lark) {
				await sendLarkNotification(n.lark, {
					msg_type: "text",
					content: { text: `${title}\n${plain}` },
				});
			}
			if (n.pushover) await sendPushoverNotification(n.pushover, title, plain);
			if (n.teams) {
				await sendTeamsNotification(n.teams, { title, facts: notice.facts });
			}
		} catch (error) {
			console.error("[auto-update] Notification failed:", error);
		}
	}
};
