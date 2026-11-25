import { IS_CLOUD } from "@dokploy/server";
import {
	runAppWindow,
	scheduleAppAutoUpdate,
} from "@dokploy/server/auto-update/app-runner";
import { serviceImage } from "@dokploy/server/auto-update/dokploy-check";
import {
	runDokployWindow,
	scheduleDokployAutoUpdate,
} from "@dokploy/server/auto-update/dokploy-runner";
import {
	findRollbackableRuns,
	isUpdaterRunning,
	readUpdaterState,
	resumeDokployUpdate,
	rollbackDokployTo,
} from "@dokploy/server/auto-update/dokploy-updater";
import {
	currentOrNextOccurrence,
	DOKPLOY_UPDATE_MARGIN_MINUTES,
} from "@dokploy/server/auto-update/window";
import type { UpdatePolicy } from "@dokploy/server/db/schema";
import { findApplicationById } from "@dokploy/server/services/application";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import {
	findApplicationUpdatePolicy,
	findDokployUpdatePolicy,
	listEnvironmentBackups,
	listUpdateRuns,
	policyWindow,
	saveApplicationUpdatePolicy,
	saveDokployUpdatePolicy,
	updatePolicySettingsSchema,
} from "@dokploy/server/services/update-policy";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";

const withNextWindow = (policy: UpdatePolicy | null) =>
	policy && {
		...policy,
		nextWindow: policy.enabled
			? currentOrNextOccurrence(policyWindow(policy))
			: null,
	};

const assertSelfHosted = () => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Scheduled updates are for self-hosted Dokploy.",
		});
	}
};

const applicationInput = z.object({ applicationId: z.string().min(1) });

export const updatePolicyRouter = createTRPCRouter({
	getDokploy: adminProcedure.query(async () => {
		assertSelfHosted();
		return {
			policy: withNextWindow(await findDokployUpdatePolicy()),
			marginMinutes: DOKPLOY_UPDATE_MARGIN_MINUTES,
			runs: await listUpdateRuns({ type: "dokploy" }),
			updater: {
				state: await readUpdaterState().catch(() => null),
				running: await isUpdaterRunning().catch(() => false),
			},
			rollbackable: (await findRollbackableRuns().catch(() => [])).map(
				(run) => ({
					updaterRunId: run.updaterRunId as string,
					startedAt: run.startedAt,
					fromImage: run.fromImage,
					toImage: run.toImage,
				}),
			),
		};
	}),

	saveDokploy: adminProcedure
		.input(updatePolicySettingsSchema)
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			const policy = await saveDokployUpdatePolicy(input);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceId: policy.updatePolicyId,
				resourceName: "dokploy-update-policy",
				metadata: { enabled: policy.enabled, mode: policy.mode },
			});
			scheduleDokployAutoUpdate(policy);
			// Saved while its window is open: no need to wait a week.
			void runDokployWindow();
			return withNextWindow(policy);
		}),

	resumeDokploy: adminProcedure.mutation(async ({ ctx }) => {
		assertSelfHosted();
		try {
			await resumeDokployUpdate(await serviceImage());
		} catch (error) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: error instanceof Error ? error.message : String(error),
			});
		}
		await audit(ctx, {
			action: "restore",
			resourceType: "settings",
			resourceName: "dokploy-update",
		});
		return true;
	}),

	rollbackDokploy: adminProcedure
		.input(z.object({ updaterRunId: z.string().regex(/^[\w-]+$/) }))
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			try {
				await rollbackDokployTo(input.updaterRunId, await serviceImage());
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : String(error),
				});
			}
			await audit(ctx, {
				action: "restore",
				resourceType: "settings",
				resourceName: "dokploy-version",
				metadata: { updaterRunId: input.updaterRunId },
			});
			return true;
		}),

	getForApplication: protectedProcedure
		.input(applicationInput)
		.query(async ({ ctx, input }) => {
			assertSelfHosted();
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["read"],
			});
			const dokploy = await findDokployUpdatePolicy();
			const application = await findApplicationById(input.applicationId);
			return {
				sourceType: application.sourceType,
				dockerImage: application.dockerImage,
				backupOptions: (
					await listEnvironmentBackups(application.environmentId)
				).map(({ backupId, label }) => ({ backupId, label })),
				policy: withNextWindow(
					await findApplicationUpdatePolicy(input.applicationId),
				),
				dokployWindow: dokploy?.enabled ? policyWindow(dokploy) : null,
				marginMinutes: DOKPLOY_UPDATE_MARGIN_MINUTES,
				runs: await listUpdateRuns({
					type: "application",
					applicationId: input.applicationId,
				}),
			};
		}),

	saveForApplication: protectedProcedure
		.input(applicationInput.extend({ settings: updatePolicySettingsSchema }))
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});
			if (input.settings.backupIds.length > 0) {
				const application = await findApplicationById(input.applicationId);
				const options = await listEnvironmentBackups(application.environmentId);
				for (const backupId of input.settings.backupIds) {
					const option = options.find((o) => o.backupId === backupId);
					if (!option) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message:
								"Backups to run first must belong to this application's environment.",
						});
					}
					await checkServicePermissionAndAccess(ctx, option.serviceId, {
						backup: ["create"],
					});
				}
			}
			const policy = await saveApplicationUpdatePolicy(
				input.applicationId,
				ctx.session.activeOrganizationId,
				input.settings,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: input.applicationId,
				resourceName: "update-policy",
				metadata: { enabled: policy.enabled, mode: policy.mode },
			});
			scheduleAppAutoUpdate(policy);
			void runAppWindow(policy.updatePolicyId);
			return withNextWindow(policy);
		}),
});
