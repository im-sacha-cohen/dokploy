import { diagnoseApplication, findApplicationById } from "@dokploy/server";
import { checkServiceAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";

export const smartDeployRouter = createTRPCRouter({
	diagnoseApplication: protectedProcedure
		.input(
			z.object({
				applicationId: z.string().min(1),
				probes: z.boolean().default(true),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.applicationId, "read");
			const application = await findApplicationById(input.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this application",
				});
			}
			return diagnoseApplication(input.applicationId, {
				probes: input.probes,
			});
		}),
});
