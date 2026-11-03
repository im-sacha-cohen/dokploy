import { isMcpApiPath } from "@dokploy/server/mcp/api-paths";
import { DEFAULT_ALLOWED_SCOPES, MCP_SCOPES } from "@dokploy/server/mcp/config";
import {
	requireConfirmation,
	verifyConfirmationState,
} from "@dokploy/server/mcp/confirm";
import type { ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

const principal = {
	userId: "user-1",
	organizationId: "org-1",
	clientId: "client-1",
	clientName: "Test client",
	grantId: "grant-1",
	scopes: ["mcp:exec"],
};

const MODERN_ENVELOPE = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
};

const context = ({
	envelope = MODERN_ENVELOPE as Record<string, unknown> | undefined,
	inputResponses = undefined as Record<string, unknown> | undefined,
	state = undefined as unknown,
} = {}) =>
	({
		mcpReq: { envelope, inputResponses, requestState: () => state },
	}) as unknown as ServerContext;

const args = { serviceType: "postgres", serviceId: "db-1", command: "ls" };
const accept = { confirm: { action: "accept", content: { confirm: true } } };

/** Runs the first round and returns the verified state the client would echo. */
const firstRound = async () => {
	const outcome = await requireConfirmation(
		context(),
		principal,
		"dokploy_exec_command",
		args,
		"Run ls?",
	);
	if (outcome.status !== "pending") throw new Error(outcome.status);
	const wire = outcome.result.requestState as string;
	return { outcome, state: await verifyConfirmationState(wire, context()) };
};

describe("MCP human confirmation", () => {
	it("asks first, with the question and a sealed state", async () => {
		const { outcome } = await firstRound();
		expect(outcome.result.resultType).toBe("input_required");
		expect(
			(outcome.result.inputRequests?.confirm as { params: { message: string } })
				.params.message,
		).toBe("Run ls?");
	});

	it("refuses clients that cannot show a confirmation", async () => {
		// A 2025-era request carries no protocol version in its envelope.
		for (const envelope of [
			{},
			{ "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
		]) {
			const outcome = await requireConfirmation(
				context({ envelope }),
				principal,
				"dokploy_exec_command",
				args,
				"Run ls?",
			);
			expect(outcome.status).toBe("unsupported");
		}
	});

	it("approves only the same call with an accepted answer", async () => {
		const { state } = await firstRound();
		const approved = await requireConfirmation(
			context({ state, inputResponses: accept }),
			principal,
			"dokploy_exec_command",
			args,
			"Run ls?",
		);
		expect(approved.status).toBe("approved");

		const otherArgs = await requireConfirmation(
			context({ state, inputResponses: accept }),
			principal,
			"dokploy_exec_command",
			{ ...args, command: "rm -rf /data" },
			"Run rm?",
		);
		expect(otherArgs.status).toBe("pending");

		const otherClient = await requireConfirmation(
			context({ state, inputResponses: accept }),
			{ ...principal, clientId: "client-2" },
			"dokploy_exec_command",
			args,
			"Run ls?",
		);
		expect(otherClient.status).toBe("pending");

		const noState = await requireConfirmation(
			context({ inputResponses: accept }),
			principal,
			"dokploy_exec_command",
			args,
			"Run ls?",
		);
		expect(noState.status).toBe("pending");
	});

	it("treats a declined answer as a refusal", async () => {
		const { state } = await firstRound();
		const outcome = await requireConfirmation(
			context({ state, inputResponses: { confirm: { action: "decline" } } }),
			principal,
			"dokploy_exec_command",
			args,
			"Run ls?",
		);
		expect(outcome.status).toBe("declined");
	});

	it("rejects a tampered state", async () => {
		const { outcome } = await firstRound();
		const wire = outcome.result.requestState as string;
		await expect(
			verifyConfirmationState(`${wire.slice(0, -4)}AAAA`, context()),
		).rejects.toThrow();
	});
});

describe("MCP scopes and API allowlist", () => {
	it("keeps the broad scopes opt-in", () => {
		expect(DEFAULT_ALLOWED_SCOPES).toEqual([
			"mcp:read",
			"mcp:deploy",
			"mcp:config",
		]);
		expect(MCP_SCOPES).toEqual(
			expect.arrayContaining(["mcp:env", "mcp:manage", "mcp:exec"]),
		);
	});

	it("only exposes allowlisted procedures", () => {
		expect(isMcpApiPath("application.deploy")).toBe(true);
		expect(isMcpApiPath("settings.cleanAll")).toBe(false);
		expect(isMcpApiPath("user.remove")).toBe(false);
		expect(isMcpApiPath("docker.removeContainer")).toBe(false);
	});
});
