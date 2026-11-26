import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import {
	ACCESS_TOKEN_TTL_SECONDS,
	getMcpIssuer,
	getMcpResourceUrls,
	OAUTH_SCOPES,
	REFRESH_TOKEN_TTL_SECONDS,
} from "./config";

/**
 * The OAuth server behind /mcp, only when its public URL is configured.
 * Without one, oauthProvider's per-request issuer check parses an empty base
 * URL and every auth call fails with "Invalid URL" (fork installed without a
 * domain), while /mcp answers 503 anyway.
 */
export const mcpOAuthPlugins = () => {
	const resources = getMcpResourceUrls();
	const resource = resources[0];
	if (!resource) return [];
	return [
		jwt({
			disableSettingJwtHeader: true,
			jwt: { issuer: getMcpIssuer(resource) },
		}),
		oauthProvider({
			loginPage: "/",
			consentPage: "/oauth/consent",
			scopes: [...OAUTH_SCOPES],
			validAudiences: resources,
			// No client_credentials: every MCP token must belong to a user.
			grantTypes: ["authorization_code", "refresh_token"],
			accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
			refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
			// MCP clients register themselves (RFC 7591) before any user is known.
			allowDynamicClientRegistration: true,
			allowUnauthenticatedClientRegistration: true,
			clientRegistrationDefaultScopes: ["mcp:read"],
			clientRegistrationAllowedScopes: [...OAUTH_SCOPES],
			silenceWarnings: { oauthAuthServerConfig: true },
		}),
	];
};
