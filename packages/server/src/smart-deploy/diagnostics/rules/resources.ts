// Rules that apply to every kind of service (application, database, compose
// service): image, memory, disk, published port, stopped service.
import {
	DATA_INCOMPATIBLE,
	DISK_FULL,
	isImagePullError,
	isPortInUseError,
} from "../log-patterns";
import type { DiagnosticContext, Rule } from "../types";
import { recentFailedTasks, runningTasks } from "./runtime";

const label = (ctx: DiagnosticContext) =>
	ctx.target.service ? `The service ${ctx.target.service}` : "The service";

const matchingLogLines = (ctx: DiagnosticContext, pattern: RegExp) =>
	(ctx.logs ?? []).filter((line) => pattern.test(line)).slice(-5);

export const imagePullFailedRule: Rule = (ctx) => {
	const failed = recentFailedTasks(ctx).filter((t) =>
		isImagePullError(t.error),
	);
	const unavailable = ctx.database?.imageUnavailable;
	const image =
		ctx.service?.image?.split("@")[0] ?? ctx.database?.configuredImage;
	if (failed.length === 0 && !unavailable) return null;
	return {
		code: "IMAGE_PULL_FAILED",
		title: "Docker image not found",
		description: `${label(ctx)} does not start: Docker cannot pull the image${image ? ` ${image}` : ""}.`,
		severity: "critical",
		confidence: "high",
		evidence: failed.length
			? [
					{
						source: "docker_task",
						summary: `${failed.length} task(s) rejected because the image is missing`,
						excerpt: failed.slice(0, 3).map((t) => `${t.timestamp} ${t.error}`),
					},
				]
			: [
					{
						source: "docker_image",
						summary: `Image missing on the server and rejected by the registry: ${unavailable}`,
					},
				],
		probableCause:
			"The image name or tag is wrong, the image is private and no registry credentials are set, or the registry is unreachable.",
		recommendedFix: {
			summary:
				"Fix the image name and tag (or the registry credentials), then redeploy.",
		},
		risk: "none",
		autoFixable: false,
	};
};

export const outOfMemoryRule: Rule = (ctx) => {
	const oomNow = ctx.container?.oomKilled === true;
	const killed = recentFailedTasks(ctx).filter((t) => t.exitCode === 137);
	if (!oomNow && killed.length === 0) return null;
	return {
		code: "OUT_OF_MEMORY",
		title: "Out of memory",
		description: `${label(ctx)} was killed because it ran out of memory (OOM).`,
		severity:
			killed.length >= 2 || !runningTasks(ctx).length ? "critical" : "error",
		confidence: oomNow ? "high" : "medium",
		evidence: [
			...(oomNow
				? [
						{
							source: "docker_container" as const,
							summary:
								"Docker reports the container was killed for exceeding its memory (OOMKilled)",
						},
					]
				: []),
			...(killed.length
				? [
						{
							source: "docker_task" as const,
							summary: `${killed.length} task(s) ended by SIGKILL (code 137) in the last 10 minutes`,
						},
					]
				: []),
		],
		probableCause:
			"The service memory limit is too low for its load, or the process is leaking memory.",
		recommendedFix: {
			summary:
				"Raise the memory limit (Advanced › Resources) or reduce memory usage, then redeploy.",
		},
		risk: "low",
		autoFixable: false,
	};
};

export const diskFullRule: Rule = (ctx) => {
	const lines = matchingLogLines(ctx, DISK_FULL);
	const tasks = recentFailedTasks(ctx).filter((t) =>
		DISK_FULL.test(t.error ?? ""),
	);
	if (lines.length === 0 && tasks.length === 0) return null;
	return {
		code: "DISK_FULL",
		title: "Disk full",
		description: `${label(ctx)} can no longer write: the server is out of disk space.`,
		severity: "critical",
		confidence: "high",
		evidence: [
			{
				source: lines.length ? "application_logs" : "docker_task",
				summary: "Write errors due to lack of space",
				excerpt: lines.length ? lines : tasks.map((t) => t.error ?? ""),
			},
		],
		probableCause:
			"The server disk is full (accumulated images, volumes, logs or backups).",
		recommendedFix: {
			summary:
				"Free up space on the server (Settings › Server › clean unused images and volumes, rotate logs), then restart the service.",
		},
		risk: "none",
		autoFixable: false,
	};
};

