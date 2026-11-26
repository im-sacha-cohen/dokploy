-- Image reference an image application deployed (this fork), so the version
-- history can name it. Idempotent, like the fork's other migrations.
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "sourceImage" text;
