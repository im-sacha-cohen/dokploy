import { db } from "@dokploy/server/db";
import {
	mcpGrant,
	mcpSettings,
	member,
	oauthAccessToken,
	oauthClient,
	oauthConsent,
	oauthRefreshToken,
} from "@dokploy/server/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { DEFAULT_ALLOWED_SCOPES, MCP_SCOPES, type McpScope } from "./config";

export const isMcpScope = (scope: string): scope is McpScope =>
	(MCP_SCOPES as readonly string[]).includes(scope);

export const getMcpSettings = async (organizationId: string) => {
	const row = await db.query.mcpSettings.findFirst({
		where: eq(mcpSettings.organizationId, organizationId),
	});
	return {
		organizationId,
		enabled: row?.enabled ?? false,
		allowedScopes: (row?.allowedScopes ?? [...DEFAULT_ALLOWED_SCOPES]).filter(
			isMcpScope,
		),
		updatedAt: row?.updatedAt ?? null,
	};
};

export const updateMcpSettings = async (
	organizationId: string,
	userId: string,
	values: { enabled: boolean; allowedScopes: McpScope[] },
) => {
	await db
		.insert(mcpSettings)
		.values({ organizationId, updatedBy: userId, ...values })
		.onConflictDoUpdate({
			target: mcpSettings.organizationId,
			set: { ...values, updatedBy: userId, updatedAt: new Date() },
		});
	return getMcpSettings(organizationId);
};

export const findOAuthClient = (clientId: string) =>
	db.query.oauthClient.findFirst({
		where: eq(oauthClient.clientId, clientId),
		columns: {
			clientId: true,
			name: true,
			uri: true,
			icon: true,
			disabled: true,
			redirectUris: true,
			public: true,
			createdAt: true,
		},
	});

/**
 * Records which organization and which MCP scopes the user granted to a
 * client. Called from the consent page, before the OAuth consent itself.
 */
export const upsertMcpGrant = async (values: {
	userId: string;
	clientId: string;
	organizationId: string;
	scopes: McpScope[];
}) => {
	await db
		.insert(mcpGrant)
		.values(values)
		.onConflictDoUpdate({
			target: [mcpGrant.userId, mcpGrant.clientId],
			set: {
				organizationId: values.organizationId,
				scopes: values.scopes,
				createdAt: new Date(),
			},
		});
};

export const findMcpGrant = (userId: string, clientId: string) =>
	db.query.mcpGrant.findFirst({
		where: and(eq(mcpGrant.userId, userId), eq(mcpGrant.clientId, clientId)),
	});

export const touchMcpGrant = (grantId: string) =>
	db
		.update(mcpGrant)
		.set({ lastUsedAt: new Date() })
		.where(eq(mcpGrant.id, grantId));

export const listMcpGrants = async (organizationId: string, userId?: string) =>
	db.query.mcpGrant.findMany({
		where: userId
			? and(
					eq(mcpGrant.organizationId, organizationId),
					eq(mcpGrant.userId, userId),
				)
			: eq(mcpGrant.organizationId, organizationId),
		with: {
			client: {
				columns: { clientId: true, name: true, uri: true, disabled: true },
			},
			user: {
				columns: { id: true, email: true, firstName: true, lastName: true },
			},
		},
		orderBy: desc(mcpGrant.createdAt),
	});

/**
 * Revokes everything a client holds for a user: the MCP grant (checked on every
 * MCP request, so revocation is immediate), the OAuth consent and all refresh
 * and opaque access tokens. Already issued JWT access tokens are refused at the
 * MCP endpoint because the grant no longer exists.
 */
export const revokeMcpGrant = async (userId: string, clientId: string) => {
	await db.transaction(async (tx) => {
		await tx
			.delete(mcpGrant)
			.where(and(eq(mcpGrant.userId, userId), eq(mcpGrant.clientId, clientId)));
		await tx
			.delete(oauthConsent)
			.where(
				and(
					eq(oauthConsent.userId, userId),
					eq(oauthConsent.clientId, clientId),
				),
			);
		await tx
			.delete(oauthAccessToken)
			.where(
				and(
					eq(oauthAccessToken.userId, userId),
					eq(oauthAccessToken.clientId, clientId),
				),
			);
		await tx
			.delete(oauthRefreshToken)
			.where(
				and(
					eq(oauthRefreshToken.userId, userId),
					eq(oauthRefreshToken.clientId, clientId),
				),
			);
	});
};

export const findMembership = (userId: string, organizationId: string) =>
	db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, organizationId),
		),
		columns: { id: true, role: true },
	});
