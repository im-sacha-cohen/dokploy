// Finds a Cloudflare Tunnel connector (cloudflared) already running on a
// server, so a domain can be published as a tunnel route instead of an A
// record. Only account and tunnel ids are kept from the connector token or
// credentials file: their secret never leaves this module.
import { TRAEFIK_PORT } from "../../setup/traefik-setup";
import {
	type ConnectorRestart,
	readTunnelConfig,
	type TunnelConfigFile,
} from "./config-file";
import { readHostFiles, runOnHost, runOnServer } from "./host";

export type TunnelSource = "docker" | "process";

export interface FoundTunnel {
	status: "found";
	tunnelId: string;
	/** Known from a token or credentials file; else the zone's account. */
	accountId?: string;
	/** Where cloudflared reaches Traefik, used as the route's service. */
	origin: string;
	source: TunnelSource;
	/** The container or systemd unit, for people. */
	connector: string;
	/** Set when cloudflared runs with a local config.yml Dokploy can edit. */
	configFile?: TunnelConfigFile;
	/** Why config.yml cannot be edited: only API routes are possible. */
	configProblem?: string;
}

export type DetectedTunnel =
	| FoundTunnel
	| {
			status: "unsupported";
			source: TunnelSource;
			connector: string;
			reason: string;
	  };

interface Mount {
	Source?: string;
	Destination?: string;
}

export interface DockerConnector {
	Id?: string;
	Name?: string;
	Args?: string[];
	Config?: { Env?: string[] | null; Cmd?: string[] | null };
	HostConfig?: { NetworkMode?: string };
	Mounts?: Mount[] | null;
	NetworkSettings?: {
		Networks?: Record<string, { Gateway?: string } | null> | null;
	};
}

type TokenLookup =
	| { kind: "token"; token: string }
	| { kind: "token-file"; path: string }
	| { kind: "config"; configPath?: string };

/** A running cloudflared, before its token or config file is read. */
export interface Connector {
	source: TunnelSource;
	connector: string;
	origin: string;
	lookup: TokenLookup;
	restart: ConnectorRestart | null;
	mounts: Mount[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOKPLOY_NETWORK = "dokploy-network";
const TRAEFIK_CONTAINER = "dokploy-traefik";
const CACHE_TTL_MS = 60_000;
const DETECT_TIMEOUT_MS = 15_000;

const DOCKER_MARKER = "---DOKPLOY-TUNNEL-DOCKER---";
const PROCESS_MARKER = "---DOKPLOY-TUNNEL-PROCESSES---";

const DOCKER_SCRIPT = [
	`ids=$(docker ps --format '{{.ID}} {{.Image}}' 2>/dev/null | awk 'tolower($2) ~ /cloudflared/ {print $1}')`,
	`echo '${DOCKER_MARKER}'`,
	`if [ -n "$ids" ]; then docker inspect $ids 2>/dev/null; fi`,
].join("\n");

// Each process line is `<systemd unit>|<command line>`; a process started by
// Docker has no `.service` in its cgroup.
const PROCESS_SCRIPT = [
	`echo '${PROCESS_MARKER}'`,
	"for pid in $(pgrep -x cloudflared 2>/dev/null); do",
	`  unit=$(grep -o '[^/]*\\.service' /proc/$pid/cgroup 2>/dev/null | tail -1)`,
	`  echo "$unit|$(tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null)"`,
	"done",
].join("\n");

// Where cloudflared looks for config.yml without --config.
const DEFAULT_CONFIG_DIRS = {
	docker: [
		"/etc/cloudflared",
		"/home/nonroot/.cloudflared",
		"/root/.cloudflared",
	],
	process: [
		"/etc/cloudflared",
		"/usr/local/etc/cloudflared",
		"/root/.cloudflared",
	],
};

/** Account and tunnel ids of a connector token (base64 JSON `{a, t, s}`). */
export const decodeTunnelToken = (token: string) => {
	try {
		const payload = JSON.parse(
			Buffer.from(token.trim(), "base64").toString("utf8"),
		) as { a?: unknown; t?: unknown };
		if (
			typeof payload.a === "string" &&
			payload.a.length > 0 &&
			typeof payload.t === "string" &&
			UUID.test(payload.t)
		) {
			return { accountId: payload.a, tunnelId: payload.t.toLowerCase() };
		}
	} catch {
		// Not a connector token.
	}
	return null;
};

/** Account and tunnel ids of a credentials file (`{AccountTag, TunnelID}`). */
export const decodeCredentials = (text: string) => {
	try {
		const payload = JSON.parse(text) as {
			AccountTag?: unknown;
			TunnelID?: unknown;
		};
		return {
			accountId:
				typeof payload.AccountTag === "string" && payload.AccountTag
					? payload.AccountTag
					: undefined,
			tunnelId:
				typeof payload.TunnelID === "string" && UUID.test(payload.TunnelID)
					? payload.TunnelID.toLowerCase()
					: undefined,
		};
	} catch {
		return null;
	}
};

const flagValue = (args: string[], flag: string) => {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === flag && args[i + 1]) return args[i + 1];
		if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
	}
	return undefined;
};

