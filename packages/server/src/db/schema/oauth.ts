import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	json,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { session } from "./session";
import { user } from "./user";

// Tables owned by better-auth's `jwt` and `@better-auth/oauth-provider`
// plugins. Export names and property names must match the plugin models, the
// drizzle adapter resolves them by name.

export const jwks = pgTable("jwks", {
	id: text("id").primaryKey(),
	publicKey: text("public_key").notNull(),
	privateKey: text("private_key").notNull(),
	createdAt: timestamp("created_at").notNull(),
	expiresAt: timestamp("expires_at"),
});

export const oauthClient = pgTable(
	"oauth_client",
	{
		id: text("id").primaryKey(),
		clientId: text("client_id").notNull().unique(),
		clientSecret: text("client_secret"),
		disabled: boolean("disabled").default(false),
		skipConsent: boolean("skip_consent"),
		enableEndSession: boolean("enable_end_session"),
		subjectType: text("subject_type"),
		scopes: text("scopes").array(),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at"),
		updatedAt: timestamp("updated_at"),
		name: text("name"),
		uri: text("uri"),
		icon: text("icon"),
		contacts: text("contacts").array(),
		tos: text("tos"),
		policy: text("policy"),
		softwareId: text("software_id"),
		softwareVersion: text("software_version"),
		softwareStatement: text("software_statement"),
		redirectUris: text("redirect_uris").array().notNull(),
		postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
		tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
		grantTypes: text("grant_types").array(),
		responseTypes: text("response_types").array(),
		public: boolean("public"),
		type: text("type"),
		requirePKCE: boolean("require_pkce"),
		referenceId: text("reference_id"),
		metadata: json("metadata"),
	},
	(table) => [index("oauth_client_user_id_idx").on(table.userId)],
);

export const oauthRefreshToken = pgTable(
	"oauth_refresh_token",
	{
		id: text("id").primaryKey(),
		token: text("token").notNull().unique(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		sessionId: text("session_id").references(() => session.id, {
			onDelete: "set null",
		}),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		referenceId: text("reference_id"),
		expiresAt: timestamp("expires_at"),
		createdAt: timestamp("created_at"),
		revoked: timestamp("revoked"),
		authTime: timestamp("auth_time"),
		scopes: text("scopes").array().notNull(),
	},
	(table) => [
		index("oauth_refresh_token_client_id_idx").on(table.clientId),
		index("oauth_refresh_token_user_id_idx").on(table.userId),
	],
);

export const oauthAccessToken = pgTable(
	"oauth_access_token",
	{
		id: text("id").primaryKey(),
		token: text("token").unique(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		sessionId: text("session_id").references(() => session.id, {
			onDelete: "set null",
		}),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		referenceId: text("reference_id"),
		refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
			onDelete: "cascade",
		}),
		expiresAt: timestamp("expires_at"),
		createdAt: timestamp("created_at"),
		scopes: text("scopes").array().notNull(),
	},
	(table) => [
		index("oauth_access_token_client_id_idx").on(table.clientId),
		index("oauth_access_token_user_id_idx").on(table.userId),
	],
);

export const oauthConsent = pgTable(
	"oauth_consent",
	{
		id: text("id").primaryKey(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		referenceId: text("reference_id"),
		scopes: text("scopes").array().notNull(),
		createdAt: timestamp("created_at"),
		updatedAt: timestamp("updated_at"),
	},
	(table) => [
		index("oauth_consent_client_id_idx").on(table.clientId),
		index("oauth_consent_user_id_idx").on(table.userId),
	],
);

// Dokploy-side MCP state: which organization and which scopes a user granted
// to a client, organization-level settings, and the MCP audit trail.

export const mcpSettings = pgTable("mcp_settings", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	enabled: boolean("enabled").notNull().default(false),
	allowedScopes: text("allowed_scopes").array().notNull(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
	updatedBy: text("updated_by").references(() => user.id, {
		onDelete: "set null",
	}),
});

export const mcpGrant = pgTable(
	"mcp_grant",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		scopes: text("scopes").array().notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		lastUsedAt: timestamp("last_used_at"),
	},
	(table) => [
		uniqueIndex("mcp_grant_user_client_idx").on(table.userId, table.clientId),
	],
);

export const mcpAuditLog = pgTable(
	"mcp_audit_log",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		organizationId: text("organization_id"),
		userId: text("user_id"),
		clientId: text("client_id"),
		clientName: text("client_name"),
		kind: text("kind").notNull().$type<"tool" | "resource" | "auth">(),
		name: text("name").notNull(),
		outcome: text("outcome")
			.notNull()
			.$type<"ok" | "denied" | "error" | "rate_limited" | "invalid">(),
		detail: text("detail"),
		targetId: text("target_id"),
		arguments: json("arguments").$type<Record<string, unknown>>(),
		durationMs: integer("duration_ms"),
	},
	(table) => [
		index("mcp_audit_log_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
	],
);

export const mcpGrantRelations = relations(mcpGrant, ({ one }) => ({
	client: one(oauthClient, {
		fields: [mcpGrant.clientId],
		references: [oauthClient.clientId],
	}),
	user: one(user, { fields: [mcpGrant.userId], references: [user.id] }),
}));
