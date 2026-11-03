import {
	describeExitCode,
	extractMissingEnvNames,
	selectBuildErrorLines,
} from "../log-patterns";
import { externallyReachablePorts, isLoopback } from "../proc-net";
import type { DiagnosticContext, Finding, Rule, TaskFact } from "../types";

const CRASH_WINDOW_MS = 10 * 60 * 1000;
/** Before this, an app that is not yet listening may simply still be booting. */
export const LISTEN_GRACE_SECONDS = 20;

const FAILED_STATES = new Set(["failed", "rejected"]);

export const recentFailedTasks = (ctx: DiagnosticContext): TaskFact[] =>
	(ctx.tasks ?? []).filter(
		(task) =>
			FAILED_STATES.has(task.state) &&
			ctx.now.getTime() - new Date(task.timestamp).getTime() <= CRASH_WINDOW_MS,
	);

export const runningTasks = (ctx: DiagnosticContext): TaskFact[] =>
	(ctx.tasks ?? []).filter((task) => task.state === "running");

const isListeningSettled = (ctx: DiagnosticContext) =>
	!!ctx.container &&
	ctx.container.uptimeSeconds >= LISTEN_GRACE_SECONDS &&
	ctx.listening !== undefined;

export const buildFailedRule: Rule = (ctx) => {
	const deployment = ctx.latestDeployment;
	if (deployment?.status !== "error") return null;

	const logLines = selectBuildErrorLines(deployment.logTail ?? []);
	return {
		code: "BUILD_FAILED",
		title: "Last deployment failed",
		description:
			"The last deployment ended with an error. The running container, if any, comes from a previous deployment.",
		severity: "critical",
		confidence: "high",
		evidence: [
			{
				source: "deployment",
				summary: `Deployment ${deployment.deploymentId} from ${deployment.createdAt}: status "error"${deployment.errorMessage ? ` (${deployment.errorMessage.slice(0, 200)})` : ""}`,
			},
			...(logLines.length
				? [
						{
							source: "build_logs" as const,
							summary: "Last relevant lines of the build log",
							excerpt: logLines,
						},
					]
				: []),
		],
		probableCause:
			"Error while cloning, installing dependencies, compiling or building the image (see the log lines).",
		recommendedFix: {
			summary: "Fix the error shown in the build log, then deploy again.",
		},
		risk: "none",
		autoFixable: false,
	};
};

export const crashLoopRule: Rule = (ctx) => {
	if (!ctx.tasks) return null;
	const failed = recentFailedTasks(ctx);
	const running = runningTasks(ctx);
	if (failed.length < 2) return null;
	if (running.length > 0 && failed.length < 3) return null;

	const exitCodes = [
		...new Set(failed.map((t) => t.exitCode).filter((c) => c !== undefined)),
	] as number[];
	const healthKills = failed.filter((t) => /unhealthy/i.test(t.error ?? ""));
	const flapping = running.length > 0;

	const evidence: Finding["evidence"] = [
		{
			source: "docker_task",
			summary: `${failed.length} failed tasks in the last 10 minutes, ${running.length} running`,
			excerpt: failed
				.slice(0, 5)
				.map(
					(t) => `${t.timestamp} ${t.state}${t.error ? `: ${t.error}` : ""}`,
				),
		},
	];
	if (ctx.logs?.length) {
		evidence.push({
			source: "application_logs",
			summary: "Last application log lines",
			excerpt: ctx.logs.slice(-10),
		});
	}

	const causes = exitCodes.map((code) => `${code}: ${describeExitCode(code)}`);
	const probableCause =
		healthKills.length > 0
			? 'Swarm replaces the containers that the healthcheck marks as "unhealthy".'
			: causes.length > 0
				? `The application exits on startup (exit code ${causes.join("; ")}).`
				: "The application exits on startup.";

	return {
		code: "CONTAINER_CRASH_LOOP",
		title: flapping
			? "Container restarts regularly"
			: "Container is crash-looping",
		description: flapping
			? "A task is currently running, but several tasks failed recently."
			: "No task stays running: Swarm restarts the container every few seconds.",
		severity: flapping ? "warning" : "critical",
		confidence: flapping ? "medium" : "high",
		evidence,
		probableCause,
		recommendedFix: {
			summary:
				"Read the application logs to find the startup error, fix it, then redeploy.",
		},
		risk: "none",
		autoFixable: false,
	};
};