const envValue = (env: string[], name: string) =>
	env.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) ||
	undefined;

const findToken = (args: string[], env: string[] = []): TokenLookup => {
	const token = flagValue(args, "--token") ?? envValue(env, "TUNNEL_TOKEN");
	if (token) return { kind: "token", token };
	const tokenFile =
		flagValue(args, "--token-file") ?? envValue(env, "TUNNEL_TOKEN_FILE");
	if (tokenFile) return { kind: "token-file", path: tokenFile };
	return { kind: "config", configPath: flagValue(args, "--config") };
};

/** How a cloudflared container reaches Traefik's HTTP entrypoint. */
export const dockerOrigin = (
	container: DockerConnector,
	port = TRAEFIK_PORT,
) => {
	if (container.HostConfig?.NetworkMode === "host") {
		return `http://localhost:${port}`;
	}
	const networks = container.NetworkSettings?.Networks ?? {};
	if (DOKPLOY_NETWORK in networks) {
		return `http://${TRAEFIK_CONTAINER}:${port}`;
	}
	// Traefik publishes its port on the host, which a bridge network reaches
	// through its gateway.
	const gateway = Object.values(networks).find((n) => n?.Gateway)?.Gateway;
	return `http://${gateway ?? "localhost"}:${port}`;
};

/** Where a path inside a container lives on the host, if it is mounted. */
export const toHostPath = (path: string, mounts: Mount[]) => {
	const mount = mounts
		.filter((m) => {
			const destination = m.Destination?.replace(/\/+$/, "");
			return (
				!!m.Source &&
				!!destination &&
				(path === destination || path.startsWith(`${destination}/`))
			);
		})
		.sort(
			(a, b) => (b.Destination?.length ?? 0) - (a.Destination?.length ?? 0),
		)[0];
	if (!mount?.Source || !mount.Destination) return null;
	return `${mount.Source.replace(/\/+$/, "")}${path.slice(mount.Destination.replace(/\/+$/, "").length)}`;
};

/**
 * Parses the detection script output into the connector to use. Containers
 * win over processes: a container's process also shows up on the host,
 * without its environment.
 */
export const parseDetection = (
	output: string,
	port = TRAEFIK_PORT,
): Connector | null => {
	const dockerStart = output.indexOf(DOCKER_MARKER);
	const processStart = output.indexOf(PROCESS_MARKER);
	if (dockerStart === -1 || processStart === -1) return null;

	const dockerJson = output
		.slice(dockerStart + DOCKER_MARKER.length, processStart)
		.trim();
	let containers: DockerConnector[] = [];
	if (dockerJson) {
		try {
			containers = JSON.parse(dockerJson) as DockerConnector[];
		} catch {
			containers = [];
		}
	}
	const fromContainers = containers.map(
		(container): Connector => ({
			source: "docker",
			connector: `container ${container.Name?.replace(/^\//, "") || container.Id?.slice(0, 12) || "cloudflared"}`,
			origin: dockerOrigin(container, port),
			lookup: findToken(
				[...(container.Config?.Cmd ?? []), ...(container.Args ?? [])],
				container.Config?.Env ?? [],
			),
			restart: container.Id
				? { kind: "docker", container: container.Id }
				: null,
			mounts: container.Mounts ?? [],
		}),
	);

	const fromProcesses = output
		.slice(processStart + PROCESS_MARKER.length)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.includes("|"))
		.map((line): Connector => {
			const separator = line.indexOf("|");
			const unit = line.slice(0, separator).trim();
			return {
				source: "process",
				connector: unit ? `systemd unit ${unit}` : "cloudflared process",
				origin: `http://localhost:${port}`,
				lookup: findToken(
					line
						.slice(separator + 1)
						.trim()
						.split(/\s+/),
				),
				restart: unit ? { kind: "systemd", unit } : null,
				mounts: [],
			};
		});

	const candidates = fromContainers.length ? fromContainers : fromProcesses;
	const rank = (c: Connector) =>
		c.lookup.kind === "token" && decodeTunnelToken(c.lookup.token)
			? 0
			: c.lookup.kind === "token"
				? 2
				: 1;
	return [...candidates].sort((a, b) => rank(a) - rank(b))[0] ?? null;
};

type ReadFiles = (paths: string[]) => Promise<Record<string, string>>;

const unsupported = (connector: Connector, reason: string): DetectedTunnel => ({
	status: "unsupported",
	source: connector.source,
	connector: connector.connector,
	reason,
});

