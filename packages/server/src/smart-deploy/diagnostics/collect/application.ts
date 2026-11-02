import { readFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import type { findApplicationById } from "@dokploy/server/services/application";
import { getEnvironmentVariablesObject } from "@dokploy/server/utils/docker/utils";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import type Dockerode from "dockerode";
import { parseEnvFileKeys, parseExitCode } from "../log-patterns";
import { parseProcNetTcp } from "../proc-net";
import { createRedactor, type Redactor, redactLines } from "../redact";
import type {
	ContainerFact,
	DiagnosticContext,
	EvidenceSource,
	ProbeResult,
	TaskFact,
} from "../types";
import {
	demuxDockerOutput,
	execCapture,
	findTraefikContainerId,
	isSafeHostname,
	probeFromTraefik,
	safePath,
	withTimeout,
} from "./docker-io";

type Application = Awaited<ReturnType<typeof findApplicationById>>;

const SAFE_FILE_PATH = /^[A-Za-z0-9_./-]+$/;
const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template"];
const LOG_TAIL_LINES = 60;
const BUILD_LOG_TAIL_LINES = 200;

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message.slice(0, 300) : String(error);

const isNotFound = (error: unknown) =>
	(error as { statusCode?: number })?.statusCode === 404;

const readTextFile = async (
	filePath: string,
	serverId: string | null,
	tailLines?: number,
): Promise<string | null> => {
	if (!SAFE_FILE_PATH.test(filePath)) return null;
	if (!serverId) {
		try {
			const content = await readFile(filePath, "utf8");
			return tailLines
				? content.split("\n").slice(-tailLines).join("\n")
				: content.slice(0, 64_000);
		} catch {
			return null;
		}
	}
	const command = tailLines
		? `tail -n ${tailLines} '${filePath}' 2>/dev/null || true`
		: `head -c 64000 '${filePath}' 2>/dev/null || true`;
	const { stdout } = await execAsyncRemote(serverId, command);
	return stdout || null;
};

const resolveEnv = (application: Application): Record<string, string> => {
	try {
		return getEnvironmentVariablesObject(
			application.env,
			application.environment.project.env,
			application.environment.env,
		);
	} catch {
		const keys = parseEnvFileKeys(application.env ?? "");
		return Object.fromEntries(keys.map((key) => [key, ""]));
	}
};

const sourceBuildPath = (application: Application) => {
	switch (application.sourceType) {
		case "github":
			return application.buildPath;
		case "gitlab":
			return application.gitlabBuildPath;
		case "bitbucket":
			return application.bitbucketBuildPath;
		case "gitea":
			return application.giteaBuildPath;
		case "drop":
			return application.dropBuildPath;
		case "git":
			return application.customGitBuildPath;
		default:
			return "";
	}
};

const collectTasks = async (
	docker: Dockerode,
	appName: string,
): Promise<TaskFact[]> => {
	const tasks = await docker.listTasks({
		filters: JSON.stringify({ service: [appName] }),
	});
	return tasks
		.map((task) => {
			const status = task.Status ?? {};
			const exitCode =
				status.ContainerStatus?.ExitCode ?? parseExitCode(status.Err);
			return {
				state: status.State ?? "unknown",
				desiredState: task.DesiredState ?? "unknown",
				timestamp: status.Timestamp ?? task.UpdatedAt ?? task.CreatedAt,
				error: status.Err || undefined,
				exitCode:
					exitCode === 0 && status.State !== "complete" ? undefined : exitCode,
				containerId: status.ContainerStatus?.ContainerID || undefined,
			};
		})
		.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
		.slice(0, 20);
};

const collectContainer = async (
	docker: Dockerode,
	containerId: string,
	now: Date,
	redact: Redactor,
): Promise<{
	container: ContainerFact;
	exposed: number[];
	envKeys: string[];
}> => {
	const info = await docker.getContainer(containerId).inspect();
	const health = info.State?.Health;
	const lastLog = health?.Log?.[health.Log.length - 1];
	const startedAt = info.State?.StartedAt ?? now.toISOString();
	return {
		container: {
			id: info.Id,
			startedAt,
			uptimeSeconds: Math.max(
				0,
				Math.round((now.getTime() - new Date(startedAt).getTime()) / 1000),
			),
			health: {
				status: (health?.Status as ContainerFact["health"]["status"]) ?? "none",
				failingStreak: health?.FailingStreak ?? 0,
				lastExitCode: lastLog?.ExitCode,
				lastOutput: lastLog?.Output
					? redactLines(lastLog.Output.split("\n"), redact, 5)
					: undefined,
			},
		},
		exposed: Object.keys(info.Config?.ExposedPorts ?? {})
			.filter((key) => key.endsWith("/tcp"))
			.map((key) => Number.parseInt(key, 10)),
		envKeys: (info.Config?.Env ?? []).map((pair) => pair.split("=")[0] ?? ""),
	};
};

const collectListening = async (docker: Dockerode, containerId: string) => {
	const { exitCode, output } = await execCapture(docker, containerId, [
		"cat",
		"/proc/net/tcp",
		"/proc/net/tcp6",
	]);
	// tcp6 is missing when IPv6 is disabled; cat still prints tcp and exits 1.
	if (!output.includes("local_address")) {
		throw new Error(
			`cannot read /proc/net/tcp in the container (exit ${exitCode}); the image may not ship 'cat'`,
		);
	}
	return parseProcNetTcp(output);
};

const collectServiceLogs = async (
	docker: Dockerode,
	appName: string,
	redact: Redactor,
): Promise<string[]> => {
	const raw = (await withTimeout(
		docker.getService(appName).logs({
			stdout: true,
			stderr: true,
			tail: LOG_TAIL_LINES,
			follow: false,
			timestamps: false,
		}) as unknown as Promise<Buffer | string>,
		10_000,
		"service logs",
	)) as Buffer | string;
	const text = Buffer.isBuffer(raw) ? demuxDockerOutput(raw) : String(raw);
	return redactLines(text.split("\n"), redact, LOG_TAIL_LINES);
};

const collectProbes = async (
	docker: Dockerode,
	application: Application,
	push: (source: EvidenceSource, message: string) => void,
): Promise<ProbeResult[]> => {
	const traefikId = await findTraefikContainerId(docker);
	if (!traefikId) {
		push("proxy_probe", "Traefik container not found; proxy checks skipped");
		return [];
	}
	const probes: ProbeResult[] = [];
	for (const domain of application.domains.slice(0, 5)) {
		if (!isSafeHostname(domain.host) || !domain.port) continue;
		const urlPath = safePath(domain.path);
		const backendUrl = `http://${application.appName}:${domain.port}${urlPath}`;
		const routerUrl = `http://127.0.0.1:80${urlPath}`;
		const [backend, router] = await Promise.all([
			probeFromTraefik(docker, traefikId, backendUrl),
			probeFromTraefik(docker, traefikId, routerUrl, domain.host),
		]);
		probes.push(
			{
				kind: "backend",
				target: backendUrl,
				domainId: domain.domainId,
				...backend,
			},
			{
				kind: "router",
				target: `${domain.host}${urlPath} (entrypoint web)`,
				domainId: domain.domainId,
				...router,
			},
		);
	}
	return probes;
};

/**
 * Gathers read-only facts about an application. Every step is isolated: a
 * failure is recorded in `collectionErrors` and the related facts stay
 * undefined, so rules never conclude from missing data.
 */
export const collectApplicationContext = async (
	application: Application,
	options: { now?: Date; probes?: boolean } = {},
): Promise<DiagnosticContext> => {
	const now = options.now ?? new Date();
	const { appName, serverId } = application;
	const env = resolveEnv(application);
	const redact = createRedactor(env);

	const ctx: DiagnosticContext = {
		now,
		target: {
			type: "application",
			id: application.applicationId,
			name: application.name,
			appName,
			serverId: serverId ?? null,
		},
		config: {
			domains: application.domains.map((domain) => ({
				domainId: domain.domainId,
				host: domain.host,
				port: domain.port ?? null,
				path: domain.path ?? null,
				https: domain.https,
			})),
			publishedPorts: application.ports.map((port) => ({
				publishedPort: port.publishedPort,
				targetPort: port.targetPort,
				protocol: port.protocol,
			})),
			envKeys: Object.keys(env),
			swarmHealthcheckConfigured: !!application.healthCheckSwarm?.Test?.length,
		},
		collectionErrors: [],
	};
	const fail = (source: EvidenceSource, error: unknown) =>
		ctx.collectionErrors.push({ source, message: errorMessage(error) });

	const latest = [...application.deployments].sort((a, b) =>
		b.createdAt.localeCompare(a.createdAt),
	)[0];
	ctx.latestDeployment = latest
		? {
				deploymentId: latest.deploymentId,
				status: latest.status,
				createdAt: latest.createdAt,
				errorMessage: latest.errorMessage ? redact(latest.errorMessage) : null,
			}
		: null;
	if (latest && ctx.latestDeployment && latest.status === "error") {
		try {
			const tail = await readTextFile(
				latest.logPath,
				application.buildServerId || serverId,
				BUILD_LOG_TAIL_LINES,
			);
			if (tail)
				ctx.latestDeployment.logTail = redactLines(
					tail.split("\n"),
					redact,
					BUILD_LOG_TAIL_LINES,
				);
		} catch (error) {
			fail("build_logs", error);
		}
	}

	let docker: Dockerode;
	try {
		docker = await getRemoteDocker(serverId);
	} catch (error) {
		fail("docker_service", error);
		return ctx;
	}

	try {
		const info = await docker.getService(appName).inspect();
		ctx.service = {
			exists: true,
			desiredReplicas: info.Spec?.Mode?.Replicated?.Replicas ?? 1,
			image: info.Spec?.TaskTemplate?.ContainerSpec?.Image,
		};
	} catch (error) {
		if (isNotFound(error)) ctx.service = { exists: false, desiredReplicas: 0 };
		else fail("docker_service", error);
	}
	if (!ctx.service?.exists) return ctx;

	try {
		ctx.tasks = await collectTasks(docker, appName);
	} catch (error) {
		fail("docker_task", error);
	}

	const runningContainerId = ctx.tasks?.find(
		(task) => task.state === "running" && task.containerId,
	)?.containerId;

	if (runningContainerId) {
		try {
			const { container, exposed, envKeys } = await collectContainer(
				docker,
				runningContainerId,
				now,
				redact,
			);
			ctx.container = container;
			ctx.imageExposedPorts = exposed;
			ctx.config.envKeys = [...new Set([...ctx.config.envKeys, ...envKeys])];
		} catch (error) {
			// On multi-node swarms the task may run on a node this daemon can't inspect.
			fail("docker_container", error);
		}
		if (ctx.container) {
			try {
				ctx.listening = await collectListening(docker, runningContainerId);
			} catch (error) {
				fail("listening_sockets", error);
			}
		}
	} else if (ctx.tasks) {
		ctx.container = null;
	}

	if (ctx.imageExposedPorts === undefined && ctx.service.image) {
		try {
			const image = await docker
				.getImage(ctx.service.image.split("@")[0] ?? ctx.service.image)
				.inspect();
			ctx.imageExposedPorts = Object.keys(image.Config?.ExposedPorts ?? {})
				.filter((key) => key.endsWith("/tcp"))
				.map((key) => Number.parseInt(key, 10));
		} catch (error) {
			fail("docker_image", error);
		}
	}

	try {
		ctx.logs = await collectServiceLogs(docker, appName, redact);
	} catch (error) {
		fail("application_logs", error);
	}

	const codeDir = path.join(
		paths(!!(application.buildServerId || serverId)).APPLICATIONS_PATH,
		appName,
		"code",
		sourceBuildPath(application) ?? "",
	);
	for (const fileName of ENV_EXAMPLE_FILES) {
		try {
			const content = await readTextFile(
				path.join(codeDir, fileName),
				application.buildServerId || serverId,
			);
			if (content) {
				ctx.envExampleKeys = parseEnvFileKeys(content);
				break;
			}
		} catch (error) {
			fail("repository", error);
			break;
		}
	}

	if (options.probes !== false && ctx.config.domains.length > 0) {
		try {
			ctx.probes = await collectProbes(docker, application, (source, message) =>
				ctx.collectionErrors.push({ source, message }),
			);
		} catch (error) {
			fail("proxy_probe", error);
		}
	}

	return ctx;
};
