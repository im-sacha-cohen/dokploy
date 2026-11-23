-- Cloudflare Tunnel routes created with a domain's DNS record (this fork).
ALTER TABLE "domain_dns_record" ADD COLUMN IF NOT EXISTS "tunnelAccountId" text;
--> statement-breakpoint
ALTER TABLE "domain_dns_record" ADD COLUMN IF NOT EXISTS "tunnelId" text;
--> statement-breakpoint
ALTER TABLE "domain_dns_record" ADD COLUMN IF NOT EXISTS "tunnelService" text;
