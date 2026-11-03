import { relations } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { dnsProvider } from "./dns-provider";
import { domains } from "./domain";

/**
 * DNS record created by Dokploy for a domain (domain form or MCP). Only records
 * Dokploy created are stored, so only they are offered for deletion.
 */
export const domainDnsRecord = pgTable("domain_dns_record", {
	domainId: text("domainId")
		.primaryKey()
		.references(() => domains.domainId, { onDelete: "cascade" }),
	dnsProviderId: text("dnsProviderId").references(
		() => dnsProvider.dnsProviderId,
		{ onDelete: "set null" },
	),
	zoneId: text("zoneId").notNull(),
	recordId: text("recordId").notNull(),
	name: text("name").notNull(),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const domainDnsRecordRelations = relations(
	domainDnsRecord,
	({ one }) => ({
		domain: one(domains, {
			fields: [domainDnsRecord.domainId],
			references: [domains.domainId],
		}),
	}),
);
