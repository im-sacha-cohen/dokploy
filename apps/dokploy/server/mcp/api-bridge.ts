import { db } from "@dokploy/server/db";
import { member } from "@dokploy/server/db/schema";
import { isMcpApiPath, type McpApiPath } from "@dokploy/server/mcp/api-paths";
import type { McpActionDeps } from "@dokploy/server/mcp/tool-kit";
import { findServerById } from "@dokploy/server/services/server";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { quote } from "shell-quote";
import { appRouter } from "@/server/api/root";
import { canAccessDockerOverWss } from "@/server/wss/authorize";
import { containerBelongsToService } from "@/server/wss/container-ownership";
import { isValidContainerId } from "@/server/wss/utils";

type Principal = Parameters<McpActionDeps["callApi"]>[0];

const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The tRPC context of the principal's user, shaped like the one API keys get
 * in validateRequest: the procedures then run every permission check exactly
 * as they do for that user in the dashboard.
 */
const buildContext = async (principal: Principal) => {
	const membership = await db.query.member.findFirst({
		where: and(
			eq(member.userId, principal.userId),
			eq(member.organizationId, principal.organizationId),
		),
		with: { organization: true, user: true },
	});
	if (!membership) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are no longer a member of this organization",
		});
	}
	const user = membership.user as typeof membership.user & {
		firstName: string;
	};
	return {
		db,
		// No procedure on the MCP allowlist reads the HTTP request or response.
		req: { headers: {} },
		res: {},
		session: {
			userId: user.id,
			activeOrganizationId: principal.organizationId,
		},
		user: {
			id: user.id,
			name: user.firstName,
			email: user.email,
			emailVerified: user.emailVerified,
			image: user.image,
			createdAt: user.createdAt,
			updatedAt: user.updatedAt,
			twoFactorEnabled: user.twoFactorEnabled,
			role: membership.role as "owner" | "admin" | "member",
			ownerId: membership.organization.ownerId,
			enableEnterpriseFeatures: user.enableEnterpriseFeatures,
			isValidEnterpriseLicense: user.isValidEnterpriseLicense,
		},
	};
};

export const callApi: McpActionDeps["callApi"] = async (
	principal,
	path: McpApiPath,
	input,
) => {
	if (!isMcpApiPath(path)) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Not available" });
	}
	const [router, procedure] = path.split(".") as [string, string];
	// The context mirrors the API-key session built by validateRequest.
	const caller = appRouter.createCaller((await buildContext(principal)) as any);
	const call = (
		caller as unknown as Record<
			string,
			Record<string, (input?: unknown) => Promise<unknown>>
		>
	)[router]?.[procedure];
	if (!call) throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
	return call(input);
};

/** Same gates as the container terminal in the dashboard, plus a timeout. */
export const execInService: McpActionDeps["execInService"] = async (
	principal,
	{ serviceId, containerId, serverId, command, timeoutSeconds },
) => {
	if (!isValidContainerId(containerId)) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid container" });
	}
	const session = { activeOrganizationId: principal.organizationId };
	if (
		!(await canAccessDockerOverWss(
			{ id: principal.userId },
			session,
			serverId,
			serviceId,
		)) ||
		!(await containerBelongsToService(serviceId, containerId, serverId))
	) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
	}
	if (serverId) {
		const server = await findServerById(serverId);
		if (server.organizationId !== principal.organizationId) {
			throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
		}
	}

	// `timeout` stops the docker client; a process started inside the container
	// may outlive it if it ignores the hang-up.
	const shellCommand = quote([
		"timeout",
		"-k",
		"5",
		String(timeoutSeconds),
		"docker",
		"exec",
		containerId,
		"sh",
		"-c",
		command,
	]);
	try {
		const { stdout, stderr } = serverId
			? await execAsyncRemote(serverId, shellCommand)
			: await execAsync(shellCommand, { maxBuffer: EXEC_MAX_BUFFER });
		return { exitCode: 0, stdout, stderr };
	} catch (error) {
		if (error instanceof ExecError) {
			const exitCode = typeof error.exitCode === "number" ? error.exitCode : 1;
			return {
				exitCode,
				stdout: error.stdout ?? "",
				stderr:
					exitCode === 124
						? `${error.stderr ?? ""}\n[timed out after ${timeoutSeconds}s]`.trim()
						: (error.stderr ?? ""),
			};
		}
		throw error;
	}
};
