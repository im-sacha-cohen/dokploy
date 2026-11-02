import {
	findMcpGrant,
	findMembership,
	findOAuthClient,
	getMcpResourceUrls,
	getMcpSettings,
	handleAuthorizationServerMetadata,
	handleProtectedResourceMetadata,
	isMcpScope,
	listMcpAudit,
	listMcpGrants,
	revokeMcpGrant,
	updateMcpSettings,
	upsertMcpGrant,
	writeMcpAudit,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { member } from "@dokploy/server/db/schema";
// Read at module load: imported from the subpath so tests that mock
// "@dokploy/server" wholesale can still load the router tree.
import { MCP_SCOPE_DESCRIPTIONS, MCP_SCOPES } from "@dokploy/server/mcp/config";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.enum(MCP_SCOPES);

const isAdmin = (role: string | undefined) =>
	role === "owner" || role === "admin";

const assertAdmin = (role: string | undefined) => {
	if (!isAdmin(role)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only organization owners and admins can manage AI integrations",
		});
	}
};

export const mcpRouter = createTRPCRouter({
	/** Data for the OAuth consent screen. */
	consentInfo: protectedProcedure
		.input(
			z.object({
				clientId: ID,
				requestedScopes: z.string().max(500).default(""),
			}),
		)
		.query(async ({ input, ctx }) => {
			const client = await findOAuthClient(input.clientId);
			if (!client || client.disabled) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Unknown or disabled client",
				});
			}
			const memberships = await db.query.member.findMany({
				where: eq(member.userId, ctx.user.id),
				with: { organization: { columns: { id: true, name: true } } },
				columns: { role: true },
			});
			const organizations = await Promise.all(
				memberships.map(async (m) => {
					const settings = await getMcpSettings(m.organization.id);
					return {
						organizationId: m.organization.id,
						name: m.organization.name,
						role: m.role,
						enabled: settings.enabled,
						allowedScopes: settings.allowedScopes,
					};
				}),
			);
			const requested = input.requestedScopes.split(" ").filter(isMcpScope);
			return {
				client: {
					clientId: client.clientId,
					name: client.name ?? "Unnamed client",
					uri: client.uri,
					redirectHosts: [
						...new Set(
							(client.redirectUris ?? []).map((u) => {
								try {
									return new URL(u).host;
								} catch {
									return u;
								}
							}),
						),
					],
				},
				requestedScopes: requested,
				scopeDescriptions: MCP_SCOPE_DESCRIPTIONS,
				organizations,
				activeOrganizationId: ctx.session.activeOrganizationId,
			};
		}),

	/** Stores the organization and scopes chosen on the consent screen. */
	recordGrant: protectedProcedure
		.input(
			z.object({
				clientId: ID,
				organizationId: ID,
				scopes: z.array(scopeSchema).min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const client = await findOAuthClient(input.clientId);
			if (!client || client.disabled) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Unknown or disabled client",
				});
			}
			if (!(await findMembership(ctx.user.id, input.organizationId))) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Not a member of this organization",
				});
			}
			const settings = await getMcpSettings(input.organizationId);
			if (!settings.enabled) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "AI integrations are disabled for this organization",
				});
			}
			const scopes = [...new Set(input.scopes)].filter((s) =>
				settings.allowedScopes.includes(s),
			);
			if (scopes.length === 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "No allowed scope selected",
				});
			}
			await upsertMcpGrant({
				userId: ctx.user.id,
				clientId: input.clientId,
				organizationId: input.organizationId,
				scopes,
			});
			await writeMcpAudit({
				principal: {
					userId: ctx.user.id,
					organizationId: input.organizationId,
					clientId: input.clientId,
					clientName: client.name ?? undefined,
				},
				kind: "auth",
				name: "consent",
				outcome: "ok",
				detail: `granted ${scopes.join(" ")}`,
			});
			return { scopes };
		}),

	getSettings: protectedProcedure.query(async ({ ctx }) => {
		const settings = await getMcpSettings(ctx.session.activeOrganizationId);
		const resources = getMcpResourceUrls();
		return {
			...settings,
			resourceUrls: resources,
			configured: resources.length > 0,
			canManage: isAdmin(ctx.user.role),
			scopeDescriptions: MCP_SCOPE_DESCRIPTIONS,
		};
	}),

	updateSettings: protectedProcedure
		.input(
			z.object({ enabled: z.boolean(), allowedScopes: z.array(scopeSchema) }),
		)
		.mutation(async ({ input, ctx }) => {
			assertAdmin(ctx.user.role);
			const result = await updateMcpSettings(
				ctx.session.activeOrganizationId,
				ctx.user.id,
				{
					enabled: input.enabled,
					allowedScopes: [...new Set(input.allowedScopes)],
				},
			);
			await writeMcpAudit({
				principal: {
					userId: ctx.user.id,
					organizationId: ctx.session.activeOrganizationId,
				},
				kind: "auth",
				name: "settings",
				outcome: "ok",
				detail: `enabled=${input.enabled} scopes=${input.allowedScopes.join(" ")}`,
			});
			return result;
		}),

	listGrants: protectedProcedure.query(async ({ ctx }) => {
		const grants = await listMcpGrants(
			ctx.session.activeOrganizationId,
			isAdmin(ctx.user.role) ? undefined : ctx.user.id,
		);
		return grants.map((g) => ({
			grantId: g.id,
			clientId: g.clientId,
			clientName: g.client?.name ?? g.clientId,
			clientUri: g.client?.uri ?? null,
			clientDisabled: g.client?.disabled ?? false,
			user: g.user
				? {
						id: g.user.id,
						email: g.user.email,
						name: `${g.user.firstName} ${g.user.lastName}`.trim(),
					}
				: null,
			scopes: g.scopes,
			createdAt: g.createdAt,
			lastUsedAt: g.lastUsedAt,
			isOwn: g.userId === ctx.user.id,
		}));
	}),

	revokeGrant: protectedProcedure
		.input(z.object({ clientId: ID, userId: ID.optional() }))
		.mutation(async ({ input, ctx }) => {
			const userId = input.userId ?? ctx.user.id;
			if (userId !== ctx.user.id) assertAdmin(ctx.user.role);
			const grant = await findMcpGrant(userId, input.clientId);
			if (!grant || grant.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Grant not found" });
			}
			await revokeMcpGrant(userId, input.clientId);
			await writeMcpAudit({
				principal: {
					userId: ctx.user.id,
					organizationId: ctx.session.activeOrganizationId,
					clientId: input.clientId,
				},
				kind: "auth",
				name: "revoke",
				outcome: "ok",
				detail:
					userId === ctx.user.id
						? "revoked own access"
						: `revoked access of ${userId}`,
			});
			return true;
		}),

	auditLog: protectedProcedure
		.input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
		.query(async ({ input, ctx }) =>
			listMcpAudit(ctx.session.activeOrganizationId, {
				limit: input.limit,
				userId: isAdmin(ctx.user.role) ? undefined : ctx.user.id,
			}),
		),

	/** Checks, from the server, what an MCP client will hit during discovery. */
	testConnection: protectedProcedure.mutation(async ({ ctx }) => {
		const checks: { name: string; ok: boolean; detail: string }[] = [];
		const resources = getMcpResourceUrls();
		const resource = resources[0];
		checks.push({
			name: "MCP URL configured",
			ok: !!resource,
			detail: resource ?? "DOKPLOY_MCP_RESOURCE_URL is not set",
		});
		const settings = await getMcpSettings(ctx.session.activeOrganizationId);
		checks.push({
			name: "Enabled for this organization",
			ok: settings.enabled,
			detail: settings.enabled
				? `scopes: ${settings.allowedScopes.join(", ")}`
				: "disabled",
		});
		if (resource) {
			const url = new URL(resource);
			const headers = new Headers({ host: url.host });
			const prm = handleProtectedResourceMetadata(
				new Request(
					`${url.origin}/.well-known/oauth-protected-resource${url.pathname}`,
					{ headers },
				),
			);
			checks.push({
				name: "Protected resource metadata (RFC 9728)",
				ok: prm.ok,
				detail: prm.ok
					? `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`
					: `HTTP ${prm.status}`,
			});
			try {
				const as = await handleAuthorizationServerMetadata(
					new Request(
						`${url.origin}/.well-known/oauth-authorization-server/api/auth`,
						{ headers },
					),
				);
				const body = (await as.json()) as {
					issuer?: string;
					code_challenge_methods_supported?: string[];
				};
				checks.push({
					name: "Authorization server metadata (RFC 8414)",
					ok: as.ok && !!body.issuer,
					detail: `issuer ${body.issuer ?? "missing"}, PKCE ${body.code_challenge_methods_supported?.join(",") ?? "?"}`,
				});
			} catch (error) {
				checks.push({
					name: "Authorization server metadata (RFC 8414)",
					ok: false,
					detail: error instanceof Error ? error.message : "failed",
				});
			}
		}
		return { ok: checks.every((c) => c.ok), checks };
	}),
});
