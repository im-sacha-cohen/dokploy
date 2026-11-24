-- Images and compose file kept per compose deployment, for rollbacks (this fork).
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "composeImages" jsonb;
