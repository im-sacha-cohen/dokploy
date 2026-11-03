import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { findApplicationById } from "../services/application";
import type { McpApiPath } from "./api-paths";
import type { McpScope } from "./config";
import type { McpPrincipal } from "./token";

type Application = Awaited<ReturnType<typeof findApplicationById>>;

/**
 * What lives in the Next app (deployment queue, tRPC router, container
 * terminal checks) is injected here.
 */
export interface McpActionDeps {
	enqueue: (
		application: Application,
		job:
			| { type: "deploy"; titleLog: string }
			| { type: "redeploy"; titleLog: string }
			| { type: "redeploy-version"; sourceDeploymentId: string },
	) => Promise<void>;
	/** Calls a whitelisted Dokploy API procedure as the principal's user. */
	callApi: (
		principal: McpPrincipal,
		path: McpApiPath,
		input?: unknown,
	) => Promise<unknown>;
	/** Runs a command in a container of a service, after the same checks as the web terminal. */
	execInService: (
		principal: McpPrincipal,
		request: {
			serviceId: string;
			containerId: string;
			serverId: string | null;
			command: string;
			timeoutSeconds: number;
		},
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export class ToolError extends Error {}

export interface ToolConfig<S extends z.ZodObject> {
	title: string;
	description: string;
	input: S;
	mutation?: boolean;
	destructive?: boolean;
	/**
	 * When set, a human must approve the call; returns the question shown. May
	 * throw a ToolError to refuse before asking.
	 */
	confirm?: (args: z.infer<S>) => string | Promise<string>;
}

export type RegisterTool = <S extends z.ZodObject>(
	name: string,
	scope: McpScope,
	config: ToolConfig<S>,
	handler: (args: z.infer<S>) => Promise<CallToolResult>,
) => void;

export const ID = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid identifier");

export const json = (value: unknown): CallToolResult => ({
	content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	structuredContent: value as Record<string, unknown>,
});

export const plainError = (message: string): CallToolResult => ({
	content: [{ type: "text", text: message }],
	isError: true,
});
