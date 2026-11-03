import { findComposeById } from "@dokploy/server/services/compose";
import { getEnvironmentVariablesObject } from "@dokploy/server/utils/docker/utils";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import type Dockerode from "dockerode";
import { parseEnvFileKeys } from "../log-patterns";
import { createRedactor, type Redactor, redactLines } from "../redact";
import type {
	DiagnosticContext,
	DomainFact,
	ProbeResult,
	TaskFact,
} from "../types";
import {
	findTraefikContainerId,
	isSafeHostname,
	probeFromTraefik,
	safePath,
} from "./docker-io";
import {
	collectContainer,
	collectContainerLogs,
	collectListening,
	collectSwarmService,
	errorMessage,
	readTextFile,
} from "./swarm";

type Compose = Awaited<ReturnType<typeof findComposeById>>;

const DEPLOYMENT_LOG_TAIL_LINES = 200;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
// Compose service names come from the user's compose file.
const SAFE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const resolveEnv = (compose: Compose): Record<string, string> => {
	try {
		return getEnvironmentVariablesObject(
			compose.env,
			compose.environment.project.env,
			compose.environment.env,
		);
	} catch {
		return Object.fromEntries(
			parseEnvFileKeys(compose.env ?? "").map((key) => [key, ""]),
		);
	}
};

const toDomainFact = (domain: Compose["domains"][number]): DomainFact => ({
	domainId: domain.domainId,
	host: domain.host,
	port: domain.port ?? null,
	path: domain.path ?? null,
	https: domain.https,
	serviceName: domain.serviceName ?? null,
});

const emptyContext = (
	compose: Compose,
	now: Date,
	envKeys: string[],
	service?: string,
	domains: DomainFact[] = [],
): DiagnosticContext => ({
	now,
	target: {
		type: "compose",
		id: compose.composeId,
		name: compose.name,
		appName: compose.appName,
		serverId: compose.serverId ?? null,
		...(service ? { service } : {}),
	},
	config: {
		domains,
		publishedPorts: [],
		envKeys,
		swarmHealthcheckConfigured: false,
	},
	collectionErrors: [],
});

/**
 * Plain `docker compose` has no task history: a restarting or failed container
 * is turned into failed task facts so the Swarm-oriented rules apply to it.
 */
export const containerToTasks = (
	state: {
		Status?: string;
		Running?: boolean;
		Restarting?: boolean;
		ExitCode?: number;
		OOMKilled?: boolean;
		FinishedAt?: string;
		Error?: string;
	},
	containerId: string,
	restartCount: number,
	now: Date,
): TaskFact[] => {
	const tasks: TaskFact[] = [];
	const finishedAt = state.FinishedAt ?? now.toISOString();
	const recent =
		now.getTime() - new Date(finishedAt).getTime() <= CRASH_WINDOW_MS;
	const failedExit = state.ExitCode !== undefined && state.ExitCode !== 0;
	if (state.Running && !state.Restarting) {
		tasks.push({
			state: "running",
			desiredState: "running",
			timestamp: now.toISOString(),
			containerId,
		});
	}
	if ((state.Restarting || failedExit || state.OOMKilled) && recent) {
		const failures = Math.min(
			Math.max(restartCount, state.Restarting ? 2 : 1),
			5,
		);
		for (let i = 0; i < failures; i++) {
			tasks.push({
				state: "failed",
				desiredState: "running",
				timestamp: finishedAt,
				exitCode: state.ExitCode,
				error: state.Error || `exit code ${state.ExitCode ?? "?"}`,
			});
		}
	}
	if (tasks.length === 0) {
		tasks.push({
			state:
				state.Status === "exited" ? "complete" : (state.Status ?? "unknown"),
			desiredState: "running",
			timestamp: finishedAt,
			exitCode: state.ExitCode,
		});
	}
	return tasks;
};

