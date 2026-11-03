// Read-only collectors shared by every kind of service: a Swarm service
// (applications, databases, stack services) or a plain container (compose).
import { readFile } from "node:fs/promises";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import type Dockerode from "dockerode";
import { parseExitCode } from "../log-patterns";
import { parseProcNetTcp } from "../proc-net";
import { type Redactor, redactLines } from "../redact";
import type {
	ContainerFact,
	DiagnosticContext,
	EvidenceSource,
	TaskFact,
} from "../types";
import {
	demuxDockerOutput,
	execCapture,
	findTraefikContainerId,
	withTimeout,
} from "./docker-io";

// Dokploy log names contain ":" (timestamps); paths are single-quoted in shell.
const SAFE_FILE_PATH = /^[A-Za-z0-9_.:/-]+$/;
export const LOG_TAIL_LINES = 60;

export const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message.slice(0, 300) : String(error);

export const isNotFound = (error: unknown) =>
	(error as { statusCode?: number })?.statusCode === 404;

export const readTextFile = async (
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

export const collectTasks = async (
	docker: Dockerode,
	serviceName: string,
): Promise<TaskFact[]> => {
	const tasks = await docker.listTasks({
		filters: JSON.stringify({ service: [serviceName] }),
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

export const collectContainer = async (
	docker: Dockerode,
	containerId: string,
	now: Date,
	redact: Redactor,
) => {
	const info = await docker.getContainer(containerId).inspect();
	const health = info.State?.Health;
	const lastLog = health?.Log?.[health.Log.length - 1];
	const startedAt = info.State?.StartedAt ?? now.toISOString();
	const container: ContainerFact = {
		id: info.Id,
		imageId: info.Image,
		image: info.Config?.Image,
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
		oomKilled: info.State?.OOMKilled ?? false,
		restartCount: info.RestartCount ?? 0,
	};
	return {
		container,
		info,
		exposed: Object.keys(info.Config?.ExposedPorts ?? {})
			.filter((key) => key.endsWith("/tcp"))
			.map((key) => Number.parseInt(key, 10)),
		envKeys: (info.Config?.Env ?? []).map((pair) => pair.split("=")[0] ?? ""),
	};
};

/**
 * Images without a shell (scratch, distroless): reads /proc/net/tcp from a
 * short-lived container sharing the target's network namespace, built from
 * the Traefik image already on the server. No mount, removed right after.
 */
const readProcNetViaHelper = async (docker: Dockerode, containerId: string) => {
	const traefikId = await findTraefikContainerId(docker);
	if (!traefikId)
		throw new Error("no helper image available (Traefik not found)");
	const image = (await docker.getContainer(traefikId).inspect()).Image;
	const helper = await docker.createContainer({
		Image: image,
		Entrypoint: ["cat"],
		Cmd: ["/proc/net/tcp", "/proc/net/tcp6"],
		Labels: { "dokploy.smart-deploy": "listening-probe" },
		HostConfig: { NetworkMode: `container:${containerId}` },
	});
	try {
		await helper.start();
		await withTimeout(helper.wait(), 10_000, "listening probe");
		const raw = (await helper.logs({
			stdout: true,
			stderr: false,
			follow: false,
		})) as unknown as Buffer;
		return Buffer.isBuffer(raw) ? demuxDockerOutput(raw) : String(raw);
	} finally {
		await helper.remove({ force: true }).catch(() => {});
	}
};

export const collectListening = async (
	docker: Dockerode,
	containerId: string,
) => {
	const { exitCode, output } = await execCapture(docker, containerId, [
		"cat",
		"/proc/net/tcp",
		"/proc/net/tcp6",
	]).catch(() => ({ exitCode: -1, output: "" }));
	// tcp6 is missing when IPv6 is disabled; cat still prints tcp and exits 1.
	if (output.includes("local_address")) return parseProcNetTcp(output);
	try {
		const viaHelper = await readProcNetViaHelper(docker, containerId);
		if (viaHelper.includes("local_address")) return parseProcNetTcp(viaHelper);
	} catch {
		// Fall through to the original error.
	}
	throw new Error(
		`cannot read /proc/net/tcp in the container (exit ${exitCode}); the image may not ship 'cat'`,
	);
};

const toLines = (raw: Buffer | string, redact: Redactor) => {
	const text = Buffer.isBuffer(raw) ? demuxDockerOutput(raw) : String(raw);
	return redactLines(text.split("\n"), redact, LOG_TAIL_LINES);
};

export const collectServiceLogs = async (
	docker: Dockerode,
	serviceName: string,
	redact: Redactor,
): Promise<string[]> =>
	toLines(
		(await withTimeout(
			docker.getService(serviceName).logs({
				stdout: true,
				stderr: true,
				tail: LOG_TAIL_LINES,
				follow: false,
				timestamps: false,
			}) as unknown as Promise<Buffer | string>,
			10_000,
			"service logs",
		)) as Buffer | string,
		redact,
	);

export const collectContainerLogs = async (
	docker: Dockerode,
	containerId: string,
	redact: Redactor,
): Promise<string[]> =>
	toLines(
		(await withTimeout(
			docker.getContainer(containerId).logs({
				stdout: true,
				stderr: true,
				tail: LOG_TAIL_LINES,
				follow: false,
				timestamps: false,
			}) as unknown as Promise<Buffer | string>,
			10_000,
			"container logs",
		)) as Buffer | string,
		redact,
	);

const exposedPortsOfImage = async (docker: Dockerode, image: string) => {
	const info = await docker.getImage(image.split("@")[0] ?? image).inspect();
	return Object.keys(info.Config?.ExposedPorts ?? {})
		.filter((key) => key.endsWith("/tcp"))
		.map((key) => Number.parseInt(key, 10));
};

/**
 * Fills service, tasks, running container, listening sockets, exposed ports
 * and logs of a Swarm service into `ctx`. Each step is isolated: a failure is
 * recorded and its facts stay undefined.
 */
export const collectSwarmService = async (
	docker: Dockerode,
	serviceName: string,
	ctx: DiagnosticContext,
	redact: Redactor,
) => {
	const fail = (source: EvidenceSource, error: unknown) =>
		ctx.collectionErrors.push({ source, message: errorMessage(error) });
	let publishedPorts: { published: number; target: number }[] = [];

	try {
		const info = await docker.getService(serviceName).inspect();
		ctx.service = {
			exists: true,
			desiredReplicas: info.Spec?.Mode?.Replicated?.Replicas ?? 1,
			image: info.Spec?.TaskTemplate?.ContainerSpec?.Image,
		};
		const ports: { PublishedPort?: number; TargetPort?: number }[] =
			info.Endpoint?.Ports ?? [];
		publishedPorts = ports
			.filter((p) => p.PublishedPort && p.TargetPort)
			.map((p) => ({
				published: p.PublishedPort as number,
				target: p.TargetPort as number,
			}));
	} catch (error) {
		if (isNotFound(error)) ctx.service = { exists: false, desiredReplicas: 0 };
		else fail("docker_service", error);
	}
	if (!ctx.service?.exists) return { publishedPorts };

	try {
		ctx.tasks = await collectTasks(docker, serviceName);
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
				ctx.now,
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
			ctx.imageExposedPorts = await exposedPortsOfImage(
				docker,
				ctx.service.image,
			);
		} catch (error) {
			fail("docker_image", error);
		}
	}

	try {
		ctx.logs = await collectServiceLogs(docker, serviceName, redact);
	} catch (error) {
		fail("application_logs", error);
	}
	return { publishedPorts };
};
