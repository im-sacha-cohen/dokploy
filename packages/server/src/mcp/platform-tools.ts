// Tools covering the rest of the Dokploy API: services of every type,
// environment variables, domains, backups and container commands. Every call
// goes through the same tRPC procedure as the web UI (deps.callApi), so the
// user's Dokploy permissions apply unchanged; MCP scopes only narrow them.
import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	createRedactor,
	type Redactor,
} from "../smart-deploy/diagnostics/redact";
import type { McpApiPath } from "./api-paths";
import type { McpPrincipal } from "./token";
import {
	ID,
	json,
	type McpActionDeps,
	plainError,
	type RegisterTool,
	ToolError,
} from "./tool-kit";

const SERVICE_TYPES = [
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
] as const;
type ServiceType = (typeof SERVICE_TYPES)[number];
const DATABASE_TYPES = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
] as const;
type DatabaseType = (typeof DATABASE_TYPES)[number];

const isDatabase = (type: ServiceType): type is DatabaseType =>
	(DATABASE_TYPES as readonly string[]).includes(type);

const idField = (type: ServiceType) => `${type}Id`;
const apiPath = (type: ServiceType, procedure: string) =>
	`${type}.${procedure}` as McpApiPath;
const deletePath = (type: ServiceType) =>
	apiPath(type, isDatabase(type) ? "remove" : "delete");

const MAX_OUTPUT_CHARS = 32_000;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const SECRET_KEY =
	/pass|secret|token|key|private|credential|auth|salt|cert|dsn|cookie|session/i;
// Placeholders this server prints instead of secrets. Writing them back would
// silently replace the real value.
const MASK_MARKERS = ["[REDACTED", "[secret"];

const serviceInput = {
	serviceType: z.enum(SERVICE_TYPES),
	serviceId: ID,
};

type Row = Record<string, unknown>;

