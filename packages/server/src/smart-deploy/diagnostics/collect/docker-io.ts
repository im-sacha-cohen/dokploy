import type Dockerode from "dockerode";
import type { ProbeResult } from "../types";

const STREAM_HEADER_SIZE = 8;

/** Decodes Docker's multiplexed stdout/stderr framing; passes raw TTY output through. */
export const demuxDockerOutput = (buffer: Buffer): string => {
	const firstByte = buffer[0];
	const looksMultiplexed =
		buffer.length >= STREAM_HEADER_SIZE &&
		(firstByte === 0 || firstByte === 1 || firstByte === 2) &&
		buffer[1] === 0 &&
		buffer[2] === 0 &&
		buffer[3] === 0;
	if (!looksMultiplexed) return buffer.toString("utf8");

	const chunks: Buffer[] = [];
	let offset = 0;
	while (offset + STREAM_HEADER_SIZE <= buffer.length) {
		const size = buffer.readUInt32BE(offset + 4);
		const start = offset + STREAM_HEADER_SIZE;
		chunks.push(buffer.subarray(start, Math.min(start + size, buffer.length)));
		offset = start + size;
	}
	return Buffer.concat(chunks).toString("utf8");
};

export const withTimeout = <T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms}ms`)),
			ms,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});

/**
 * Runs a fixed argv (never a shell string) inside a container and captures its
 * output. Used only for read-only commands.
 */
export const execCapture = async (
	docker: Dockerode,
	containerId: string,
	cmd: string[],
	timeoutMs = 6_000,
): Promise<{ exitCode: number | null; output: string }> => {
	const run = async () => {
		const exec = await docker.getContainer(containerId).exec({
			Cmd: cmd,
			AttachStdout: true,
			AttachStderr: true,
			Tty: false,
		});
		const stream = await exec.start({ hijack: true, stdin: false });
		const chunks: Buffer[] = [];
		await new Promise<void>((resolve, reject) => {
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("end", resolve);
			stream.on("close", resolve);
			stream.on("error", reject);
		});
		const info = await exec.inspect();
		return {
			exitCode: info.ExitCode ?? null,
			output: demuxDockerOutput(Buffer.concat(chunks)),
		};
	};
	return withTimeout(run(), timeoutMs, `exec ${cmd[0]}`);
};

export const findTraefikContainerId = async (
	docker: Dockerode,
): Promise<string | null> => {
	const byName = await docker.listContainers({
		filters: JSON.stringify({
			name: ["^/dokploy-traefik$"],
			status: ["running"],
		}),
	});
	if (byName[0]) return byName[0].Id;
	const byService = await docker.listContainers({
		filters: JSON.stringify({
			label: ["com.docker.swarm.service.name=dokploy-traefik"],
			status: ["running"],
		}),
	});
	return byService[0]?.Id ?? null;
};

const HOSTNAME =
	/^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const URL_PATH = /^\/[A-Za-z0-9._~/-]*$/;

export const isSafeHostname = (value: string) => HOSTNAME.test(value);
export const safePath = (value: string | null | undefined) =>
	value && URL_PATH.test(value) ? value : "/";

export const parseWgetOutput = (
	output: string,
): Pick<ProbeResult, "ok" | "httpStatus" | "error" | "detail"> => {
	const status = output.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
	if (status?.[1]) {
		const httpStatus = Number.parseInt(status[1], 10);
		return { ok: httpStatus < 500, httpStatus };
	}
	if (/connection refused/i.test(output)) {
		return { ok: false, error: "connection_refused" };
	}
	if (/timed out|timeout/i.test(output)) return { ok: false, error: "timeout" };
	if (/bad address|unknown host|name or service not known/i.test(output)) {
		return { ok: false, error: "dns" };
	}
	return {
		ok: false,
		error: "other",
		detail: output.trim().split("\n").pop()?.slice(0, 160),
	};
};

/** HTTP probe executed from inside the Traefik container, i.e. from the proxy's network view. */
export const probeFromTraefik = async (
	docker: Dockerode,
	traefikId: string,
	url: string,
	hostHeader?: string,
): Promise<Pick<ProbeResult, "ok" | "httpStatus" | "error" | "detail">> => {
	const cmd = ["timeout", "6", "wget", "-S", "-O", "/dev/null", "-T", "5"];
	if (hostHeader) cmd.push("--header", `Host: ${hostHeader}`);
	cmd.push(url);
	try {
		const { output } = await execCapture(docker, traefikId, cmd, 9_000);
		return parseWgetOutput(output);
	} catch (error) {
		return {
			ok: false,
			error: /timed out/.test(String(error)) ? "timeout" : "other",
			detail: error instanceof Error ? error.message.slice(0, 160) : undefined,
		};
	}
};
