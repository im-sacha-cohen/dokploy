import path from "node:path";
import { paths } from "@dokploy/server/constants";
import type { findApplicationById } from "@dokploy/server/services/application";
import { getEnvironmentVariablesObject } from "@dokploy/server/utils/docker/utils";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import type Dockerode from "dockerode";
import { getRemoteHead } from "../../versioning/remote-head";
import { parseEnvFileKeys } from "../log-patterns";
import { createRedactor, redactLines } from "../redact";
import type { DiagnosticContext, EvidenceSource, ProbeResult } from "../types";
import {
	findTraefikContainerId,
	isSafeHostname,
	probeFromTraefik,
	safePath,
} from "./docker-io";
import { collectSwarmService, errorMessage, readTextFile } from "./swarm";

type Application = Awaited<ReturnType<typeof findApplicationById>>;

const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template"];
const BUILD_LOG_TAIL_LINES = 200;

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
	options: { now?: Date; probes?: boolean; remote?: boolean } = {},
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
	const toTracked = (d: (typeof application.deployments)[number]) => ({
		deploymentId: d.deploymentId,
		createdAt: d.createdAt,
		status: d.status,
		kind: d.kind,
		imageId: d.imageId,
		imageTag: d.imageTag,
		builtCommitSha: d.builtCommitSha,
	});
	ctx.version = { latest: latest ? toTracked(latest) : null, running: null };
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

	await collectSwarmService(docker, appName, ctx, redact);
	if (!ctx.service?.exists) return ctx;

	const runningImageId = ctx.container?.imageId;
	const runningDeployment = runningImageId
		? application.deployments
				.filter((d) => d.status === "done" && d.imageId === runningImageId)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
		: undefined;
	if (ctx.version && runningDeployment) {
		ctx.version.running = toTracked(runningDeployment);
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

	if (options.remote !== false && ctx.version?.running?.builtCommitSha) {
		const head = await getRemoteHead(application);
		if (ctx.version) {
			ctx.version.remoteHead =
				head.status === "ok"
					? {
							status: "ok",
							sha: head.sha,
							branch: head.branch,
							checkedAt: head.checkedAt,
						}
					: head;
		}
		if (head.status === "error") fail("repository", head.reason);
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