const probeDomains = async (
	docker: Dockerode,
	traefikId: string | null,
	domains: DomainFact[],
	backendHost: string | null,
): Promise<ProbeResult[]> => {
	if (!traefikId) return [];
	const probes: ProbeResult[] = [];
	for (const domain of domains.slice(0, 5)) {
		if (!isSafeHostname(domain.host) || !domain.port) continue;
		const urlPath = safePath(domain.path);
		const routerUrl = `http://127.0.0.1:80${urlPath}`;
		const backendUrl = backendHost
			? `http://${backendHost}:${domain.port}${urlPath}`
			: null;
		const [backend, router] = await Promise.all([
			backendUrl
				? probeFromTraefik(docker, traefikId, backendUrl)
				: Promise.resolve(null),
			probeFromTraefik(docker, traefikId, routerUrl, domain.host),
		]);
		if (backend && backendUrl) {
			probes.push({
				kind: "backend",
				target: backendUrl,
				domainId: domain.domainId,
				...backend,
			});
		}
		probes.push({
			kind: "router",
			target: `${domain.host}${urlPath} (entrypoint web)`,
			domainId: domain.domainId,
			...router,
		});
	}
	return probes;
};

const collectComposeContainers = async (
	docker: Dockerode,
	compose: Compose,
	envKeys: string[],
	domains: DomainFact[],
	redact: Redactor,
	now: Date,
	traefikId: string | null,
) => {
	const containers = await docker.listContainers({
		all: true,
		filters: JSON.stringify({
			label: [`com.docker.compose.project=${compose.appName}`],
		}),
	});
	const newestByService = new Map<string, (typeof containers)[number]>();
	for (const container of containers.sort((a, b) => b.Created - a.Created)) {
		const service = container.Labels?.["com.docker.compose.service"];
		if (
			service &&
			SAFE_SERVICE.test(service) &&
			!newestByService.has(service)
		) {
			newestByService.set(service, container);
		}
	}

	const names = new Set([
		...newestByService.keys(),
		...domains.flatMap((d) => (d.serviceName ? [d.serviceName] : [])),
	]);
	const contexts: DiagnosticContext[] = [];
	for (const name of [...names].sort()) {
		const serviceDomains = domains.filter((d) => d.serviceName === name);
		const ctx = emptyContext(compose, now, envKeys, name, serviceDomains);
		contexts.push(ctx);
		const listed = newestByService.get(name);
		if (!listed) {
			ctx.service = { exists: false, desiredReplicas: 1 };
			continue;
		}
		const fail = (
			source: Parameters<typeof ctx.collectionErrors.push>[0]["source"],
			error: unknown,
		) => ctx.collectionErrors.push({ source, message: errorMessage(error) });
		try {
			const {
				container,
				info,
				exposed,
				envKeys: containerEnv,
			} = await collectContainer(docker, listed.Id, now, redact);
			const running = !!info.State?.Running && !info.State?.Restarting;
			// A stopped container with no restart pending: down if it failed or
			// serves a domain; a job that exited 0 just finished its work.
			const stopped =
				!info.State?.Running &&
				!info.State?.Restarting &&
				(info.State?.ExitCode !== 0 || serviceDomains.length > 0);
			ctx.service = {
				exists: true,
				desiredReplicas: stopped ? 0 : 1,
				image: info.Config?.Image,
			};
			ctx.tasks = containerToTasks(
				info.State ?? {},
				info.Id,
				info.RestartCount ?? 0,
				now,
			);
			ctx.container = running ? container : null;
			ctx.restartCount = info.RestartCount ?? 0;
			ctx.imageExposedPorts = exposed;
			ctx.config.envKeys = [
				...new Set([...ctx.config.envKeys, ...containerEnv]),
			];
			if (running && serviceDomains.length > 0) {
				try {
					ctx.listening = await collectListening(docker, info.Id);
				} catch (error) {
					fail("listening_sockets", error);
				}
			}
			if (serviceDomains.length > 0) {
				const networks = info.NetworkSettings?.Networks ?? {};
				const ip =
					networks["dokploy-network"]?.IPAddress ||
					Object.values(networks).find((n) => n?.IPAddress)?.IPAddress ||
					null;
				try {
					ctx.probes = await probeDomains(
						docker,
						traefikId,
						serviceDomains,
						running ? ip : null,
					);
				} catch (error) {
					fail("proxy_probe", error);
				}
			}
		} catch (error) {
			fail("docker_container", error);
		}
		try {
			ctx.logs = await collectContainerLogs(docker, listed.Id, redact);
		} catch (error) {
			fail("application_logs", error);
		}
	}
	return contexts;
};

