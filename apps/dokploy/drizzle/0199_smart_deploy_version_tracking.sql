ALTER TABLE "deployment" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "sourceDeploymentId" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "sourceRepository" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "sourceBranch" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "requestedCommitSha" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "fetchedCommitSha" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "builtCommitSha" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "imageId" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "imageTag" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "imageDigest" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "runningImageId" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "containerId" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "taskId" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "verificationStatus" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "verification" jsonb;