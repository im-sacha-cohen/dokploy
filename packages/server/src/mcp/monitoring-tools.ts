// Read-only monitoring tools: server health, Docker disk usage, live stats of a
// service's containers, and the metrics history of the monitoring agent.
import { z } from "zod";
import { checkPermission, type PermissionCtx } from "../services/permission";
import { findServerById, getAccessibleServerIds } from "../services/server";
import { getWebServerSettings } from "../services/web-server-settings";
import type { Redactor } from "../smart-deploy/diagnostics/redact";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import type { McpApiPath } from "./api-paths";
import type { McpPrincipal } from "./token";
import {
	ID,
	json,
	type McpActionDeps,
	type RegisterTool,
	ToolError,
} from "./tool-kit";

type Row = Record<string, unknown>;

const GB = 1024 ** 3;
const round = (value: number, digits = 1) =>
	Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const percent = (used: number, total: number) =>
	total > 0 ? round((used / total) * 100) : null;

const SERVICE_TYPES = [
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
] as const;

interface DockerStats {
	cpu_stats?: {
		cpu_usage?: { total_usage?: number };
		system_cpu_usage?: number;
		online_cpus?: number;
	};
	precpu_stats?: {
		cpu_usage?: { total_usage?: number };
		system_cpu_usage?: number;
	};
	memory_stats?: { usage?: number; limit?: number; stats?: { cache?: number } };
	networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
	blkio_stats?: {
		io_service_bytes_recursive?: { op?: string; value?: number }[] | null;
	};
}

/** One `docker stats --no-stream` sample, as the CLI computes it. */
export const summarizeStats = (stats: DockerStats) => {
	const cpu = stats.cpu_stats ?? {};
	const pre = stats.precpu_stats ?? {};
	const cpuDelta =
		(cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0);
	const systemDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
	const cpus = cpu.online_cpus ?? 1;
	const memUsed =
		(stats.memory_stats?.usage ?? 0) - (stats.memory_stats?.stats?.cache ?? 0);
	const memLimit = stats.memory_stats?.limit ?? 0;
	const networks = Object.values(stats.networks ?? {});
	const io = stats.blkio_stats?.io_service_bytes_recursive ?? [];
	const ioSum = (op: string) =>
		io
			.filter((entry) => entry.op?.toLowerCase() === op)
			.reduce((sum, entry) => sum + (entry.value ?? 0), 0);
	return {
		cpuPercent:
			systemDelta > 0 && cpuDelta >= 0
				? round((cpuDelta / systemDelta) * cpus * 100, 2)
				: 0,
		memoryUsedMB: round(memUsed / 1024 ** 2),
		memoryLimitMB: round(memLimit / 1024 ** 2),
		memoryPercent: percent(memUsed, memLimit),
		networkRxMB: round(
			networks.reduce((sum, n) => sum + (n.rx_bytes ?? 0), 0) / 1024 ** 2,
		),
		networkTxMB: round(
			networks.reduce((sum, n) => sum + (n.tx_bytes ?? 0), 0) / 1024 ** 2,
		),
		blockReadMB: round(ioSum("read") / 1024 ** 2),
		blockWriteMB: round(ioSum("write") / 1024 ** 2),
	};
};

const numeric = (value: unknown) => {
	const n =
		typeof value === "number" ? value : Number.parseFloat(String(value));
	return Number.isFinite(n) ? n : null;
};

/** Min / average / max of a metric over the returned points. */
export const seriesSummary = (points: Row[], key: string) => {
	const values = points
		.map((p) => numeric(p[key]))
		.filter((v): v is number => v !== null);
	if (values.length === 0) return null;
	return {
		min: round(Math.min(...values)),
		avg: round(values.reduce((a, b) => a + b, 0) / values.length),
		max: round(Math.max(...values)),
	};
};

