import { relations, sql } from "drizzle-orm";
import {
	boolean,
	check,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { applications } from "./application";

export const updateTargetType = pgEnum("updateTargetType", [
	"dokploy",
	"application",
]);
export const updateMode = pgEnum("updateMode", ["notify", "auto"]);
// `digest`: a moving tag, updated when it points to a new image. The others
// follow semver tags, up to the highest version the rule allows.
export const updateVersionRule = pgEnum("updateVersionRule", [
	"digest",
	"patch",
	"minor",
	"major",
]);
export const updateRunKind = pgEnum("updateRunKind", ["update", "rollback"]);
// `skipped`, `notified` and `interrupted` are written by the panel; the
// others mirror the Dokploy updater's state.json (scripts/dokploy-updater.sh).
export const updateRunStatus = pgEnum("updateRunStatus", [
	"skipped",
	"notified",
	"backing_up",
	"updating",
	"verifying",
	"restoring",
	"succeeded",
	"rolled_back",
	"aborted",
	"failed",
	"interrupted",
]);

/**
 * Scheduled update rule, for Dokploy itself (one for the whole instance) or
 * for one application. Created disabled: nothing updates on its own until
 * someone turns it on.
 */
export const updatePolicy = pgTable(
	"update_policy",
	{
		updatePolicyId: text("updatePolicyId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		targetType: updateTargetType("targetType").notNull(),
		applicationId: text("applicationId").references(
			() => applications.applicationId,
			{ onDelete: "cascade" },
		),
		// The application's organization; empty for Dokploy, which every
		// organization of the instance shares.
		organizationId: text("organizationId").references(() => organization.id, {
			onDelete: "cascade",
		}),
		enabled: boolean("enabled").notNull().default(false),
		mode: updateMode("mode").notNull().default("notify"),
		versionRule: updateVersionRule("versionRule").notNull().default("digest"),
		minAgeHours: integer("minAgeHours").notNull().default(72),
		windowDays: integer("windowDays").array().notNull(),
		windowStart: text("windowStart").notNull(),
		windowDurationMinutes: integer("windowDurationMinutes")
			.notNull()
			.default(120),
		timezone: text("timezone").notNull().default("UTC"),
		verifyMinutes: integer("verifyMinutes").notNull().default(5),
		backupIds: jsonb("backupIds").$type<string[]>().notNull().default([]),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("update_policy_dokploy_unique")
			.on(table.targetType)
			.where(sql`"targetType" = 'dokploy'`),
		uniqueIndex("update_policy_application_unique").on(table.applicationId),
		check(
			"update_policy_target",
			sql`("targetType" = 'dokploy') = ("applicationId" IS NULL)`,
		),
	],
);

/** One attempt of a policy: checked, skipped, notified, applied or put back. */
export const updateRun = pgTable("update_run", {
	updateRunId: text("updateRunId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	// Kept when the policy is deleted, so the history stays readable.
	updatePolicyId: text("updatePolicyId").references(
		() => updatePolicy.updatePolicyId,
		{ onDelete: "set null" },
	),
	targetType: updateTargetType("targetType").notNull(),
	applicationId: text("applicationId").references(
		() => applications.applicationId,
		{ onDelete: "cascade" },
	),
	kind: updateRunKind("kind").notNull().default("update"),
	status: updateRunStatus("status").notNull(),
	fromImage: text("fromImage"),
	toImage: text("toImage"),
	reason: text("reason"),
	// Folder of the Dokploy updater under /etc/dokploy/updates/runs.
	updaterRunId: text("updaterRunId"),
	startedAt: text("startedAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	finishedAt: text("finishedAt"),
});

export const updatePolicyRelations = relations(
	updatePolicy,
	({ one, many }) => ({
		application: one(applications, {
			fields: [updatePolicy.applicationId],
			references: [applications.applicationId],
		}),
		organization: one(organization, {
			fields: [updatePolicy.organizationId],
			references: [organization.id],
		}),
		runs: many(updateRun),
	}),
);

export const updateRunRelations = relations(updateRun, ({ one }) => ({
	policy: one(updatePolicy, {
		fields: [updateRun.updatePolicyId],
		references: [updatePolicy.updatePolicyId],
	}),
	application: one(applications, {
		fields: [updateRun.applicationId],
		references: [applications.applicationId],
	}),
}));

export type UpdatePolicy = typeof updatePolicy.$inferSelect;
export type UpdateRun = typeof updateRun.$inferSelect;