/** Reads the connector's token, or its config and credentials files. */
export const resolveConnector = async (
	connector: Connector,
	readFiles: ReadFiles,
): Promise<DetectedTunnel> => {
	const { source, origin, lookup } = connector;
	const found = {
		status: "found" as const,
		origin,
		source,
		connector: connector.connector,
	};
	const onHost = (path: string) =>
		source === "docker" ? toHostPath(path, connector.mounts) : path;

	if (lookup.kind === "token-file") {
		const path = onHost(lookup.path);
		const token = path ? (await readFiles([path]))[path] : undefined;
		const ids = token ? decodeTunnelToken(token) : null;
		if (ids) return { ...found, ...ids };
		return unsupported(
			connector,
			path
				? `The token file ${lookup.path} of cloudflared could not be read.`
				: `The token file ${lookup.path} is not on a volume of the container (a Docker secret, for example), so Dokploy cannot read it. Mount it from a folder of the server instead.`,
		);
	}
	if (lookup.kind === "token") {
		const ids = decodeTunnelToken(lookup.token);
		return ids
			? { ...found, ...ids }
			: unsupported(connector, "The cloudflared token could not be read.");
	}

	const inside = lookup.configPath
		? [lookup.configPath]
		: DEFAULT_CONFIG_DIRS[source].flatMap((dir) => [
				`${dir}/config.yml`,
				`${dir}/config.yaml`,
			]);
	const candidates = inside
		.map((path) => onHost(path))
		.filter((path): path is string => !!path);
	if (candidates.length === 0) {
		return unsupported(
			connector,
			"The cloudflared container keeps its config.yml inside its image, where a change would be lost when the container is recreated. Mount /etc/cloudflared as a volume so Dokploy can edit it.",
		);
	}
	const files = await readFiles(candidates);
	const path = candidates.find((candidate) => files[candidate] !== undefined);
	if (!path) {
		return unsupported(
			connector,
			`The config.yml of cloudflared was not found (looked for ${candidates.join(", ")}).`,
		);
	}
	const config = readTunnelConfig(files[path] as string);
	if (!config) {
		return unsupported(connector, `${path} could not be parsed.`);
	}

	let tunnelId =
		config.tunnel && UUID.test(config.tunnel)
			? config.tunnel.toLowerCase()
			: undefined;
	let accountId: string | undefined;
	const credentialsPath = config.credentialsFile
		? onHost(config.credentialsFile)
		: null;
	if (credentialsPath) {
		const credentials = (await readFiles([credentialsPath]))[credentialsPath];
		const ids = credentials ? decodeCredentials(credentials) : null;
		tunnelId ??= ids?.tunnelId;
		accountId = ids?.accountId;
	}
	if (!tunnelId) {
		return unsupported(
			connector,
			`The tunnel id was not found in ${path} or its credentials file.`,
		);
	}
	// Without a way to restart cloudflared, config.yml cannot be changed, but
	// a tunnel migrated to the dashboard still takes routes through the API.
	if (!connector.restart) {
		return {
			...found,
			tunnelId,
			accountId,
			configProblem:
				"cloudflared was started by hand, outside systemd and Docker, so Dokploy cannot restart it after editing config.yml. Run it as a service (cloudflared service install) or migrate the tunnel to the Cloudflare dashboard.",
		};
	}
	return {
		...found,
		tunnelId,
		accountId,
		configFile: { path, restart: connector.restart },
	};
};

const withTimeout = <T>(promise: Promise<T>) =>
	Promise.race([
		promise,
		new Promise<null>((resolve) =>
			setTimeout(() => resolve(null), DETECT_TIMEOUT_MS),
		),
	]).catch(() => null);

const runDetection = async (serverId?: string | null) =>
	withTimeout(
		(async () => {
			// The Dokploy container sees the host's containers through the Docker
			// socket, but not its processes.
			const [docker, processes] = await Promise.all([
				runOnServer(serverId, DOCKER_SCRIPT).catch(() => ({
					stdout: DOCKER_MARKER,
				})),
				runOnHost(serverId, PROCESS_SCRIPT).catch(() => ({
					stdout: PROCESS_MARKER,
				})),
			]);
			const connector = parseDetection(`${docker.stdout}\n${processes.stdout}`);
			return connector
				? resolveConnector(connector, (paths) => readHostFiles(serverId, paths))
				: null;
		})(),
	);

const cache = new Map<
	string,
	{ at: number; value: Promise<DetectedTunnel | null> }
>();

/**
 * The tunnel connector running on the server (the Dokploy host when
 * `serverId` is empty). Cached for a minute: the domain form asks on every
 * keystroke.
 */
export const detectTunnel = (serverId?: string | null, fresh = false) => {
	const key = serverId || "local";
	const cached = cache.get(key);
	if (!fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
		return cached.value;
	}
	const value = runDetection(serverId);
	cache.set(key, { at: Date.now(), value });
	return value;
};

export const tunnelHostname = (tunnelId: string) =>
	`${tunnelId.toLowerCase()}.cfargotunnel.com`;