export const dataIncompatibleRule: Rule = (ctx) => {
	const engine = ctx.database?.engine;
	const pattern = engine ? DATA_INCOMPATIBLE[engine] : undefined;
	if (!pattern) return null;
	const lines = matchingLogLines(ctx, pattern);
	const previous = (ctx.previousAttemptLogs ?? [])
		.filter((line) => pattern.test(line))
		.slice(-5);
	if (lines.length === 0 && previous.length === 0) return null;
	return {
		code: "DATA_DIRECTORY_INCOMPATIBLE",
		title: "Data does not match the database version",
		description: `The data volume was created by a different version of ${engine} than the image ${ctx.database?.configuredImage}.`,
		severity: "critical",
		confidence: "high",
		evidence: [
			{
				source: "application_logs",
				summary: lines.length
					? "The database refuses to start on this data"
					: `Last attempt with ${ctx.database?.configuredImage}: the database rejected this data (Swarm rolled back to the previous image)`,
				excerpt: lines.length ? lines : previous,
			},
			{
				source: "dokploy_config",
				summary: `Configured image: ${ctx.database?.configuredImage}`,
			},
		],
		probableCause:
			"The image was switched to another major version while the volume holds data from the old version.",
		recommendedFix: {
			summary:
				"Go back to the previous version's image (Advanced › Docker image), then migrate the data (export/import or the database upgrade tool) before changing versions.",
			steps: [
				"Restore the previous image and redeploy: the database restarts on its data.",
				"Take a backup, then migrate to the new version following the engine's upgrade procedure.",
			],
		},
		risk: "medium",
		autoFixable: false,
	};
};

export const externalPortRule: Rule = (ctx) => {
	const external = ctx.database?.externalPort;
	const conflict = recentFailedTasks(ctx).filter((t) =>
		isPortInUseError(t.error),
	);
	if (conflict.length > 0) {
		return {
			code: "EXTERNAL_PORT_UNAVAILABLE",
			title: "External port already in use",
			description: `${label(ctx)} does not start: the port published on the server${external ? ` (${external})` : ""} is already taken by another service.`,
			severity: "critical",
			confidence: "high",
			evidence: [
				{
					source: "docker_task",
					summary: "Docker refuses to publish the port",
					excerpt: conflict.slice(0, 3).map((t) => t.error ?? ""),
				},
			],
			probableCause:
				"Another service or program on the server is already listening on this port.",
			recommendedFix: {
				summary:
					"Pick a free external port (or remove it if external access is not needed), then redeploy.",
			},
			risk: "low",
			autoFixable: false,
		};
	}
	if (!external || !ctx.service?.exists || ctx.config.publishedPorts.length > 0)
		return null;
	return {
		code: "EXTERNAL_PORT_UNAVAILABLE",
		title: "External port not published",
		description: `An external port (${external}) is configured, but the service does not publish it.`,
		severity: "warning",
		confidence: "high",
		evidence: [
			{
				source: "docker_service",
				summary: "No port published on the Swarm service",
			},
		],
		probableCause:
			"The external port was saved without redeploying the database.",
		recommendedFix: {
			summary: "Redeploy the database to publish the port.",
			action: { kind: "redeploy_service" },
		},
		risk: "low",
		autoFixable: true,
	};
};

