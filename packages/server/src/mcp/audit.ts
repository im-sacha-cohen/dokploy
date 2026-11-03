import { db } from "@dokploy/server/db";
import { mcpAuditLog } from "@dokploy/server/db/schema";
import { and, desc, eq, lt } from "drizzle-orm";
import { createRedactor } from "../smart-deploy/diagnostics/redact";
import type { McpPrincipal } from "./token";

const redact = createRedactor();
const MAX_ARG_LENGTH = 200;

/** Keeps identifiers and small scalars; strips control characters and secrets. */
export const sanitizeArguments = (args: unknown): Record<string, unknown> => {
	if (!args || typeof args !== "object") return {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args).slice(0, 20)) {
		if (typeof value === "string")
			out[key] = redact(value).slice(0, MAX_ARG_LENGTH);
		else if (typeof value === "number" || typeof value === "boolean")
			out[key] = value;
		else if (Array.isArray(value)) out[key] = `[${value.length} items]`;
		else if (value !== null && value !== undefined) out[key] = "[object]";
	}
	return out;
};

export interface AuditEntry {
	principal?: Partial<McpPrincipal>;
	kind: "tool" | "resource" | "auth";
	name: string;
	outcome:
		| "ok"
		| "denied"
		| "error"
		| "rate_limited"
		| "invalid"
		| "confirmation_requested"
		| "declined";
	detail?: string;
	targetId?: string;
	arguments?: unknown;
	durationMs?: number;
}

/** Never throws: an audit failure must not change the MCP response. */
export const writeMcpAudit = async (entry: AuditEntry) => {
	try {
		await db.insert(mcpAuditLog).values({
			organizationId: entry.principal?.organizationId ?? null,
			userId: entry.principal?.userId ?? null,
			clientId: entry.principal?.clientId ?? null,
			clientName: entry.principal?.clientName?.slice(0, 120) ?? null,
			kind: entry.kind,
			name: entry.name.slice(0, 100),
			outcome: entry.outcome,
			detail: entry.detail ? redact(entry.detail).slice(0, 500) : null,
			targetId: entry.targetId?.slice(0, 100) ?? null,
			arguments: sanitizeArguments(entry.arguments),
			durationMs: entry.durationMs ?? null,
		});
	} catch (error) {
		console.error("[mcp] audit write failed:", error);
	}
};

export const listMcpAudit = (
	organizationId: string,
	options: { limit?: number; before?: Date; userId?: string } = {},
) =>
	db.query.mcpAuditLog.findMany({
		where: and(
			eq(mcpAuditLog.organizationId, organizationId),
			options.userId ? eq(mcpAuditLog.userId, options.userId) : undefined,
			options.before ? lt(mcpAuditLog.createdAt, options.before) : undefined,
		),
		orderBy: desc(mcpAuditLog.createdAt),
		limit: Math.min(options.limit ?? 50, 200),
	});
