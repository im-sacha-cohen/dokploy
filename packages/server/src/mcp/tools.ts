import path from "node:path";
import {
	McpServer,
	ResourceTemplate,
	requireScopes,
	type ServerContext,
} from "@modelcontextprotocol/server";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { paths } from "../constants";
import { db } from "../db";
import { projects, server as serverTable } from "../db/schema";
import {
	findApplicationById,
	updateApplication,
} from "../services/application";
import { findComposeById } from "../services/compose";
import {
	findAllDeploymentsByComposeId,
	findDeploymentById,
} from "../services/deployment";
import { findDomainById, updateDomainById } from "../services/domain";
import {
	checkPermission,
	checkServiceAccess,
	checkServicePermissionAndAccess,
	findMemberByUserId,
	type PermissionCtx,
} from "../services/permission";
import { getAccessibleServerIds } from "../services/server";
import { applyDomainPortFix } from "../smart-deploy/actions/fixes";
import { buildTimeline } from "../smart-deploy/actions/timeline";
import { diagnoseApplication } from "../smart-deploy/diagnostics";
import {
	createRedactor,
	redactLines,
} from "../smart-deploy/diagnostics/redact";
import {
	assertRedeployable,
	restartApplicationService,
} from "../smart-deploy/versioning/actions";
import { getRemoteHead } from "../smart-deploy/versioning/remote-head";
import { runOn } from "../smart-deploy/versioning/shell";
import { describeSource } from "../smart-deploy/versioning/source";
import { getVersionStatus } from "../smart-deploy/versioning/status";
import { getEnvironmentVariablesObject } from "../utils/docker/utils";
import { manageDomain } from "../utils/traefik/domain";
import { type AuditEntry, writeMcpAudit } from "./audit";
import { requireConfirmation, verifyConfirmationState } from "./confirm";
import { registerMonitoringTools } from "./monitoring-tools";
import { registerPlatformTools } from "./platform-tools";
import { mutationLimiter } from "./rate-limit";
import type { McpPrincipal } from "./token";
import {
	ID,
	json,
	type McpActionDeps,
	plainError,
	type RegisterTool,
	ToolError,
} from "./tool-kit";

const HOSTNAME =
	/^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
// Dokploy log names contain ":" (timestamps); the path is single-quoted in shell.
const SAFE_LOG_PATH = /^[A-Za-z0-9_.:/-]+$/;

