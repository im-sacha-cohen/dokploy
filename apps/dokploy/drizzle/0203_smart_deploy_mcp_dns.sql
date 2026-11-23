-- Smart Deploy version tracking, MCP OAuth and DNS records (this fork).
-- First shipped as 0199-0201 before upstream used those numbers; renumbered
-- after upstream v0.31.4 and made idempotent, because servers that ran the old
-- numbering already have these objects and will run this file again.
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "kind" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "sourceDeploymentId" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "sourceRepository" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "sourceBranch" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "requestedCommitSha" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "fetchedCommitSha" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "builtCommitSha" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "imageId" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "imageTag" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "imageDigest" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "runningImageId" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "containerId" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "taskId" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "verificationStatus" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "verification" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"organization_id" text,
	"user_id" text,
	"client_id" text,
	"client_name" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"target_id" text,
	"arguments" json,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"allowed_scopes" text[] NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"refresh_id" text,
	"expires_at" timestamp,
	"created_at" timestamp,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"user_id" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"token_endpoint_auth_method" text,
	"grant_types" text[],
	"response_types" text[],
	"public" boolean,
	"type" text,
	"require_pkce" boolean,
	"reference_id" text,
	"metadata" json,
	CONSTRAINT "oauth_client_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"scopes" text[] NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"expires_at" timestamp,
	"created_at" timestamp,
	"revoked" timestamp,
	"auth_time" timestamp,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_grant" ADD CONSTRAINT "mcp_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_grant" ADD CONSTRAINT "mcp_grant_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_grant" ADD CONSTRAINT "mcp_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_settings" ADD CONSTRAINT "mcp_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_settings" ADD CONSTRAINT "mcp_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_token"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_audit_log_org_created_idx" ON "mcp_audit_log" USING btree ("organization_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_grant_user_client_idx" ON "mcp_grant" USING btree ("user_id","client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_client_id_idx" ON "oauth_access_token" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_user_id_idx" ON "oauth_access_token" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_user_id_idx" ON "oauth_client" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_consent_client_id_idx" ON "oauth_consent" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_consent_user_id_idx" ON "oauth_consent" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_client_id_idx" ON "oauth_refresh_token" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_user_id_idx" ON "oauth_refresh_token" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain_dns_record" (
	"domainId" text PRIMARY KEY NOT NULL,
	"dnsProviderId" text,
	"zoneId" text NOT NULL,
	"recordId" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain_dns_record" ADD CONSTRAINT "domain_dns_record_domainId_domain_domainId_fk" FOREIGN KEY ("domainId") REFERENCES "public"."domain"("domainId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain_dns_record" ADD CONSTRAINT "domain_dns_record_dnsProviderId_dns_provider_dnsProviderId_fk" FOREIGN KEY ("dnsProviderId") REFERENCES "public"."dns_provider"("dnsProviderId") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
