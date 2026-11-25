import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
	DOKPLOY_UPDATE_MARGIN_MINUTES,
	findWindowConflicts,
	formatOccurrence,
	type MaintenanceWindow,
	maintenanceWindowSchema,
	suggestFreeStartTime,
} from "../auto-update/window";
import { db } from "../db";
import {
	type UpdatePolicy,
	updatePolicy,
	updateRun,
} from "../db/schema/auto-update";

export const updatePolicySettingsSchema = z.object({
	enabled: z.boolean(),
	mode: z.enum(["notify", "auto"]),
	versionRule: z.enum(["digest", "patch", "minor", "major"]),
	minAgeHours: z
		.number()
		.int()
		.min(0)
		.max(24 * 30),
	window: maintenanceWindowSchema,
	verifyMinutes: z.number().int().min(1).max(60),
	backupIds: z.array(z.string().min(1)).max(20).default([]),
});
export type UpdatePolicySettings = z.infer<typeof updatePolicySettingsSchema>;

export const policyWindow = (policy: UpdatePolicy): MaintenanceWindow => ({
	days: policy.windowDays,
	startTime: policy.windowStart,
	durationMinutes: policy.windowDurationMinutes,
	timezone: policy.timezone,
});

const toColumns = (settings: UpdatePolicySettings) => ({
	enabled: settings.enabled,
	mode: settings.mode,
	versionRule: settings.versionRule,
	minAgeHours: settings.minAgeHours,
	windowDays: [...settings.window.days].sort((a, b) => a - b),
	windowStart: settings.window.startTime,
	windowDurationMinutes: settings.window.durationMinutes,
	timezone: settings.window.timezone,
	verifyMinutes: settings.verifyMinutes,
	backupIds: settings.backupIds,
	updatedAt: new Date().toISOString(),
});

export const findDokployUpdatePolicy = async () =>
	(await db.query.updatePolicy.findFirst({
		where: eq(updatePolicy.targetType, "dokploy"),
	})) ?? null;

export const findApplicationUpdatePolicy = async (applicationId: string) =>
	(await db.query.updatePolicy.findFirst({
		where: eq(updatePolicy.applicationId, applicationId),
	})) ?? null;

const enabledApplicationPolicies = () =>
	db.query.updatePolicy.findMany({
		where: and(
			eq(updatePolicy.targetType, "application"),
			eq(updatePolicy.enabled, true),
		),
		with: { application: { columns: { name: true, appName: true } } },
	});

const MARGIN = `${DOKPLOY_UPDATE_MARGIN_MINUTES} minutes`;

/**
 * An app updated within the margin of the Dokploy window would be forgotten
 * by the panel if the Dokploy update failed and its database backup were
 * restored: refused when either side is saved enabled.
 */
const assertNoConflictWithDokploy = (
	window: MaintenanceWindow,
	dokploy: UpdatePolicy | null,
) => {
	if (!dokploy?.enabled) return;
	const dokployWindow = policyWindow(dokploy);
	const conflicts = findWindowConflicts(window, dokployWindow);
	const first = conflicts[0];
	if (!first) return;
	const suggestion = suggestFreeStartTime(window, dokployWindow);
	throw new TRPCError({
		code: "CONFLICT",
		message:
			`This window comes within ${MARGIN} of the Dokploy update window ` +
			`(first time: ${formatOccurrence(first.application.start, window.timezone)}). ` +
			(suggestion
				? `Starting at ${suggestion} on the same days would be free.`
				: "No start time on these days is free: choose other days."),
	});
};

const assertNoApplicationConflicts = async (window: MaintenanceWindow) => {
	const clashes: string[] = [];
	for (const policy of await enabledApplicationPolicies()) {
		const appWindow = policyWindow(policy);
		const first = findWindowConflicts(appWindow, window)[0];
		if (first) {
			clashes.push(
				`${policy.application?.name ?? policy.applicationId} (${formatOccurrence(first.application.start, appWindow.timezone)})`,
			);
		}
	}
	if (clashes.length === 0) return;
	throw new TRPCError({
		code: "CONFLICT",
		message:
			`These applications update within ${MARGIN} of this window: ` +
			`${clashes.join(", ")}. Move their windows or this one.`,
	});
};

export const saveDokployUpdatePolicy = async (
	settings: UpdatePolicySettings,
) => {
	if (settings.enabled) await assertNoApplicationConflicts(settings.window);
	const existing = await findDokployUpdatePolicy();
	const columns = { ...toColumns(settings), backupIds: [] };
	if (existing) {
		const [updated] = await db
			.update(updatePolicy)
			.set(columns)
			.where(eq(updatePolicy.updatePolicyId, existing.updatePolicyId))
			.returning();
		return updated as UpdatePolicy;
	}
	const [created] = await db
		.insert(updatePolicy)
		.values({ ...columns, targetType: "dokploy" })
		.returning();
	return created as UpdatePolicy;
};

export const saveApplicationUpdatePolicy = async (
	applicationId: string,
	organizationId: string,
	settings: UpdatePolicySettings,
) => {
	if (settings.enabled) {
		assertNoConflictWithDokploy(
			settings.window,
			await findDokployUpdatePolicy(),
		);
	}
	const existing = await findApplicationUpdatePolicy(applicationId);
	const columns = toColumns(settings);
	if (existing) {
		const [updated] = await db
			.update(updatePolicy)
			.set(columns)
			.where(eq(updatePolicy.updatePolicyId, existing.updatePolicyId))
			.returning();
		return updated as UpdatePolicy;
	}
	const [created] = await db
		.insert(updatePolicy)
		.values({
			...columns,
			targetType: "application",
			applicationId,
			organizationId,
		})
		.returning();
	return created as UpdatePolicy;
};

export const listUpdateRuns = (
	target: { type: "dokploy" } | { type: "application"; applicationId: string },
	limit = 20,
) =>
	db.query.updateRun.findMany({
		where:
			target.type === "dokploy"
				? and(
						eq(updateRun.targetType, "dokploy"),
						isNull(updateRun.applicationId),
					)
				: eq(updateRun.applicationId, target.applicationId),
		orderBy: desc(updateRun.startedAt),
		limit,
	});
