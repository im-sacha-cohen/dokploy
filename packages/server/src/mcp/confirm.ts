import { createHash, createHmac } from "node:crypto";
import {
	acceptedContent,
	type CallToolResult,
	CLIENT_CAPABILITIES_META_KEY,
	createRequestStateCodec,
	type InputRequiredResult,
	inputRequired,
	inputResponse,
	PROTOCOL_VERSION_META_KEY,
	type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { betterAuthSecret } from "../lib/auth-secret";
import type { McpPrincipal } from "./token";

const CONFIRMATION_TTL_SECONDS = 5 * 60;
const CONFIRM_KEY = "confirm";

const confirmationSchema = z.object({
	confirm: z.boolean().describe("Approve this action"),
});

/** What a confirmation approves: one tool call, by one client, for one user. */
interface PendingConfirmation {
	tool: string;
	argsDigest: string;
	userId: string;
	clientId: string;
	grantId: string;
}

// The state round-trips through the client: it is HMAC-sealed and expires, so
// a client cannot forge an approval or reuse it for other arguments.
const codec = createRequestStateCodec<PendingConfirmation>({
	key: createHmac("sha256", betterAuthSecret)
		.update("dokploy-mcp-confirmation")
		.digest(),
	ttlSeconds: CONFIRMATION_TTL_SECONDS,
});

export const verifyConfirmationState = codec.verify;

const stableStringify = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

const digest = (args: unknown) =>
	createHash("sha256").update(stableStringify(args)).digest("base64url");

const sameConfirmation = (a: unknown, b: PendingConfirmation) =>
	!!a &&
	typeof a === "object" &&
	(Object.keys(b) as (keyof PendingConfirmation)[]).every(
		(key) => (a as Record<string, unknown>)[key] === b[key],
	);

/** Whether the client can show a confirmation form to its user. */
const canElicit = (ctx: ServerContext) => {
	const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
	// Stateless 2025-era requests cannot carry server-to-client requests.
	if (!envelope?.[PROTOCOL_VERSION_META_KEY]) return false;
	const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY] as
		| { elicitation?: unknown }
		| undefined;
	return !!capabilities?.elicitation;
};

export type ConfirmationOutcome =
	| { status: "approved" }
	| { status: "pending"; result: InputRequiredResult }
	| { status: "declined" | "unsupported"; result: CallToolResult };

/**
 * Human-in-the-loop gate for destructive tools and commands. The first call
 * asks the client to show `message` to its user; the retried call carries the
 * answer plus the sealed state, which must match this exact call.
 */
export const requireConfirmation = async (
	ctx: ServerContext,
	principal: McpPrincipal,
	tool: string,
	args: unknown,
	message: string,
): Promise<ConfirmationOutcome> => {
	if (!canElicit(ctx)) {
		return {
			status: "unsupported",
			result: {
				content: [
					{
						type: "text",
						text: `${tool} needs a human confirmation, and this MCP client does not support confirmation requests (elicitation, protocol 2026-07-28). Run this action from the Dokploy dashboard instead.`,
					},
				],
				isError: true,
			},
		};
	}

	const expected: PendingConfirmation = {
		tool,
		argsDigest: digest(args),
		userId: principal.userId,
		clientId: principal.clientId,
		grantId: principal.grantId,
	};
	const state = ctx.mcpReq.requestState<PendingConfirmation>();
	if (sameConfirmation(state, expected)) {
		const answer = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY);
		const content = acceptedContent(
			ctx.mcpReq.inputResponses,
			CONFIRM_KEY,
			confirmationSchema,
		);
		if (content?.confirm === true) return { status: "approved" };
		if (answer.kind === "elicit") {
			return {
				status: "declined",
				result: {
					content: [
						{ type: "text", text: "Cancelled: the user did not confirm." },
					],
					isError: true,
				},
			};
		}
	}

	return {
		status: "pending",
		result: inputRequired({
			inputRequests: {
				[CONFIRM_KEY]: inputRequired.elicit({
					message,
					requestedSchema: confirmationSchema,
				}),
			},
			requestState: await codec.mint(expected),
		}),
	};
};