export const createDokployMcpServer = (
	principal: McpPrincipal,
	deps: McpActionDeps,
) => {
	const server = new McpServer(
		{ name: "dokploy", version: "1.0.0" },
		{
			capabilities: { tools: {}, resources: {} },
			requestState: { verify: verifyConfirmationState },
		},
	);
	const ctx: PermissionCtx = {
		user: { id: principal.userId },
		session: { activeOrganizationId: principal.organizationId },
	};
	const redact = createRedactor();

	/** Access check + organization isolation for one application. */
	const loadApplication = async (
		applicationId: string,
		permissions?: Parameters<typeof checkServicePermissionAndAccess>[2],
	) => {
		try {
			if (permissions)
				await checkServicePermissionAndAccess(ctx, applicationId, permissions);
			else await checkServiceAccess(ctx, applicationId, "read");
			const application = await findApplicationById(applicationId);
			if (
				application.environment.project.organizationId !==
				principal.organizationId
			) {
				throw new ToolError("Application not found");
			}
			return application;
		} catch (error) {
			if (error instanceof ToolError) throw error;
			// Same answer for "missing" and "forbidden": no existence oracle.
			throw new ToolError("Application not found or access denied");
		}
	};

	const loadDeployment = async (deploymentId: string) => {
		const deployment = await findDeploymentById(deploymentId).catch(() => null);
		if (!deployment?.applicationId) {
			throw new ToolError("Deployment not found or access denied");
		}
		const application = await loadApplication(deployment.applicationId, {
			deployment: ["read"],
		});
		return { deployment, application };
	};

	/** A deployment of an application or a compose stack, with what its logs need. */
	const loadAnyDeployment = async (deploymentId: string) => {
		const deployment = await findDeploymentById(deploymentId).catch(() => null);
		if (deployment?.applicationId) {
			const { application } = await loadDeployment(deploymentId);
			return {
				deployment,
				serverId:
					deployment.buildServerId ||
					deployment.serverId ||
					application.serverId,
				env: [
					application.env,
					application.environment.project.env,
					application.environment.env,
				] as const,
			};
		}
		if (!deployment?.composeId) {
			throw new ToolError("Deployment not found or access denied");
		}
		const compose = await loadCompose(deployment.composeId);
		return {
			deployment,
			serverId: deployment.serverId || compose.serverId,
			env: [
				compose.env,
				compose.environment.project.env,
				compose.environment.env,
			] as const,
		};
	};

	const loadCompose = async (composeId: string) => {
		try {
			await checkServicePermissionAndAccess(ctx, composeId, {
				deployment: ["read"],
			});
			const compose = await findComposeById(composeId);
			if (
				compose.environment.project.organizationId !== principal.organizationId
			) {
				throw new ToolError("Compose not found");
			}
			return compose;
		} catch {
			throw new ToolError("Compose not found or access denied");
		}
	};

	const tool: RegisterTool = (name, scope, config, handler) => {
		server.registerTool(
			name,
			{
				title: config.title,
				description: `${config.description} Requires scope ${scope}.`,
				inputSchema: config.input,
				annotations: {
					readOnlyHint: !config.mutation,
					destructiveHint: !!config.destructive,
					openWorldHint: false,
				},
				scopeChallenge: requireScopes(scope),
			},
			(async (args: z.infer<typeof config.input>, extra: ServerContext) => {
				const started = Date.now();
				const audit = (outcome: AuditEntry["outcome"], detail?: string) =>
					writeMcpAudit({
						principal,
						kind: "tool",
						name,
						outcome,
						detail,
						arguments: args,
						targetId: [
							"applicationId",
							"deploymentId",
							"serviceId",
							"projectId",
							"environmentId",
							"domainId",
							"backupId",
						]
							.map((key) => (args as Record<string, unknown>)[key])
							.find((value) => typeof value === "string") as string | undefined,
						durationMs: Date.now() - started,
					});

				if (!principal.scopes.includes(scope)) {
					await audit("denied", `missing scope ${scope}`);
					return plainError(`Insufficient scope: ${scope} is required.`);
				}
				try {
					if (config.confirm) {
						const confirmation = await requireConfirmation(
							extra,
							principal,
							name,
							args,
							await config.confirm(args),
						);
						if (confirmation.status === "pending") {
							await audit("confirmation_requested");
							return confirmation.result;
						}
						if (confirmation.status !== "approved") {
							await audit("declined", confirmation.status);
							return confirmation.result;
						}
					}
					if (config.mutation) {
						const wait = mutationLimiter.hit(
							`${principal.userId}:${principal.clientId}`,
						);
						if (wait > 0) {
							await audit("rate_limited");
							return plainError(
								`Rate limit reached for changes; retry in ${wait}s.`,
							);
						}
					}
					const result = await handler(args);
					await audit(result.isError ? "error" : "ok");
					return result;
				} catch (error) {
					const message =
						error instanceof ToolError || error instanceof TRPCError
							? error.message
							: "Internal error";
					if (!(error instanceof ToolError || error instanceof TRPCError)) {
						console.error(`[mcp] tool ${name} failed:`, error);
					}
					await audit(error instanceof ToolError ? "denied" : "error", message);
					return plainError(redact(message));
				}
				// The SDK callback type is generic over each tool's schema.
			}) as any,
		);
	};

	registerPlatformTools({ tool, principal, deps, redact });
	registerMonitoringTools({ tool, principal, deps, redact });

	const listAccessibleProjects = async () => {
		const memberRecord = await findMemberByUserId(
			principal.userId,
			principal.organizationId,
		);
		const unrestricted =
			memberRecord.role === "owner" || memberRecord.role === "admin";
		if (!unrestricted && memberRecord.accessedProjects.length === 0) return [];
		const rows = await db.query.projects.findMany({
			where: and(
				eq(projects.organizationId, principal.organizationId),
				unrestricted
					? undefined
					: inArray(projects.projectId, memberRecord.accessedProjects),
			),
			columns: { projectId: true, name: true, description: true },
			with: {
				environments: {
					columns: { environmentId: true, name: true },
					with: {
						applications: {
							columns: {
								applicationId: true,
								name: true,
								applicationStatus: true,
							},
						},
					},
				},
			},
		});
		return rows.map((project) => ({
			...project,
			environments: project.environments
				.filter(
					(env) =>
						unrestricted ||
						memberRecord.accessedEnvironments.includes(env.environmentId),
				)
				.map((env) => ({
					...env,
					applications: env.applications.filter(
						(app) =>
							unrestricted ||
							memberRecord.accessedServices.includes(app.applicationId),
					),
				})),
		}));
	};

	tool(
		"dokploy_list_projects",
		"mcp:read",
		{
			title: "List projects",
			description:
				"Projects, environments and applications you can access in the organization.",
			input: z.object({}),
		},
		async () => json({ projects: await listAccessibleProjects() }),
	);

	tool(
		"dokploy_list_applications",
		"mcp:read",
		{
			title: "List applications",
			description:
				"Applications you can access, optionally filtered by project.",
			input: z.object({ projectId: ID.optional() }),
		},
		async ({ projectId }) => {
			const applicationsList = (await listAccessibleProjects())
				.filter((p) => !projectId || p.projectId === projectId)
				.flatMap((p) =>
					p.environments.flatMap((env) =>
						env.applications.map((app) => ({
							...app,
							projectId: p.projectId,
							projectName: p.name,
							environment: env.name,
						})),
					),
				);
			return json({ applications: applicationsList });
		},
	);

	tool(
		"dokploy_get_application",
		"mcp:read",
		{
			title: "Get application",
			description:
				"Configuration summary of an application. Environment variable names only, never values.",
			input: z.object({ applicationId: ID }),
		},
		async ({ applicationId }) => {
			const app = await loadApplication(applicationId);
			const canReadEnv = await checkPermission(ctx, { envVars: ["read"] })
				.then(() => true)
				.catch(() => false);
			const source = describeSource(app);
			return json({
				applicationId: app.applicationId,
				name: app.name,
				appName: app.appName,
				status: app.applicationStatus,
				source: {
					type: app.sourceType,
					repository: source.repository,
					branch: source.branch,
				},
				buildType: app.buildType,
				dockerfile:
					app.buildType === "dockerfile"
						? app.dockerfile || "Dockerfile"
						: undefined,
				replicas: app.replicas,
				serverId: app.serverId,
				domains: app.domains.map((d) => ({
					domainId: d.domainId,
					host: d.host,
					port: d.port,
					path: d.path,
					https: d.https,
				})),
				publishedPorts: app.ports.map((p) => ({
					publishedPort: p.publishedPort,
					targetPort: p.targetPort,
					protocol: p.protocol,
				})),
				environmentVariableNames: canReadEnv
					? (app.env ?? "")
							.split("\n")
							.map((l) => l.trim())
							.filter((l) => l && !l.startsWith("#") && l.includes("="))
							.map((l) => l.slice(0, l.indexOf("=")))
					: "hidden (missing envVars.read permission)",
				swarmHealthcheck: app.healthCheckSwarm ?? null,
			});
		},
	);

	tool(
		"dokploy_get_deployments",
		"mcp:read",
		{
			title: "Get deployments",
			description:
				"Recent deployments of an application (with the version actually built and verified) or of a compose stack. Pass applicationId or composeId.",
			input: z.object({
				applicationId: ID.optional(),
				composeId: ID.optional(),
				limit: z.number().int().min(1).max(50).default(10),
			}),
		},
		async ({ applicationId, composeId, limit }) => {
			if (!applicationId === !composeId) {
				throw new ToolError("Pass either applicationId or composeId.");
			}
			let source: Awaited<ReturnType<typeof findAllDeploymentsByComposeId>>;
			if (applicationId) {
				source = (
					await loadApplication(applicationId, { deployment: ["read"] })
				).deployments;
			} else {
				await loadCompose(composeId as string);
				source = await findAllDeploymentsByComposeId(composeId as string);
			}
			const deployments = [...source]
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				.slice(0, limit)
				.map((d) => ({
					deploymentId: d.deploymentId,
					title: redact(d.title),
					kind: d.kind,
					status: d.status,
					verificationStatus: d.verificationStatus,
					createdAt: d.createdAt,
					builtCommitSha: d.builtCommitSha,
					imageId: d.imageId,
					redeployable: !!d.imageTag && d.status === "done",
				}));
			return json({ deployments });
		},
	);

	tool(
		"dokploy_get_deployment_status",
		"mcp:read",
		{
			title: "Get deployment status",
			description:
				"Status of a deployment (application or compose). For applications, step by step: build, container created, running, healthy, reachable.",
			input: z.object({ deploymentId: ID }),
		},
		async ({ deploymentId }) => {
			const { deployment } = await loadAnyDeployment(deploymentId);
			return json({
				deploymentId,
				kind: deployment.kind,
				status: deployment.status,
				verificationStatus: deployment.verificationStatus,
				requestedCommitSha: deployment.requestedCommitSha,
				fetchedCommitSha: deployment.fetchedCommitSha,
				builtCommitSha: deployment.builtCommitSha,
				imageId: deployment.imageId,
				runningImageId: deployment.runningImageId,
				findings: deployment.verification?.findings ?? [],
				...buildTimeline(deployment),
			});
		},
	);

	tool(
		"dokploy_get_deployment_logs",
		"mcp:read",
		{
			title: "Get deployment logs",
			description:
				"Last lines of a deployment's build log (application or compose). Secrets and terminal escape sequences are removed.",
			input: z.object({
				deploymentId: ID,
				lines: z.number().int().min(1).max(500).default(100),
			}),
		},
		async ({ deploymentId, lines }) => {
			const {
				deployment,
				serverId,
				env: envSources,
			} = await loadAnyDeployment(deploymentId);
			const logsRoot = paths(!!serverId).LOGS_PATH;
			const logPath = path.normalize(deployment.logPath);
			if (!SAFE_LOG_PATH.test(logPath) || !logPath.startsWith(`${logsRoot}/`)) {
				throw new ToolError("Log file unavailable");
			}
			const { stdout } = await runOn(
				serverId,
				`tail -n ${lines} '${logPath}' 2>/dev/null`,
			);
			let env: Record<string, string> = {};
			try {
				env = getEnvironmentVariablesObject(...envSources);
			} catch {
				env = {};
			}
			return json({
				deploymentId,
				lines: redactLines(stdout.split("\n"), createRedactor(env), lines),
			});
		},
	);

	tool(
		"dokploy_get_runtime_version",
		"mcp:read",
		{
			title: "Get running version",
			description:
				"Commit and image actually running, compared with the remote branch head (checked live; never assumed).",
			input: z.object({ applicationId: ID }),
		},
		async ({ applicationId }) => {
			await loadApplication(applicationId);
			const status = await getVersionStatus(applicationId, {
				checkRemote: true,
			});
			return json({
				branch: status.source.branch,
				runningCommitSha: status.runningCommitSha,
				runningImageId: status.live.runningImageId ?? null,
				currentDeploymentId: status.current?.deploymentId ?? null,
				matchedBy: status.currentMatch,
				latestRemote: status.latestRemote,
				versionState: status.versionState,
				versionReason: status.versionReason,
				recommendedAction: status.recommendedAction,
			});
		},
	);

	tool(
		"dokploy_get_application_health",
		"mcp:read",
		{
			title: "Get application health",
			description:
				"Live health verdict (healthy, degraded, down, unknown) with the main findings.",
			input: z.object({ applicationId: ID }),
		},
		async ({ applicationId }) => {
			await loadApplication(applicationId);
			const report = await diagnoseApplication(applicationId);
			return json({
				verdict: report.verdict,
				runningTasks: report.facts.runningTasks,
				desiredReplicas: report.facts.desiredReplicas,
				findings: report.findings.map((f) => ({
					code: f.code,
					severity: f.severity,
					confidence: f.confidence,
					title: f.title,
				})),
				notChecked: report.collectionErrors,
			});
		},
	);

	tool(
		"dokploy_get_port_configuration",
		"mcp:read",
		{
			title: "Get port configuration",
			description:
				"Domain target ports, image EXPOSE, sockets actually listening in the container, published ports and Traefik probes.",
			input: z.object({ applicationId: ID }),
		},
		async ({ applicationId }) => {
			const app = await loadApplication(applicationId);
			const report = await diagnoseApplication(applicationId);
			return json({
				domains: report.facts.domains,
				imageExposedPorts: report.facts.imageExposedPorts,
				listening: report.facts.listening,
				publishedPorts: app.ports.map((p) => ({
					publishedPort: p.publishedPort,
					targetPort: p.targetPort,
					protocol: p.protocol,
					publishMode: p.publishMode,
				})),
				probes: report.facts.probes,
				portFindings: report.findings.filter((f) =>
					[
						"PORT_MISMATCH",
						"APPLICATION_NOT_LISTENING",
						"APPLICATION_LISTENING_ON_LOCALHOST",
					].includes(f.code),
				),
			});
		},
	);

	tool(
		"dokploy_diagnose_deployment",
		"mcp:read",
		{
			title: "Diagnose application",
			description:
				"Full deterministic diagnosis: findings with evidence, probable cause, confidence, recommended fix and risk.",
			input: z.object({ applicationId: ID }),
		},
		async ({ applicationId }) => {
			await loadApplication(applicationId);
			return json(await diagnoseApplication(applicationId));
		},
	);

	tool(
		"dokploy_list_servers",
		"mcp:read",
		{
			title: "List servers",
			description:
				"Remote servers of the organization you can access (no credentials).",
			input: z.object({}),
		},
		async () => {
			await checkPermission(ctx, { server: ["read"] }).catch(() => {
				throw new ToolError("Access denied: server.read permission required");
			});
			const ids = [
				...(await getAccessibleServerIds({
					userId: principal.userId,
					activeOrganizationId: principal.organizationId,
				})),
			];
			const servers = ids.length
				? await db.query.server.findMany({
						where: inArray(serverTable.serverId, ids),
						columns: {
							serverId: true,
							name: true,
							description: true,
							serverStatus: true,
						},
					})
				: [];
			return json({ servers });
		},
	);

	const queued = (
		action: string,
		app: Awaited<ReturnType<typeof findApplicationById>>,
		extra: Record<string, unknown> = {},
	) =>
		json({
			queued: true,
			action,
			applicationId: app.applicationId,
			...extra,
			next: "Poll dokploy_get_deployments, then dokploy_get_deployment_status for the new deployment.",
		});

	tool(
		"dokploy_deploy_application",
		"mcp:deploy",
		{
			title: "Deploy application",
			description:
				"Standard Dokploy deployment: fetch the configured branch, build and update the service.",
			input: z.object({ applicationId: ID }),
			mutation: true,
		},
		async ({ applicationId }) => {
			const app = await loadApplication(applicationId, {
				deployment: ["create"],
			});
			await deps.enqueue(app, { type: "deploy", titleLog: "Deploy (MCP)" });
			return queued("deploy", app);
		},
	);

	tool(
		"dokploy_deploy_latest",
		"mcp:deploy",
		{
			title: "Deploy latest commit",
			description:
				"Checks the remote branch head, then fetches, builds and deploys it. Returns the commit that was found.",
			input: z.object({ applicationId: ID }),
			mutation: true,
		},
		async ({ applicationId }) => {
			const app = await loadApplication(applicationId, {
				deployment: ["create"],
			});
			const head = await getRemoteHead(app);
			await deps.enqueue(app, {
				type: "deploy",
				titleLog: "Deploy latest (MCP)",
			});
			return queued("deploy_latest", app, { remoteHead: head });
		},
	);

	tool(
		"dokploy_rebuild_application",
		"mcp:deploy",
		{
			title: "Rebuild application",
			description:
				"Rebuilds the code already on the server (last clone) without fetching. The built commit is reported in the deployment.",
			input: z.object({ applicationId: ID }),
			mutation: true,
		},
		async ({ applicationId }) => {
			const app = await loadApplication(applicationId, {
				deployment: ["create"],
			});
			await deps.enqueue(app, { type: "redeploy", titleLog: "Rebuild (MCP)" });
			return queued("rebuild", app);
		},
	);

	tool(
		"dokploy_restart_application",
		"mcp:deploy",
		{
			title: "Restart application",
			description:
				"Restarts the containers with the current image and settings. No fetch, no build.",
			input: z.object({ applicationId: ID }),
			mutation: true,
		},
		async ({ applicationId }) => {
			await loadApplication(applicationId, { deployment: ["create"] });
			const deployment = await restartApplicationService(applicationId);
			return json({ restarted: true, deploymentId: deployment.deploymentId });
		},
	);

	tool(
		"dokploy_rollback_deployment",
		"mcp:deploy",
		{
			title: "Roll back to a deployment",
			description:
				"Runs again the exact image retained for an earlier successful deployment (last 5 builds), with the current settings.",
			input: z.object({ deploymentId: ID }),
			mutation: true,
			destructive: true,
		},
		async ({ deploymentId }) => {
			const { application } = await loadDeployment(deploymentId);
			await loadApplication(application.applicationId, {
				deployment: ["create"],
			});
			await assertRedeployable(deploymentId);
			await deps.enqueue(application, {
				type: "redeploy-version",
				sourceDeploymentId: deploymentId,
			});
			return queued("rollback", application, {
				sourceDeploymentId: deploymentId,
			});
		},
	);

	const loadOwnedDomain = async (domainId: string, applicationId?: string) => {
		const domain = await findDomainById(domainId).catch(() => null);
		if (
			!domain?.applicationId ||
			(applicationId && domain.applicationId !== applicationId)
		) {
			throw new ToolError("Domain not found or access denied");
		}
		const app = await loadApplication(domain.applicationId, {
			domain: ["create"],
		});
		return { domain, app };
	};

	tool(
		"dokploy_update_application_port",
		"mcp:config",
		{
			title: "Update application port",
			description:
				"Changes the container port a domain routes to, then regenerates its Traefik route. Never publishes a host port.",
			input: z.object({
				applicationId: ID,
				domainId: ID,
				port: z.number().int().min(1).max(65535),
			}),
			mutation: true,
		},
		async ({ applicationId, domainId, port }) => {
			const { domain } = await loadOwnedDomain(domainId, applicationId);
			const result = await applyDomainPortFix(applicationId, {
				kind: "update_domain_port",
				domainId,
				host: domain.host,
				port,
			});
			return json({ updated: true, ...result });
		},
	);

	tool(
		"dokploy_update_domain",
		"mcp:config",
		{
			title: "Update domain",
			description:
				"Changes a domain's host, path or target port, then regenerates its Traefik route.",
			input: z.object({
				domainId: ID,
				host: z.string().regex(HOSTNAME, "Invalid hostname").optional(),
				path: z
					.string()
					.regex(/^\/[A-Za-z0-9._~/-]*$/, "Invalid path")
					.optional(),
				port: z.number().int().min(1).max(65535).optional(),
			}),
			mutation: true,
		},
		async ({ domainId, host, path: urlPath, port }) => {
			const { domain, app } = await loadOwnedDomain(domainId);
			if (!host && !urlPath && !port) throw new ToolError("Nothing to update");
			const before = {
				host: domain.host,
				path: domain.path,
				port: domain.port,
			};
			await updateDomainById(domainId, {
				...(host ? { host } : {}),
				...(urlPath ? { path: urlPath } : {}),
				...(port ? { port } : {}),
			});
			const updated = await findDomainById(domainId);
			await manageDomain(app, updated);
			return json({
				updated: true,
				domainId,
				before,
				after: { host: updated.host, path: updated.path, port: updated.port },
			});
		},
	);

	tool(
		"dokploy_update_healthcheck",
		"mcp:config",
		{
			title: "Update healthcheck",
			description:
				"Sets the Swarm healthcheck of an application. Applied on the next deployment (dokploy_deploy_application).",
			input: z.object({
				applicationId: ID,
				test: z
					.array(z.string().max(500))
					.min(1)
					.max(20)
					.refine((t) => ["CMD", "CMD-SHELL", "NONE"].includes(t[0] ?? ""), {
						message: 'test must start with "CMD", "CMD-SHELL" or "NONE"',
					}),
				intervalSeconds: z.number().int().min(1).max(3600).default(30),
				timeoutSeconds: z.number().int().min(1).max(600).default(10),
				retries: z.number().int().min(1).max(20).default(3),
				startPeriodSeconds: z.number().int().min(0).max(3600).default(10),
			}),
			mutation: true,
		},
		async ({
			applicationId,
			test,
			intervalSeconds,
			timeoutSeconds,
			retries,
			startPeriodSeconds,
		}) => {
			await loadApplication(applicationId, { service: ["create"] });
			const NS = 1_000_000_000;
			const healthCheckSwarm = {
				Test: test,
				Interval: intervalSeconds * NS,
				Timeout: timeoutSeconds * NS,
				Retries: retries,
				StartPeriod: startPeriodSeconds * NS,
			};
			await updateApplication(applicationId, { healthCheckSwarm });
			return json({
				updated: true,
				healthCheckSwarm: {
					test,
					intervalSeconds,
					timeoutSeconds,
					retries,
					startPeriodSeconds,
				},
				appliesOn: "next deployment",
			});
		},
	);

	server.registerResource(
		"application",
		new ResourceTemplate("dokploy://application/{applicationId}", {
			list: undefined,
		}),
		{
			title: "Application summary",
			description:
				"Status, source, domains and running version of an application.",
			mimeType: "application/json",
			scopeChallenge: requireScopes("mcp:read"),
		},
		async (uri, variables) => {
			const applicationId = String(variables.applicationId ?? "");
			if (
				!principal.scopes.includes("mcp:read") ||
				!ID.safeParse(applicationId).success
			) {
				throw new ToolError("Resource not found");
			}
			const app = await loadApplication(applicationId);
			const status = await getVersionStatus(applicationId, {
				checkRemote: false,
			});
			await writeMcpAudit({
				principal,
				kind: "resource",
				name: "application",
				outcome: "ok",
				targetId: applicationId,
			});
			return {
				contents: [
					{
						uri: uri.toString(),
						mimeType: "application/json",
						text: JSON.stringify(
							{
								applicationId,
								name: app.name,
								status: app.applicationStatus,
								branch: status.source.branch,
								runningCommitSha: status.runningCommitSha,
								versionState: status.versionState,
								domains: app.domains.map((d) => ({
									host: d.host,
									port: d.port,
								})),
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	server.registerResource(
		"deployment-timeline",
		new ResourceTemplate("dokploy://deployment/{deploymentId}/timeline", {
			list: undefined,
		}),
		{
			title: "Deployment timeline",
			description: "Recorded steps of a deployment.",
			mimeType: "application/json",
			scopeChallenge: requireScopes("mcp:read"),
		},
		async (uri, variables) => {
			const deploymentId = String(variables.deploymentId ?? "");
			if (
				!principal.scopes.includes("mcp:read") ||
				!ID.safeParse(deploymentId).success
			) {
				throw new ToolError("Resource not found");
			}
			const { deployment } = await loadDeployment(deploymentId);
			await writeMcpAudit({
				principal,
				kind: "resource",
				name: "deployment-timeline",
				outcome: "ok",
				targetId: deploymentId,
			});
			return {
				contents: [
					{
						uri: uri.toString(),
						mimeType: "application/json",
						text: JSON.stringify(buildTimeline(deployment), null, 2),
					},
				],
			};
		},
	);

	return server;
};