export const missingEnvRule: Rule = (ctx) => {
	const configured = new Set(ctx.config.envKeys);
	const fromLogs = ctx.logs ? extractMissingEnvNames(ctx.logs) : null;
	const logMissing = (fromLogs?.names ?? []).filter((n) => !configured.has(n));
	const exampleMissing = (ctx.envExampleKeys ?? []).filter(
		(key) => !configured.has(key) && !logMissing.includes(key),
	);

	if (logMissing.length === 0 && exampleMissing.length === 0) return null;

	const isFailing = recentFailedTasks(ctx).length > 0;
	const keys = [...logMissing, ...exampleMissing];
	const evidence: Finding["evidence"] = [];

	if (logMissing.length > 0 && fromLogs) {
		evidence.push({
			source: "application_logs",
			summary: `The application reports missing variables: ${logMissing.join(", ")}`,
			excerpt: fromLogs.matchedLines,
		});
	}
	if (exampleMissing.length > 0) {
		evidence.push({
			source: "repository",
			summary: `Declared in .env.example but missing from the configuration: ${exampleMissing.join(", ")}`,
		});
	}
	evidence.push({
		source: "dokploy_config",
		summary: `${ctx.config.envKeys.length} variable(s) configured in Dokploy (names only, values are never included in the report)`,
	});

	const confidence =
		logMissing.length > 0 ? "high" : isFailing ? "medium" : "low";

	return {
		code: "MISSING_ENVIRONMENT_VARIABLE",
		title:
			keys.length > 1
				? "Missing environment variables"
				: "Missing environment variable",
		description: `Variables expected by the application but missing from the Dokploy configuration: ${keys.join(", ")}.`,
		severity: logMissing.length > 0 ? "critical" : isFailing ? "error" : "info",
		confidence,
		evidence,
		probableCause:
			logMissing.length > 0
				? "The application refuses to start without these variables."
				: "The repository documents these variables; they are not defined in Dokploy.",
		recommendedFix: {
			summary: `Define ${keys.join(", ")} in the application's Environment tab, then redeploy.`,
			action: { kind: "set_environment_variables", keys },
		},
		risk: "low",
		// Values are secrets only the user can provide.
		autoFixable: false,
	};
};

export const healthcheckRule: Rule = (ctx) => {
	const health = ctx.container?.health;
	const killedByHealth = recentFailedTasks(ctx).filter((t) =>
		/unhealthy/i.test(t.error ?? ""),
	);
	if (health?.status !== "unhealthy" && killedByHealth.length === 0)
		return null;

	const evidence: Finding["evidence"] = [];
	if (health?.status === "unhealthy") {
		evidence.push({
			source: "docker_container",
			summary: `Healthcheck failed ${health.failingStreak} times in a row${health.lastExitCode !== undefined ? ` (last code ${health.lastExitCode})` : ""}`,
			excerpt: health.lastOutput,
		});
	}
	if (killedByHealth.length > 0) {
		evidence.push({
			source: "docker_task",
			summary: `${killedByHealth.length} task(s) stopped by Swarm because of the healthcheck`,
		});
	}

	return {
		code: "HEALTHCHECK_FAILED",
		title: "Healthcheck failing",
		description: "The container is running but its healthcheck command fails.",
		severity: "error",
		confidence: "high",
		evidence,
		probableCause:
			"The path or port tested by the healthcheck does not respond, or the tool it uses (curl, wget) is missing from the image.",
		recommendedFix: {
			summary:
				"Check the HEALTHCHECK command (Dockerfile or Swarm Settings): port, path, and that the tool exists in the image.",
		},
		risk: "low",
		autoFixable: false,
	};
};

export const notListeningRule: Rule = (ctx) => {
	if (!isListeningSettled(ctx) || !ctx.listening) return null;
	if (ctx.listening.length > 0) return null;

	return {
		code: "APPLICATION_NOT_LISTENING",
		title: "Application not listening on any port",
		description: `The container has been running for ${ctx.container?.uptimeSeconds}s but no TCP socket is listening.`,
		severity: "critical",
		confidence: "high",
		evidence: [
			{
				source: "listening_sockets",
				summary:
					"No TCP socket in LISTEN state in the container's network namespace",
			},
		],
		probableCause:
			"The start command does not run a server (worker, finished script, wrong entrypoint) or the server waits for a resource before listening.",
		recommendedFix: {
			summary:
				"Check the start command and the logs; if this is a worker without HTTP, remove its domain.",
		},
		risk: "none",
		autoFixable: false,
	};
};

export const localhostBindRule: Rule = (ctx) => {
	if (!isListeningSettled(ctx) || !ctx.listening?.length) return null;
	if (externallyReachablePorts(ctx.listening).length > 0) return null;

	const loopback = ctx.listening.filter((s) => isLoopback(s.address));
	return {
		code: "APPLICATION_LISTENING_ON_LOCALHOST",
		title: "Application only listening on localhost",
		description: `The application listens on ${loopback.map((s) => `${s.address}:${s.port}`).join(", ")}: these addresses are only reachable from inside the container, not by Traefik.`,
		severity: "critical",
		confidence: "high",
		evidence: [
			{
				source: "listening_sockets",
				summary: "Listening sockets in the container",
				excerpt: ctx.listening.map(
					(s) => `${s.address}:${s.port} (${s.family})`,
				),
			},
		],
		probableCause:
			"The server is bound to 127.0.0.1 (the default for many development servers).",
		recommendedFix: {
			summary:
				'Make the application listen on 0.0.0.0 (for example HOST=0.0.0.0, --host 0.0.0.0 or listen(port, "0.0.0.0")), then redeploy.',
		},
		risk: "low",
		autoFixable: false,
	};
};