const collectStackServices = async (
	docker: Dockerode,
	compose: Compose,
	envKeys: string[],
	domains: DomainFact[],
	redact: Redactor,
	now: Date,
	traefikId: string | null,
) => {
	const services = await docker.listServices({
		filters: JSON.stringify({
			label: [`com.docker.stack.namespace=${compose.appName}`],
		}),
	});
	const prefix = `${compose.appName}_`;
	const names = new Set([
		...services
			.map((s) => s.Spec?.Name ?? "")
			.filter((n) => n.startsWith(prefix))
			.map((n) => n.slice(prefix.length))
			.filter((n) => SAFE_SERVICE.test(n)),
		...domains.flatMap((d) => (d.serviceName ? [d.serviceName] : [])),
	]);
	const contexts: DiagnosticContext[] = [];
	for (const name of [...names].sort()) {
		const serviceDomains = domains.filter((d) => d.serviceName === name);
		const ctx = emptyContext(compose, now, envKeys, name, serviceDomains);
		contexts.push(ctx);
		await collectSwarmService(docker, `${prefix}${name}`, ctx, redact);
		if (ctx.service?.exists && serviceDomains.length > 0) {
			try {
				ctx.probes = await probeDomains(
					docker,
					traefikId,
					serviceDomains,
					`${prefix}${name}`,
				);
			} catch (error) {
				ctx.collectionErrors.push({
					source: "proxy_probe",
					message: errorMessage(error),
				});
			}
		}
	}
	return contexts;
};

/** Read-only facts about a compose stack and each of its services. */
export const collectComposeContexts = async (
	composeId: string,
	options: { now?: Date; probes?: boolean } = {},
) => {
	const compose = await findComposeById(composeId);
	const now = options.now ?? new Date();
	const env = resolveEnv(compose);
	const redact = createRedactor(env);
	const domains = compose.domains.map(toDomainFact);
	const envKeys = Object.keys(env);

	const stack = emptyContext(compose, now, envKeys, undefined, domains);
	const latest = [...compose.deployments].sort((a, b) =>
		b.createdAt.localeCompare(a.createdAt),
	)[0];
	stack.latestDeployment = latest
		? {
				deploymentId: latest.deploymentId,
				status: latest.status,
				createdAt: latest.createdAt,
				errorMessage: latest.errorMessage ? redact(latest.errorMessage) : null,
			}
		: null;
	if (latest && stack.latestDeployment) {
		try {
			const tail = await readTextFile(
				latest.logPath,
				compose.serverId ?? null,
				DEPLOYMENT_LOG_TAIL_LINES,
			);
			if (tail) {
				const lines = redactLines(
					tail.split("\n"),
					redact,
					DEPLOYMENT_LOG_TAIL_LINES,
				);
				stack.latestDeployment.logTail = lines;
				stack.logs = lines;
			}
		} catch (error) {
			stack.collectionErrors.push({
				source: "build_logs",
				message: errorMessage(error),
			});
		}
	}

	let services: DiagnosticContext[] = [];
	try {
		const docker = await getRemoteDocker(compose.serverId);
		const traefikId =
			options.probes === false || domains.length === 0
				? null
				: await findTraefikContainerId(docker).catch(() => null);
		services =
			compose.composeType === "stack"
				? await collectStackServices(
						docker,
						compose,
						envKeys,
						domains,
						redact,
						now,
						traefikId,
					)
				: await collectComposeContainers(
						docker,
						compose,
						envKeys,
						domains,
						redact,
						now,
						traefikId,
					);
	} catch (error) {
		stack.collectionErrors.push({
			source: "docker_service",
			message: errorMessage(error),
		});
	}
	return { stack, services };
};