export const registerMonitoringTools = ({
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
	const ctx: PermissionCtx = {
		user: { id: principal.userId },
		session: { activeOrganizationId: principal.organizationId },
	};

	const assertServerAccess = async (serverId: string) => {
		const server = await findServerById(serverId).catch(() => null);
		const accessible = await getAccessibleServerIds({
			userId: principal.userId,
			activeOrganizationId: principal.organizationId,
		});
		if (
			!server ||
			server.organizationId !== principal.organizationId ||
			!accessible.has(serverId)
		) {
			throw new ToolError("Server not found or access denied");
		}
		return server;
	};

	tool(
		"dokploy_get_server_health",
		"mcp:read",
		{
			title: "Server health",
			description:
				"Resources of the Dokploy server (or of a remote server): memory, CPUs, disk, containers and services, memory reserved by services, Docker network address pools close to exhaustion, and recent Docker daemon errors.",
			input: z.object({
				serverId: ID.optional().describe(
					"Remote server; omit for the Dokploy server",
				),
				sinceHours: z
					.number()
					.int()
					.min(1)
					.max(168)
					.default(24)
					.describe("Window for daemon errors"),
			}),
		},
		async ({ serverId, sinceHours }) => {
			const health = await api<Row>("docker.getServerHealth", {
				...(serverId ? { serverId } : {}),
				sinceHours,
			});
			const resources = (health.resources ?? {}) as Row;
			const disk = (health.disk ?? {}) as Row;
			const memTotal = Number(resources.memTotalBytes ?? 0);
			const memUsed = Number(resources.memUsedBytes ?? 0);
			const diskTotal = Number(disk.totalBytes ?? 0);
			const diskUsed = Number(disk.usedBytes ?? 0);
			const networks = (health.dockerNetworks ?? {}) as Row;
			const usage = (networks.usage as Row[] | undefined) ?? [];
			return json({
				checkedAt: health.checkedAt,
				memory: {
					usedGB: round(memUsed / GB, 2),
					totalGB: round(memTotal / GB, 2),
					percent: percent(memUsed, memTotal),
				},
				cpuCount: resources.cpuCount,
				disk: {
					usedGB: round(diskUsed / GB, 2),
					totalGB: round(diskTotal / GB, 2),
					percent: percent(diskUsed, diskTotal),
				},
				containers: health.containers,
				reservation: health.reservation,
				dockerNetworks: {
					count: networks.count,
					busiest: usage
						.filter((n) => n.percentUsed !== null)
						.sort(
							(a, b) => Number(b.percentUsed ?? 0) - Number(a.percentUsed ?? 0),
						)
						.slice(0, 5),
				},
				inotify: health.inotify,
				daemonErrors: ((health.daemonErrors as string[] | undefined) ?? [])
					.slice(-10)
					.map((line) => redact(line)),
			});
		},
	);

	tool(
		"dokploy_get_disk_usage",
		"mcp:read",
		{
			title: "Docker disk usage",
			description:
				"Disk taken by Docker on the server: images, containers, volumes and build cache, with what can be reclaimed. Read-only: it does not clean anything.",
			input: z.object({ serverId: ID.optional() }),
		},
		async ({ serverId }) =>
			json({
				usage: await api("dockerDiskUsage.getDiskUsage", {
					...(serverId ? { serverId } : {}),
				}),
			}),
	);

	tool(
		"dokploy_get_service_stats",
		"mcp:read",
		{
			title: "Service resource usage",
			description:
				"Live CPU, memory, network and disk I/O of each running container of a service (like `docker stats`), plus the recorded history when Dokploy's monitoring collected one.",
			input: z.object({
				serviceType: z.enum(SERVICE_TYPES),
				serviceId: ID,
			}),
		},
		async ({ serviceType, serviceId }) => {
			const service = await api<Row>(`${serviceType}.one` as McpApiPath, {
				[`${serviceType}Id`]: serviceId,
			});
			const appName = String(service.appName ?? "");
			const serverId = (service.serverId as string | null) ?? null;
			const containers = await api<
				{ containerId: string; name: string; state: string }[]
			>("docker.getContainersByAppNameMatch", {
				appName,
				...(serviceType === "compose"
					? {
							appType:
								service.composeType === "stack" ? "stack" : "docker-compose",
						}
					: {}),
				...(serverId ? { serverId } : {}),
			});
			const running = containers
				.filter((c) => c.state === "running")
				.slice(0, 10);
			const docker = await getRemoteDocker(serverId);
			const live = [];
			for (const container of running) {
				try {
					const stats = (await docker
						.getContainer(container.containerId)
						.stats({ stream: false })) as unknown as DockerStats;
					live.push({ container: container.name, ...summarizeStats(stats) });
				} catch (error) {
					live.push({
						container: container.name,
						error:
							error instanceof Error
								? error.message.slice(0, 160)
								: "stats unavailable",
					});
				}
			}
			let history: Row | null = null;
			if (serviceType !== "compose") {
				try {
					const recorded = await api<Row | null>(
						"application.readAppMonitoring",
						{ appName },
					);
					if (recorded) {
						history = Object.fromEntries(
							Object.entries(recorded).map(([key, points]) => [
								key,
								Array.isArray(points) ? points.slice(-20) : points,
							]),
						);
					}
				} catch {
					history = null;
				}
			}
			return json({
				service: service.name,
				runningContainers: running.length,
				live,
				...(history ? { history } : {}),
				...(running.length === 0
					? { note: "No running container: start or deploy the service first." }
					: {}),
			});
		},
	);

	tool(
		"dokploy_get_metrics_history",
		"mcp:read",
		{
			title: "Server metrics history",
			description:
				"CPU, memory, disk and network history collected by Dokploy's monitoring agent (Settings › Monitoring) on the Dokploy server or a remote server: latest values and min / avg / max over the window.",
			input: z.object({
				serverId: ID.optional().describe(
					"Remote server; omit for the Dokploy server",
				),
				dataPoints: z.number().int().min(1).max(500).default(60),
			}),
		},
		async ({ serverId, dataPoints }) => {
			try {
				await checkPermission(ctx, { monitoring: ["read"] });
			} catch {
				throw new ToolError("Monitoring is not available to this account");
			}
			// The agent's address and token come from Dokploy's own settings, never
			// from the client: no arbitrary URL is fetched.
			let host: string | null | undefined;
			let config:
				| { server?: { port?: number; token?: string } }
				| null
				| undefined;
			if (serverId) {
				const server = await assertServerAccess(serverId);
				host = server.ipAddress;
				config = server.metricsConfig as typeof config;
			} else {
				const settings = await getWebServerSettings();
				host = settings?.serverIp;
				config = settings?.metricsConfig as typeof config;
			}
			const port = config?.server?.port;
			const token = config?.server?.token;
			if (!host || !port || !token) {
				throw new ToolError(
					"Monitoring is not set up on this server (Settings › Monitoring), or the server IP is unknown.",
				);
			}
			const url = new URL(`http://${host}:${port}/metrics`);
			url.searchParams.set("limit", String(dataPoints));
			let points: Row[];
			try {
				const response = await fetch(url, {
					headers: { Authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(8_000),
				});
				if (!response.ok) {
					throw new ToolError(
						`The monitoring agent answered ${response.status}. Check that it runs (Settings › Monitoring).`,
					);
				}
				points = (await response.json()) as Row[];
			} catch (error) {
				if (error instanceof ToolError) throw error;
				throw new ToolError(
					"The monitoring agent did not answer. Check that it runs (Settings › Monitoring) and that its port is reachable from Dokploy.",
				);
			}
			if (!Array.isArray(points) || points.length === 0) {
				throw new ToolError(
					"No metrics recorded yet: the monitoring agent has not collected data.",
				);
			}
			const latest = points[points.length - 1] ?? {};
			return json({
				points: points.length,
				from: points[0]?.timestamp,
				to: latest.timestamp,
				latest: {
					cpuPercent: numeric(latest.cpu),
					memoryUsedGB: numeric(latest.memUsedGB),
					memoryPercent: numeric(latest.memUsed),
					diskUsedPercent: numeric(latest.diskUsed),
					totalDisk: latest.totalDisk,
					networkIn: latest.networkIn,
					networkOut: latest.networkOut,
					uptimeSeconds: latest.uptime,
					os: latest.distro ?? latest.os,
					arch: latest.arch,
				},
				window: {
					cpuPercent: seriesSummary(points, "cpu"),
					memoryPercent: seriesSummary(points, "memUsed"),
					diskUsedPercent: seriesSummary(points, "diskUsed"),
				},
			});
		},
	);
};
