import {
	type AuthInfo,
	OAuthError,
	OAuthErrorCode,
	type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { auth } from "../lib/auth";
import { getMcpIssuer, type McpScope } from "./config";
import {
	findMcpGrant,
	findMembership,
	findOAuthClient,
	getMcpSettings,
	isMcpScope,
} from "./grants";

export interface McpPrincipal {
	userId: string;
	organizationId: string;
	clientId: string;
	clientName: string;
	grantId: string;
	scopes: McpScope[];
}

type JwksSource = Extract<
	Parameters<typeof verifyJwsAccessToken>[1]["jwksFetch"],
	() => unknown
>;

const jwksCacheKey = {};
const localJwks: JwksSource = async () =>
	(await auth.getJwks()) as Awaited<ReturnType<JwksSource>>;

const invalid = (message: string) =>
	new OAuthError(OAuthErrorCode.InvalidToken, message);

/**
 * Resource-server side token validation. Beyond the JWT checks (signature,
 * issuer, audience, expiry), every request re-checks server-side state so a
 * revocation takes effect immediately: the client must still be enabled, the
 * user's grant must still exist, MCP must be enabled for the organization and
 * the user must still be a member. Effective scopes are the intersection of
 * the token, the grant and the organization settings.
 */
export const createMcpTokenVerifier = (
	resourceUrl: string,
): OAuthTokenVerifier => ({
	async verifyAccessToken(token: string): Promise<AuthInfo> {
		let payload: Record<string, unknown>;
		try {
			payload = await verifyJwsAccessToken(token, {
				jwksFetch: localJwks,
				jwksCacheKey,
				verifyOptions: {
					audience: resourceUrl,
					issuer: getMcpIssuer(resourceUrl),
				},
			});
		} catch {
			throw invalid("Invalid, expired or wrong-audience access token");
		}

		const userId = typeof payload.sub === "string" ? payload.sub : null;
		const clientId = typeof payload.azp === "string" ? payload.azp : null;
		const exp = typeof payload.exp === "number" ? payload.exp : null;
		if (!userId || !clientId || !exp) throw invalid("Malformed access token");

		const client = await findOAuthClient(clientId);
		if (!client || client.disabled) throw invalid("Client unknown or disabled");

		const grant = await findMcpGrant(userId, clientId);
		if (!grant) throw invalid("Access revoked");

		const settings = await getMcpSettings(grant.organizationId);
		if (!settings.enabled)
			throw invalid("MCP is disabled for this organization");

		if (!(await findMembership(userId, grant.organizationId))) {
			throw invalid("User is no longer a member of the organization");
		}

		const tokenScopes = String(payload.scope ?? "")
			.split(" ")
			.filter(isMcpScope);
		const scopes = tokenScopes.filter(
			(s) => grant.scopes.includes(s) && settings.allowedScopes.includes(s),
		);

		const principal: McpPrincipal = {
			userId,
			organizationId: grant.organizationId,
			clientId,
			clientName: client.name ?? clientId,
			grantId: grant.id,
			scopes,
		};
		return {
			token,
			clientId,
			scopes,
			expiresAt: exp,
			resource: new URL(resourceUrl),
			extra: { principal },
		};
	},
});

export const principalOf = (authInfo?: AuthInfo): McpPrincipal => {
	const principal = authInfo?.extra?.principal as McpPrincipal | undefined;
	if (!principal) throw invalid("Missing authentication");
	return principal;
};