const truncate = (text: string) =>
	text.length > MAX_OUTPUT_CHARS
		? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated: ${text.length - MAX_OUTPUT_CHARS} more characters]`
		: text;

const containsMask = (value: string) =>
	MASK_MARKERS.some((marker) => value.includes(marker));

/** KEY=VALUE lines, in order; comments and blank lines are kept as-is. */
const parseEnv = (text: string | null | undefined) =>
	(text ?? "").split("\n").map((line) => {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/.exec(
			line,
		);
		return match
			? { key: match[1] as string, value: match[2] as string, line }
			: { key: null, value: null, line };
	});

const envValues = (text: string | null | undefined) =>
	Object.fromEntries(
		parseEnv(text)
			.filter((entry) => entry.key !== null)
			.map((entry) => [entry.key as string, entry.value as string]),
	);

const pick = (row: Row, keys: string[]) =>
	Object.fromEntries(
		keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]),
	);

const randomPassword = () => randomBytes(24).toString("hex");

export const registerPlatformTools = ({
	tool,
	principal,
	deps,
	redact,
}: {
	tool: RegisterTool;
	principal: McpPrincipal;
	deps: McpActionDeps;
	redact: Redactor;
}) => {
	const api = <T = Row>(path: McpApiPath, input?: unknown) =>
		deps.callApi(principal, path, input) as Promise<T>;

	const loadService = (type: ServiceType, serviceId: string) =>
		api<Row>(apiPath(type, "one"), { [idField(type)]: serviceId });

	/** Redactor that also knows the service's own configured values. */
	const serviceRedactor = (service: Row) =>
		createRedactor({
			...envValues(service.env as string),
			...(typeof service.databasePassword === "string"
				? { databasePassword: service.databasePassword }
				: {}),
			...(typeof service.databaseRootPassword === "string"
				? { databaseRootPassword: service.databaseRootPassword }
				: {}),
		});

	const describeService = (type: ServiceType, service: Row) => {
		const safe = serviceRedactor(service);
		const domains = Array.isArray(service.domains)
			? (service.domains as Row[]).map((d) =>
					pick(d, [
						"domainId",
						"host",
						"port",
						"path",
						"https",
						"certificateType",
						"serviceName",
					]),
				)
			: undefined;
		const backups = Array.isArray(service.backups)
			? (service.backups as Row[]).map((b) =>
					pick(b, [
						"backupId",
						"schedule",
						"enabled",
						"database",
						"prefix",
						"keepLatestCount",
						"destinationId",
						"serviceName",
					]),
				)
			: undefined;
		const gitUrl =
			typeof service.customGitUrl === "string"
				? safe(service.customGitUrl)
				: undefined;
		return {
			serviceType: type,
			serviceId: service[idField(type)],
			...pick(service, [
				"name",
				"appName",
				"description",
				"applicationStatus",
				"composeStatus",
				"serverId",
				"environmentId",
				"sourceType",
				"buildType",
				"dockerfile",
				"dockerContextPath",
				"dockerImage",
				"repository",
				"owner",
				"branch",
				"customGitBranch",
				"buildPath",
				"composeType",
				"composePath",
				"command",
				"replicas",
				"memoryLimit",
				"memoryReservation",
				"cpuLimit",
				"cpuReservation",
				"databaseName",
				"databaseUser",
				"externalPort",
			]),
			...(gitUrl ? { customGitUrl: gitUrl } : {}),
			...(typeof service.composeFile === "string"
				? { composeFile: truncate(safe(service.composeFile)) }
				: {}),
			envKeys: Object.keys(envValues(service.env as string)),
			...(domains ? { domains } : {}),
			...(backups ? { backups } : {}),
		};
	};

	/** Containers of a service; compose stacks may have several. */
	const listContainers = async (type: ServiceType, service: Row) => {
		const containers = await api<
			{ containerId: string; name: string; state: string }[]
		>("docker.getContainersByAppNameMatch", {
			appName: service.appName,
			...(type === "compose"
				? {
						appType:
							service.composeType === "stack" ? "stack" : "docker-compose",
					}
				: {}),
			...(service.serverId ? { serverId: service.serverId } : {}),
		});
		return containers.map((c) => ({
			containerId: c.containerId,
			name: c.name,
			state: c.state,
		}));
	};

	const pickContainer = async (
		type: ServiceType,
		service: Row,
		containerId?: string,
	) => {
		const containers = await listContainers(type, service);
		if (containerId) {
			const found = containers.find(
				(c) => c.containerId === containerId || c.name === containerId,
			);
			if (!found)
				throw new ToolError(
					`Container ${containerId} does not belong to this service.`,
				);
			return found;
		}
		const running = containers.filter((c) => c.state === "running");
		if (running.length === 0)
			throw new ToolError("No running container for this service.");
		// Replicas of one swarm service are interchangeable; docker lists the newest first.
		if (running.length === 1 || type !== "compose")
			return running[0] as (typeof running)[number];
		throw new ToolError(
			`Several containers are running; pass containerId. ${JSON.stringify(running)}`,
		);
	};

	tool(
		"dokploy_list_services",
		"mcp:read",
		{
			title: "List services",
			description:
				"Lists every project, environment and service (applications, compose stacks and databases) you can access, with ids and status.",
			input: z.object({ projectId: ID.optional() }),
		},
		async ({ projectId }) => {
			const projects = await api<Row[]>("project.all");
			const keys: [string, ServiceType][] = [
				["applications", "application"],
				["compose", "compose"],
				["postgres", "postgres"],
				["mysql", "mysql"],
				["mariadb", "mariadb"],
				["mongo", "mongo"],
				["redis", "redis"],
			];
			return json({
				projects: projects
					.filter((p) => !projectId || p.projectId === projectId)
					.map((p) => ({
						projectId: p.projectId,
						name: p.name,
						environments: ((p.environments as Row[]) ?? []).map((env) => ({
							environmentId: env.environmentId,
							name: env.name,
							services: keys.flatMap(([key, type]) =>
								((env[key] as Row[]) ?? []).map((s) => ({
									serviceType: type,
									serviceId: s[idField(type)],
									name: s.name,
									status: s.applicationStatus ?? s.composeStatus,
								})),
							),
						})),
					})),
			});
		},
	);

	tool(
		"dokploy_get_service",
		"mcp:read",
		{
			title: "Get service",
			description:
				"Configuration of one service: source, build, image, resources, domains, backups and the names of its environment variables. Secrets are never returned.",
			input: z.object(serviceInput),
		},
		async ({ serviceType, serviceId }) =>
			json(
				describeService(serviceType, await loadService(serviceType, serviceId)),
			),
	);

	tool(
		"dokploy_get_service_logs",
		"mcp:read",
		{
			title: "Get service logs",
			description:
				"Runtime logs of a running service (not build logs), redacted. For a compose stack with several containers, pass containerId (the error lists them).",
			input: z.object({
				...serviceInput,
				tail: z.number().int().min(1).max(2000).default(200),
				since: z
					.string()
					.regex(/^(all|\d+[smhd])$/)
					.default("all")
					.describe('"all" or a duration like "15m", "2h"'),
				search: z
					.string()
					.regex(/^[a-zA-Z0-9 ._-]{0,200}$/)
					.optional(),
				containerId: z
					.string()
					.regex(/^[a-zA-Z0-9.\-_]{1,128}$/)
					.optional(),
			}),
		},
		async ({ serviceType, serviceId, tail, since, search, containerId }) => {
			const service = await loadService(serviceType, serviceId);
			const input: Row = {
				[idField(serviceType)]: serviceId,
				tail,
				since,
				...(search ? { search } : {}),
			};
			if (serviceType === "compose") {
				input.containerId = (
					await pickContainer(serviceType, service, containerId)
				).containerId;
			}
			const logs = await api<string>(apiPath(serviceType, "readLogs"), input);
			const safe = serviceRedactor(service);
			return {
				content: [
					{
						type: "text",
						text: truncate(
							String(logs ?? "")
								.split("\n")
								.map((line) => safe(line))
								.join("\n"),
						),
					},
				],
			};
		},
	);

	tool(
		"dokploy_get_env_vars",
		"mcp:env",
		{
			title: "Get environment variables",
			description:
				"Environment variables of a service (and build arguments of an application). Values of keys that look secret are masked; other values are shown with credentials redacted.",
			input: z.object(serviceInput),
		},
		async ({ serviceType, serviceId }) => {
			const service = await loadService(serviceType, serviceId);
			const secrets = Object.fromEntries(
				Object.entries(envValues(service.env as string)).filter(([key]) =>
					SECRET_KEY.test(key),
				),
			);
			// Hides a secret that is also embedded in a non-secret value (e.g. a URL).
			const safe = createRedactor(secrets);
			const show = (text: unknown) =>
				Object.fromEntries(
					Object.entries(envValues(text as string)).map(([key, value]) => [
						key,
						SECRET_KEY.test(key)
							? `[secret: ${value ? "set" : "empty"}]`
							: redact(safe(value)),
					]),
				);
			return json({
				env: show(service.env),
				...(serviceType === "application"
					? {
							buildArgs: show(service.buildArgs),
							buildSecretKeys: Object.keys(
								envValues(service.buildSecrets as string),
							),
						}
					: {}),
			});
		},
	);

	tool(
		"dokploy_set_env_vars",
		"mcp:env",
		{
			title: "Set environment variables",
			description:
				"Sets and/or removes environment variables (or application build arguments) without touching the others. Takes effect at the next deploy.",
			input: z.object({
				...serviceInput,
				set: z.record(z.string(), z.string().max(8192)).default({}),
				unset: z.array(z.string()).max(100).default([]),
				target: z.enum(["env", "buildArgs"]).default("env"),
			}),
			mutation: true,
		},
		async ({ serviceType, serviceId, set, unset, target }) => {
			if (target === "buildArgs" && serviceType !== "application")
				throw new ToolError("Build arguments exist only on applications.");
			for (const [key, value] of Object.entries(set)) {
				if (!ENV_KEY.test(key))
					throw new ToolError(`Invalid variable name: ${key}`);
				if (value.includes("\n"))
					throw new ToolError(`The value of ${key} contains a line break.`);
				if (containsMask(value))
					throw new ToolError(
						`The value of ${key} is a masked placeholder, not a real value.`,
					);
			}
			if (Object.keys(set).length === 0 && unset.length === 0)
				throw new ToolError("Nothing to change.");

			const service = await loadService(serviceType, serviceId);
			const current = String(service[target] ?? "");
			const remaining = new Map(Object.entries(set));
			const removed = new Set(unset);
			const lines = parseEnv(current).flatMap((entry) => {
				if (entry.key === null) return [entry.line];
				if (removed.has(entry.key)) return [];
				if (remaining.has(entry.key)) {
					const value = remaining.get(entry.key);
					remaining.delete(entry.key);
					return [`${entry.key}=${value}`];
				}
				return [entry.line];
			});
			for (const [key, value] of remaining) lines.push(`${key}=${value}`);
			const next = lines.join("\n").replace(/^\n+|\n+$/g, "");

			const idInput = { [idField(serviceType)]: serviceId };
			if (serviceType === "application") {
				await api("application.saveEnvironment", {
					...idInput,
					env: target === "env" ? next : (service.env ?? ""),
					buildArgs: target === "buildArgs" ? next : (service.buildArgs ?? ""),
					buildSecrets: service.buildSecrets ?? "",
					createEnvFile: service.createEnvFile ?? true,
				});
			} else {
				await api(apiPath(serviceType, "saveEnvironment"), {
					...idInput,
					env: next,
				});
			}
			return json({
				saved: true,
				set: Object.keys(set),
				removed: unset.filter((key) => key in envValues(current)),
				note: "Redeploy the service for the change to take effect.",
			});
		},
	);

	tool(
		"dokploy_update_service_settings",
		"mcp:config",
		{
			title: "Update service settings",
			description:
				"Changes general settings of a service: name, description, start command, replicas (applications), resource limits, and Docker image (databases). Takes effect at the next deploy.",
			input: z.object({
				...serviceInput,
				name: z.string().min(1).max(100).optional(),
				description: z.string().max(1000).optional(),
				command: z.string().max(2000).optional(),
				replicas: z.number().int().min(0).max(100).optional(),
				memoryLimit: z.string().max(32).optional(),
				memoryReservation: z.string().max(32).optional(),
				cpuLimit: z.string().max(32).optional(),
				cpuReservation: z.string().max(32).optional(),
				dockerImage: z.string().max(500).optional(),
			}),
			mutation: true,
		},
		async ({ serviceType, serviceId, ...settings }) => {
			const changes = Object.fromEntries(
				Object.entries(settings).filter(([, value]) => value !== undefined),
			);
			if (Object.keys(changes).length === 0)
				throw new ToolError("Nothing to change.");
			const unsupported = Object.keys(changes).filter(
				(key) =>
					(key === "replicas" && serviceType !== "application") ||
					(key === "dockerImage" && !isDatabase(serviceType)) ||
					(serviceType === "compose" &&
						!["name", "description", "command"].includes(key)),
			);
			if (unsupported.length > 0)
				throw new ToolError(
					`Not settable on ${serviceType}: ${unsupported.join(", ")}.${
						unsupported.includes("dockerImage")
							? " Use dokploy_set_application_source for an application image."
							: ""
					}`,
				);
			await api(apiPath(serviceType, "update"), {
				[idField(serviceType)]: serviceId,
				...changes,
			});
			return json({ updated: Object.keys(changes) });
		},
	);

	tool(
		"dokploy_set_application_source",
		"mcp:config",
		{
			title: "Set application source",
			description:
				"Sets where an application is built from: a Git URL, a Docker image, or a GitHub repository connected to Dokploy.",
			input: z.object({
				applicationId: ID,
				source: z.discriminatedUnion("type", [
					z.object({
						type: z.literal("git"),
						url: z.string().min(1).max(500),
						branch: z.string().min(1).max(200),
						buildPath: z.string().max(500).default("/"),
						sshKeyId: ID.optional(),
						watchPaths: z.array(z.string().max(500)).max(50).default([]),
						enableSubmodules: z.boolean().default(false),
					}),
					z.object({
						type: z.literal("docker"),
						image: z.string().min(1).max(500),
						registryUrl: z.string().max(500).optional(),
						username: z.string().max(200).optional(),
						password: z.string().max(2000).optional(),
					}),
					z.object({
						type: z.literal("github"),
						githubId: ID,
						owner: z.string().min(1).max(200),
						repository: z.string().min(1).max(200),
						branch: z.string().min(1).max(200),
						buildPath: z.string().max(500).default("/"),
						triggerType: z.enum(["push", "tag"]).default("push"),
						watchPaths: z.array(z.string().max(500)).max(50).default([]),
						enableSubmodules: z.boolean().default(false),
					}),
				]),
			}),
			mutation: true,
		},
		async ({ applicationId, source }) => {
			if (source.type === "git") {
				await api("application.saveGitProvider", {
					applicationId,
					customGitUrl: source.url,
					customGitBranch: source.branch,
					customGitBuildPath: source.buildPath,
					customGitSSHKeyId: source.sshKeyId ?? null,
					watchPaths: source.watchPaths,
					enableSubmodules: source.enableSubmodules,
				});
			} else if (source.type === "docker") {
				if (source.password && containsMask(source.password))
					throw new ToolError("The password is a masked placeholder.");
				await api("application.saveDockerProvider", {
					applicationId,
					dockerImage: source.image,
					registryUrl: source.registryUrl ?? "",
					username: source.username ?? null,
					password: source.password ?? null,
				});
			} else {
				await api("application.saveGithubProvider", {
					applicationId,
					githubId: source.githubId,
					owner: source.owner,
					repository: source.repository,
					branch: source.branch,
					buildPath: source.buildPath,
					triggerType: source.triggerType,
					watchPaths: source.watchPaths,
					enableSubmodules: source.enableSubmodules,
				});
			}
			return json({
				saved: true,
				sourceType: source.type,
				note: "Deploy the application to build from the new source.",
			});
		},
	);

	tool(
		"dokploy_set_build_type",
		"mcp:config",
		{
			title: "Set build type",
			description:
				"Chooses how an application is built (Dockerfile, Nixpacks, Railpack, buildpacks or static) and its build options.",
			input: z.object({
				applicationId: ID,
				buildType: z.enum([
					"dockerfile",
					"nixpacks",
					"railpack",
					"heroku_buildpacks",
					"paketo_buildpacks",
					"static",
				]),
				dockerfile: z.string().max(500).optional(),
				dockerContextPath: z.string().max(500).optional(),
				dockerBuildStage: z.string().max(200).optional(),
				publishDirectory: z.string().max(500).optional(),
				isStaticSpa: z.boolean().optional(),
			}),
			mutation: true,
		},
		async ({ applicationId, ...options }) => {
			const app = await loadService("application", applicationId);
			const keep = (key: string) =>
				(options as Row)[key] ?? (app[key] as unknown) ?? null;
			await api("application.saveBuildType", {
				applicationId,
				buildType: options.buildType,
				dockerfile: keep("dockerfile"),
				dockerContextPath: keep("dockerContextPath"),
				dockerBuildStage: keep("dockerBuildStage"),
				herokuVersion: app.herokuVersion ?? null,
				railpackVersion: app.railpackVersion ?? null,
				publishDirectory: keep("publishDirectory"),
				isStaticSpa: keep("isStaticSpa") ?? false,
			});
			return json({ saved: true, buildType: options.buildType });
		},
	);

	tool(
		"dokploy_update_compose_file",
		"mcp:config",
		{
			title: "Update compose file",
			description:
				"Replaces the docker-compose file of a compose service stored in Dokploy (raw source). Takes effect at the next deploy.",
			input: z.object({
				composeId: ID,
				composeFile: z.string().min(1).max(200_000),
			}),
			mutation: true,
		},
		async ({ composeId, composeFile }) => {
			if (containsMask(composeFile))
				throw new ToolError(
					"The file contains masked placeholders; write the real values or reference environment variables.",
				);
			const compose = await loadService("compose", composeId);
			await api("compose.update", { composeId, composeFile });
			return json({
				saved: true,
				...(compose.sourceType !== "raw"
					? {
							warning: `This service builds from ${compose.sourceType}: the repository's compose file is used at deploy time, not this one.`,
						}
					: {}),
			});
		},
	);

	const dnsInput = z
		.object({
			dnsProviderId: ID,
			zoneId: z.string().min(1).max(255),
			name: z
				.string()
				.max(253)
				.optional()
				.describe(
					"Subdomain or full name; the suggestion is used when omitted",
				),
			ip: z.ipv4().optional().describe("Defaults to the server's main IPv4"),
			proxied: z.boolean().default(false).describe("Cloudflare proxy"),
		})
		.optional()
		.describe(
			"Also create the A record at a DNS provider from Settings › DNS (see dokploy_suggest_subdomain). Never overwrites an existing record.",
		);

	tool(
		"dokploy_suggest_subdomain",
		"mcp:read",
		{
			title: "Suggest subdomain",
			description:
				"Lists the DNS providers connected in Settings › DNS and their zones, suggests a free subdomain for a service, and checks a name you propose. Creates nothing.",
			input: z.object({
				serviceType: z.enum(["application", "compose"]),
				serviceId: ID,
				dnsProviderId: ID.optional(),
				zoneId: z.string().min(1).max(255).optional(),
				name: z.string().max(253).optional(),
			}),
		},
		async ({ serviceType, serviceId, dnsProviderId, zoneId, name }) => {
			const context = await api<Row & { providers: Row[] }>(
				"domainDns.context",
				{ serviceType, serviceId },
			);
			const providerId =
				dnsProviderId ?? (context.providers[0]?.dnsProviderId as string);
			if (!providerId) {
				return json({
					providers: [],
					note: "No DNS provider is connected (Settings › DNS), or you may not read them.",
				});
			}
			const zones = await api<Row[]>("dnsProvider.listZones", {
				dnsProviderId: providerId,
			});
			const zone = zoneId ?? (zones[0]?.id as string | undefined);
			const check = zone
				? await api<Row>("domainDns.suggest", {
						serviceType,
						serviceId,
						dnsProviderId: providerId,
						zoneId: zone,
						...(name ? { name } : {}),
					})
				: null;
			return json({
				providers: context.providers,
				dnsProviderId: providerId,
				zones: zones.map((z) => ({ zoneId: z.id, name: z.name })),
				zoneId: zone,
				serverIps: context.serverIps,
				canCreateRecords: context.canCreateRecords,
				...(check ?? {}),
			});
		},
	);

	tool(
		"dokploy_create_domain",
		"mcp:config",
		{
			title: "Create domain",
			description:
				"Routes a host name to an application or a service of a compose stack, through Traefik. With `dns`, also creates the DNS record (then `host` may be omitted).",
			input: z.object({
				serviceType: z.enum(["application", "compose"]),
				serviceId: ID,
				host: z
					.string()
					.min(1)
					.max(253)
					.regex(/^[A-Za-z0-9.-]+$/)
					.optional(),
				port: z.number().int().min(1).max(65535),
				path: z.string().max(500).default("/"),
				https: z.boolean().default(false),
				certificateType: z.enum(["none", "letsencrypt"]).default("none"),
				serviceName: z
					.string()
					.max(200)
					.optional()
					.describe("Compose service to route to (required for compose)"),
				dns: dnsInput,
			}),
			mutation: true,
		},
		async ({ serviceType, serviceId, serviceName, dns, host, ...domain }) => {
			if (serviceType === "compose" && !serviceName)
				throw new ToolError("serviceName is required for a compose stack.");
			const target = {
				...domain,
				domainType: serviceType,
				[idField(serviceType)]: serviceId,
				...(serviceName ? { serviceName } : {}),
			};
			const note =
				serviceType === "compose"
					? "Redeploy the compose stack to apply the route."
					: "The route is active.";

			if (!dns) {
				if (!host) throw new ToolError("host is required without `dns`.");
				const created = await api<Row>("domain.create", { ...target, host });
				return json({
					domainId: created?.domainId,
					host,
					port: domain.port,
					note,
				});
			}

			let name = dns.name ?? host;
			const context = await api<Row & { serverIps: string[] }>(
				"domainDns.context",
				{ serviceType, serviceId },
			);
			if (!name) {
				const check = await api<{ suggestion: { fqdn: string } | null }>(
					"domainDns.suggest",
					{
						serviceType,
						serviceId,
						dnsProviderId: dns.dnsProviderId,
						zoneId: dns.zoneId,
					},
				);
				if (!check.suggestion)
					throw new ToolError("No free subdomain found; pass `dns.name`.");
				name = check.suggestion.fqdn;
			}
			const ip = dns.ip ?? context.serverIps[0];
			if (!ip) throw new ToolError("No IPv4 address found for this server.");
			const result = await api<{
				domain: Row;
				record: { name: string; created: boolean };
			}>("domainDns.createDomain", {
				...target,
				dnsProviderId: dns.dnsProviderId,
				zoneId: dns.zoneId,
				name,
				ip,
				proxied: dns.proxied,
			});
			return json({
				domainId: result.domain.domainId,
				host: result.record.name,
				port: domain.port,
				dnsRecord: result.record.created
					? `A ${result.record.name} → ${ip} created`
					: `${result.record.name} already pointed to this server (reused)`,
				note,
			});
		},
	);

	tool(
		"dokploy_delete_domain",
		"mcp:config",
		{
			title: "Delete domain",
			description:
				"Removes a domain route, and the DNS record Dokploy created for it unless deleteDnsRecord is false. Asks the user to confirm.",
			input: z.object({
				domainId: ID,
				deleteDnsRecord: z.boolean().default(true),
			}),
			mutation: true,
			destructive: true,
			confirm: async ({ domainId, deleteDnsRecord }) => {
				const domain = await api<Row>("domain.one", { domainId });
				const record = await api<Row | null>("domainDns.recordForDomain", {
					domainId,
				});
				const dnsPart =
					record?.canDelete && deleteDnsRecord
						? ` Its DNS record ${record.name} at ${record.providerName} will be deleted too.`
						: record
							? ` Its DNS record ${record.name} is kept.`
							: "";
				return `Delete the domain ${domain.host}? Traffic to it will stop reaching the service.${dnsPart}`;
			},
		},
		async ({ domainId, deleteDnsRecord }) => {
			const record = await api<Row | null>("domainDns.recordForDomain", {
				domainId,
			});
			if (!record) {
				await api("domain.delete", { domainId });
				return json({ deleted: domainId });
			}
			const result = await api<Row>("domainDns.deleteDomain", {
				domainId,
				deleteRecord: !!record.canDelete && deleteDnsRecord,
			});
			return json({ deleted: domainId, ...result });
		},
	);

	tool(
		"dokploy_deploy_service",
		"mcp:deploy",
		{
			title: "Deploy service",
			description:
				"Deploys any service (application, compose stack or database). redeploy=true rebuilds an application or compose stack from the same source.",
			input: z.object({
				...serviceInput,
				redeploy: z.boolean().default(false),
			}),
			mutation: true,
		},
		async ({ serviceType, serviceId, redeploy }) => {
			const procedure =
				redeploy && !isDatabase(serviceType) ? "redeploy" : "deploy";
			await api(apiPath(serviceType, procedure), {
				[idField(serviceType)]: serviceId,
				...(isDatabase(serviceType)
					? {}
					: { title: "Deployment requested through MCP" }),
			});
			return json({
				queued: true,
				serviceType,
				serviceId,
				...(serviceType === "application"
					? {
							next: "Follow it with dokploy_get_deployments / dokploy_get_deployment_status.",
						}
					: {}),
			});
		},
	);

	tool(
		"dokploy_start_service",
		"mcp:deploy",
		{
			title: "Start service",
			description: "Starts a stopped service.",
			input: z.object(serviceInput),
			mutation: true,
		},
		async ({ serviceType, serviceId }) => {
			await api(apiPath(serviceType, "start"), {
				[idField(serviceType)]: serviceId,
			});
			return json({ started: true });
		},
	);

	tool(
		"dokploy_cancel_deployment",
		"mcp:deploy",
		{
			title: "Cancel deployment",
			description:
				"Cancels the queued or running deployment of an application or compose stack.",
			input: z.object({
				serviceType: z.enum(["application", "compose"]),
				serviceId: ID,
			}),
			mutation: true,
		},
		async ({ serviceType, serviceId }) => {
			await api(apiPath(serviceType, "cancelDeployment"), {
				[idField(serviceType)]: serviceId,
			});
			return json({ cancelled: true });
		},
	);

	tool(
		"dokploy_stop_service",
		"mcp:manage",
		{
			title: "Stop service",
			description:
				"Stops a service: it stops serving traffic until started again. Asks the user to confirm.",
			input: z.object(serviceInput),
			mutation: true,
			destructive: true,
			confirm: async ({ serviceType, serviceId }) => {
				const service = await loadService(serviceType, serviceId);
				return `Stop the ${serviceType} "${service.name}"? It stops serving until it is started again.`;
			},
		},
		async ({ serviceType, serviceId }) => {
			await api(apiPath(serviceType, "stop"), {
				[idField(serviceType)]: serviceId,
			});
			return json({ stopped: true });
		},
	);

	tool(
		"dokploy_create_project",
		"mcp:manage",
		{
			title: "Create project",
			description:
				"Creates a project (with its default production environment).",
			input: z.object({
				name: z.string().min(1).max(100),
				description: z.string().max(1000).optional(),
			}),
			mutation: true,
		},
		async ({ name, description }) => {
			const created = await api<{ project: Row; environment?: Row }>(
				"project.create",
				{ name, description },
			);
			return json({
				projectId: created.project.projectId,
				environmentId: created.environment?.environmentId,
				environmentName: created.environment?.name,
			});
		},
	);

	tool(
		"dokploy_create_environment",
		"mcp:manage",
		{
			title: "Create environment",
			description: "Creates an environment (for example staging) in a project.",
			input: z.object({
				projectId: ID,
				name: z.string().min(1).max(100),
				description: z.string().max(1000).optional(),
			}),
			mutation: true,
		},
		async (input) => {
			const environment = await api<Row>("environment.create", input);
			return json({ environmentId: environment.environmentId });
		},
	);

	tool(
		"dokploy_create_service",
		"mcp:manage",
		{
			title: "Create service",
			description:
				"Creates an application, a compose stack or a database in an environment. Database passwords are generated and stored in Dokploy, never returned. Then set a source (applications), env vars and domains, and deploy.",
			input: z.object({
				serviceType: z.enum(SERVICE_TYPES),
				environmentId: ID,
				name: z.string().min(1).max(100),
				description: z.string().max(1000).optional(),
				appName: z
					.string()
					.regex(/^[a-z0-9-]{1,63}$/)
					.optional()
					.describe("Docker name; generated when omitted"),
				dockerImage: z
					.string()
					.max(500)
					.optional()
					.describe("Databases only, e.g. postgres:18"),
				databaseName: z.string().max(63).optional(),
				databaseUser: z.string().max(63).optional(),
				composeFile: z.string().max(200_000).optional(),
				composeType: z.enum(["docker-compose", "stack"]).optional(),
			}),
			mutation: true,
		},
		async ({
			serviceType,
			environmentId,
			name,
			description,
			appName,
			dockerImage,
			databaseName,
			databaseUser,
			composeFile,
			composeType,
		}) => {
			if (composeFile && containsMask(composeFile))
				throw new ToolError("The compose file contains masked placeholders.");
			const base: Row = {
				environmentId,
				name,
				...(description ? { description } : {}),
				...(appName ? { appName } : {}),
			};
			let input: Row = base;
			if (serviceType === "compose") {
				input = {
					...base,
					composeType: composeType ?? "docker-compose",
					...(composeFile ? { composeFile, sourceType: "raw" } : {}),
				};
			} else if (isDatabase(serviceType)) {
				const dbName = databaseName ?? name.toLowerCase().replace(/\W+/g, "_");
				input = {
					...base,
					...(dockerImage ? { dockerImage } : {}),
					databasePassword: randomPassword(),
					...(serviceType === "redis"
						? {}
						: { databaseUser: databaseUser ?? "dokploy" }),
					...(serviceType === "postgres" ||
					serviceType === "mysql" ||
					serviceType === "mariadb"
						? { databaseName: dbName }
						: {}),
					...(serviceType === "mysql" || serviceType === "mariadb"
						? { databaseRootPassword: randomPassword() }
						: {}),
				};
			}
			const created = await api<Row>(apiPath(serviceType, "create"), input);
			return json({
				serviceType,
				serviceId: created?.[idField(serviceType)],
				appName: created?.appName,
				...(isDatabase(serviceType)
					? {
							note: "Credentials were generated and are visible in the Dokploy dashboard. Deploy the database to start it.",
						}
					: {}),
			});
		},
	);

	tool(
		"dokploy_delete_service",
		"mcp:manage",
		{
			title: "Delete service",
			description:
				"Deletes a service and its containers. deleteVolumes (compose) also deletes its data. Asks the user to confirm.",
			input: z.object({
				...serviceInput,
				deleteVolumes: z.boolean().default(false),
			}),
			mutation: true,
			destructive: true,
			confirm: async ({ serviceType, serviceId, deleteVolumes }) => {
				const service = await loadService(serviceType, serviceId);
				return `Permanently delete the ${serviceType} "${service.name}"${
					deleteVolumes || isDatabase(serviceType)
						? " and its data volumes"
						: ""
				}? This cannot be undone.`;
			},
		},
		async ({ serviceType, serviceId, deleteVolumes }) => {
			await api(deletePath(serviceType), {
				[idField(serviceType)]: serviceId,
				...(serviceType === "compose" ? { deleteVolumes } : {}),
			});
			return json({ deleted: serviceId });
		},
	);

	tool(
		"dokploy_delete_environment",
		"mcp:manage",
		{
			title: "Delete environment",
			description:
				"Deletes an environment of a project. Asks the user to confirm.",
			input: z.object({ environmentId: ID }),
			mutation: true,
			destructive: true,
			confirm: ({ environmentId }) =>
				`Permanently delete the environment ${environmentId}? This cannot be undone.`,
		},
		async ({ environmentId }) => {
			await api("environment.remove", { environmentId });
			return json({ deleted: environmentId });
		},
	);

	tool(
		"dokploy_delete_project",
		"mcp:manage",
		{
			title: "Delete project",
			description:
				"Deletes a project and every service in it. Asks the user to confirm.",
			input: z.object({ projectId: ID }),
			mutation: true,
			destructive: true,
			confirm: async ({ projectId }) => {
				const projects = await api<Row[]>("project.all");
				const project = projects.find((p) => p.projectId === projectId);
				if (!project) throw new ToolError("Project not found or access denied");
				return `Permanently delete the project "${project.name}" and every service in it? This cannot be undone.`;
			},
		},
		async ({ projectId }) => {
			await api("project.remove", { projectId });
			return json({ deleted: projectId });
		},
	);

	const loadBackup = async (backupId: string) => {
		const backup = await api<Row>("backup.one", { backupId });
		const target = (
			[
				["postgresId", "postgres", "backup.manualBackupPostgres"],
				["mysqlId", "mysql", "backup.manualBackupMySql"],
				["mariadbId", "mariadb", "backup.manualBackupMariadb"],
				["mongoId", "mongo", "backup.manualBackupMongo"],
				["composeId", "compose", "backup.manualBackupCompose"],
			] as const
		).find(([key]) => typeof backup[key] === "string" && backup[key]);
		// Web server backups belong to the Dokploy instance itself, not to a service.
		if (!target)
			throw new ToolError(
				"Only backups of a database or compose service are available through MCP.",
			);
		return {
			backup,
			serviceId: backup[target[0]] as string,
			databaseType: target[1],
			runPath: target[2] as McpApiPath,
		};
	};

	tool(
		"dokploy_list_backup_files",
		"mcp:read",
		{
			title: "List backup files",
			description:
				"Lists the files stored by a backup configuration (ids come from dokploy_get_service).",
			input: z.object({ backupId: ID }),
		},
		async ({ backupId }) => {
			await loadBackup(backupId);
			const files = await api<Row[]>("backup.listBackupFilesByBackupId", {
				backupId,
			});
			return json({
				files: (files ?? []).map((f) =>
					pick(f, ["Path", "Name", "Size", "ModTime", "IsDir"]),
				),
			});
		},
	);

	tool(
		"dokploy_run_backup",
		"mcp:manage",
		{
			title: "Run backup",
			description: "Runs a configured backup now.",
			input: z.object({ backupId: ID }),
			mutation: true,
		},
		async ({ backupId }) => {
			const { runPath } = await loadBackup(backupId);
			await api(runPath, { backupId });
			return json({ done: true, backupId });
		},
	);

	tool(
		"dokploy_restore_backup",
		"mcp:manage",
		{
			title: "Restore backup",
			description:
				"Restores a database from a backup file, replacing its current data. Asks the user to confirm.",
			input: z.object({
				backupId: ID,
				backupFile: z.string().min(1).max(500),
				databaseName: z.string().min(1).max(63).optional(),
			}),
			mutation: true,
			destructive: true,
			confirm: async ({ backupId, backupFile, databaseName }) => {
				const { backup, databaseType } = await loadBackup(backupId);
				if (databaseType === "compose")
					throw new ToolError(
						"Restoring a compose backup is only available from the Dokploy dashboard.",
					);
				return `Restore ${backupFile} into the ${databaseType} database "${
					databaseName ?? backup.database
				}"? Its current data will be overwritten.`;
			},
		},
		async ({ backupId, backupFile, databaseName }) => {
			const { backup, serviceId, databaseType } = await loadBackup(backupId);
			const stream = await api<AsyncIterable<unknown>>(
				"backup.restoreBackupWithLogs",
				{
					databaseId: serviceId,
					databaseType,
					backupType: "database",
					databaseName: databaseName ?? backup.database,
					backupFile,
					destinationId: backup.destinationId,
				},
			);
			const lines: string[] = [];
			for await (const event of stream) lines.push(redact(String(event)));
			return {
				content: [
					{
						type: "text",
						text: truncate(lines.join("\n") || "Restore finished."),
					},
				],
			};
		},
	);

	tool(
		"dokploy_preflight",
		"mcp:read",
		{
			title: "Smart Deploy preflight",
			description:
				"Checks an application before deploying (Smart Deploy): fetches the source, detects the build type, the port it will listen on and the environment variables it expects, and lists blocking problems. Changes nothing.",
			input: z.object({ applicationId: ID }),
		},
		async ({ applicationId }) =>
			json(await api("smartDeploy.preflight", { applicationId })),
	);

	tool(
		"dokploy_get_deployment_timeline",
		"mcp:read",
		{
			title: "Deployment timeline",
			description:
				"Smart Deploy timeline of an application deployment: each recorded step (fetch, build, container, health, reachability) with its duration and the verification findings.",
			input: z.object({ deploymentId: ID }),
		},
		async ({ deploymentId }) => {
			const timeline = await api<Row>("smartDeploy.getDeploymentTimeline", {
				deploymentId,
			});
			const { logPath: _logPath, ...rest } = timeline;
			return json(rest);
		},
	);

	tool(
		"dokploy_apply_fix",
		"mcp:deploy",
		{
			title: "Apply a Smart Deploy fix",
			description:
				"Applies a fix proposed by dokploy_diagnose_deployment (finding.recommendedFix.action, only when autoFixable): update_domain_port (also needs mcp:config), deploy_latest or redeploy_deployment. The server re-checks that the diagnosis still proposes it.",
			input: z.object({
				applicationId: ID,
				action: z.discriminatedUnion("kind", [
					z.object({
						kind: z.literal("update_domain_port"),
						domainId: ID,
						host: z.string().min(1).max(253),
						port: z.number().int().min(1).max(65535),
					}),
					z.object({ kind: z.literal("deploy_latest") }),
					z.object({
						kind: z.literal("redeploy_deployment"),
						deploymentId: ID,
					}),
				]),
			}),
			mutation: true,
		},
		async ({ applicationId, action }) => {
			if (
				action.kind === "update_domain_port" &&
				!principal.scopes.includes("mcp:config")
			) {
				return plainError("Insufficient scope: mcp:config is required.");
			}
			return json(await api("smartDeploy.applyFix", { applicationId, action }));
		},
	);

	tool(
		"dokploy_exec_command",
		"mcp:exec",
		{
			title: "Run command in container",
			description:
				"Runs a shell command (sh -c) inside the running container of a service and returns its output (redacted, truncated). A human confirms every command. Prefer read-only diagnostics.",
			input: z.object({
				...serviceInput,
				command: z.string().min(1).max(4000),
				containerId: z
					.string()
					.regex(/^[a-zA-Z0-9.\-_]{1,128}$/)
					.optional(),
				timeoutSeconds: z.number().int().min(1).max(120).default(30),
			}),
			mutation: true,
			destructive: true,
			confirm: async ({ serviceType, serviceId, command, containerId }) => {
				const service = await loadService(serviceType, serviceId);
				const container = await pickContainer(
					serviceType,
					service,
					containerId,
				);
				return `Run this command in "${service.name}" (container ${container.name})?\n\n${command}`;
			},
		},
		async ({
			serviceType,
			serviceId,
			command,
			containerId,
			timeoutSeconds,
		}) => {
			const service = await loadService(serviceType, serviceId);
			const container = await pickContainer(serviceType, service, containerId);
			const result = await deps.execInService(principal, {
				serviceId,
				containerId: container.containerId,
				serverId: (service.serverId as string | null) ?? null,
				command,
				timeoutSeconds,
			});
			const safe = serviceRedactor(service);
			const clean = (text: string) =>
				truncate(
					text
						.split("\n")
						.map((line) => redact(safe(line)))
						.join("\n"),
				);
			const output: CallToolResult = json({
				container: container.name,
				exitCode: result.exitCode,
				stdout: clean(result.stdout),
				stderr: clean(result.stderr),
			});
			return result.exitCode === 0 ? output : { ...output, isError: true };
		},
	);
};
