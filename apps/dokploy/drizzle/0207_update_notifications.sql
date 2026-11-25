-- Notification events for scheduled updates (this fork). Idempotent, like the
-- fork's other migrations.
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "dokployUpdate" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "appUpdate" boolean DEFAULT false NOT NULL;
