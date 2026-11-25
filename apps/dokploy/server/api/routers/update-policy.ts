import { IS_CLOUD } from "@dokploy/server";
import { serviceImage } from "@dokploy/server/auto-update/dokploy-check";
import {
	runDokployWindow,
	scheduleDokployAutoUpdate,
} from "@dokploy/server/auto-update/dokploy-runner";
import {
	isUpdaterRunning,
	readUpdaterState,
	resumeDokployUpdate,
} from "@dokploy/server/auto-update/dokploy-updater";
import {
	currentOrNextOccurrence,
	DOKPLOY_UPDATE_MARGIN_MINUTES,
} from "@dokploy/server/auto-update/window";
import type { UpdatePolicy } from "@dokploy/server/db/schema";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import {
	findApplicationUpdatePolicy,
	findDokployUpdatePolicy,
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

	getForApplication: protectedProcedure
		.input(applicationInput)
		.query(async ({ ctx, input }) => {
			assertSelfHosted();
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["read"],
			});
			const dokploy = await findDokployUpdatePolicy();
			return {
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
			return withNextWindow(policy);
		}),
});