/** Databases: the image set in Dokploy is not the one the service runs. */
export const configNotAppliedRule: Rule = (ctx) => {
	const configured = ctx.database?.configuredImage;
	const running = ctx.service?.image?.split("@")[0];
	if (!configured || !running || !ctx.service?.exists) return null;
	if (running === configured) return null;
	return {
		code: "CONFIG_NOT_APPLIED",
		title: "Configuration not applied",
		description: `The configured image is ${configured}, but the service is running ${running}.`,
		severity: "warning",
		confidence: "high",
		evidence: [
			{ source: "dokploy_config", summary: `Configured image: ${configured}` },
			{ source: "docker_service", summary: `Service image: ${running}` },
		],
		probableCause: "The image was changed without redeploying.",
		recommendedFix: {
			summary: "Redeploy to apply the new image.",
			action: { kind: "redeploy_service" },
		},
		risk: "medium",
		autoFixable: true,
	};
};

const lastExit = (ctx: DiagnosticContext) => {
	const code = ctx.tasks?.find((t) => t.exitCode !== undefined)?.exitCode;
	return code !== undefined ? ` (last exit code ${code})` : "";
};

export const serviceStoppedRule: Rule = (ctx) => {
	if (!ctx.service) return null;
	const stopped = !ctx.service.exists || ctx.service.desiredReplicas === 0;
	if (!stopped) return null;
	return {
		code: "SERVICE_STOPPED",
		title: ctx.service.exists ? "Service stopped" : "Service not deployed",
		description: !ctx.service.exists
			? `${label(ctx)} does not exist on the server yet.`
			: ctx.target.type === "compose"
				? `${label(ctx)} is stopped${lastExit(ctx)}.`
				: `${label(ctx)} is stopped (0 replicas requested).`,
		severity: "warning",
		confidence: "high",
		evidence: [
			{
				source: "docker_service",
				summary: !ctx.service.exists
					? "No service with this name"
					: ctx.target.type === "compose"
						? "Container stopped, no restart pending"
						: "Swarm service present with 0 replicas",
			},
		],
		probableCause: !ctx.service.exists
			? "The service was created but never deployed, or its deployment failed."
			: ctx.target.type === "compose"
				? "The container stopped (Docker or server restart, manual stop or error) and has no restart policy."
				: "The service was stopped from Dokploy.",
		recommendedFix: {
			summary: ctx.service.exists
				? "Start the service."
				: "Deploy the service.",
			action: { kind: "redeploy_service" },
		},
		risk: "low",
		autoFixable: true,
	};
};

export const RESOURCE_RULES: Rule[] = [
	imagePullFailedRule,
	outOfMemoryRule,
	diskFullRule,
	dataIncompatibleRule,
	externalPortRule,
	configNotAppliedRule,
];

const COMPOSE_UNSET_VARIABLE =
	/The \\?"?([A-Za-z_][A-Za-z0-9_]*)\\?"? variable is not set\. Defaulting to a blank string/;

/** Compose stacks: variables the compose file uses but Dokploy does not define. */
export const composeVariablesRule: Rule = (ctx) => {
	const configured = new Set(ctx.config.envKeys);
	const lines: string[] = [];
	const names = new Set<string>();
	for (const line of ctx.latestDeployment?.logTail ?? []) {
		const name = COMPOSE_UNSET_VARIABLE.exec(line)?.[1];
		if (name && !configured.has(name)) {
			names.add(name);
			if (!lines.includes(line)) lines.push(line);
		}
	}
	if (names.size === 0) return null;
	const keys = [...names];
	return {
		code: "MISSING_ENVIRONMENT_VARIABLE",
		title:
			keys.length > 1
				? "Variables not defined for the compose"
				: "Variable not defined for the compose",
		description: `The compose file uses ${keys.join(", ")}, missing from the Dokploy environment: Docker replaced ${keys.length > 1 ? "them" : "it"} with an empty string.`,
		severity: "error",
		confidence: "high",
		evidence: [
			{
				source: "build_logs",
				summary: "docker compose warnings during deployment",
				excerpt: lines.slice(-5),
			},
		],
		probableCause:
			"Variables referenced in the compose file (${VAR}) have no value in the Environment tab.",
		recommendedFix: {
			summary: `Define ${keys.join(", ")} in the compose's Environment tab, then redeploy.`,
			action: { kind: "set_environment_variables", keys },
		},
		risk: "low",
		autoFixable: false,
	};
};
