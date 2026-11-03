CREATE TABLE "domain_dns_record" (
	"domainId" text PRIMARY KEY NOT NULL,
	"dnsProviderId" text,
	"zoneId" text NOT NULL,
	"recordId" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_dns_record" ADD CONSTRAINT "domain_dns_record_domainId_domain_domainId_fk" FOREIGN KEY ("domainId") REFERENCES "public"."domain"("domainId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_dns_record" ADD CONSTRAINT "domain_dns_record_dnsProviderId_dns_provider_dnsProviderId_fk" FOREIGN KEY ("dnsProviderId") REFERENCES "public"."dns_provider"("dnsProviderId") ON DELETE set null ON UPDATE no action;