-- Scheduled update rules and their history (this fork). Idempotent, like the
-- fork's other migrations, in case upstream renumbering makes it run twice.
DO $$ BEGIN
	CREATE TYPE "public"."updateMode" AS ENUM('notify', 'auto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."updateRunKind" AS ENUM('update', 'rollback');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."updateRunStatus" AS ENUM('skipped', 'notified', 'backing_up', 'updating', 'verifying', 'restoring', 'succeeded', 'rolled_back', 'aborted', 'failed', 'interrupted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."updateTargetType" AS ENUM('dokploy', 'application');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."updateVersionRule" AS ENUM('digest', 'patch', 'minor', 'major');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "update_policy" (
	"updatePolicyId" text PRIMARY KEY NOT NULL,
	"targetType" "updateTargetType" NOT NULL,
	"applicationId" text,
	"organizationId" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" "updateMode" DEFAULT 'notify' NOT NULL,
	"versionRule" "updateVersionRule" DEFAULT 'digest' NOT NULL,
	"minAgeHours" integer DEFAULT 72 NOT NULL,
	"windowDays" integer[] NOT NULL,
	"windowStart" text NOT NULL,
	"windowDurationMinutes" integer DEFAULT 120 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"verifyMinutes" integer DEFAULT 5 NOT NULL,
	"backupIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "update_policy_target" CHECK (("targetType" = 'dokploy') = ("applicationId" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "update_run" (
	"updateRunId" text PRIMARY KEY NOT NULL,
	"updatePolicyId" text,
	"targetType" "updateTargetType" NOT NULL,
	"applicationId" text,
	"kind" "updateRunKind" DEFAULT 'update' NOT NULL,
	"status" "updateRunStatus" NOT NULL,
	"fromImage" text,
	"toImage" text,
	"reason" text,
	"updaterRunId" text,
	"startedAt" text NOT NULL,
	"finishedAt" text
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "update_policy" ADD CONSTRAINT "update_policy_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "update_policy" ADD CONSTRAINT "update_policy_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "update_run" ADD CONSTRAINT "update_run_updatePolicyId_update_policy_updatePolicyId_fk" FOREIGN KEY ("updatePolicyId") REFERENCES "public"."update_policy"("updatePolicyId") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "update_run" ADD CONSTRAINT "update_run_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "update_policy_dokploy_unique" ON "update_policy" USING btree ("targetType") WHERE "targetType" = 'dokploy';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "update_policy_application_unique" ON "update_policy" USING btree ("applicationId");
