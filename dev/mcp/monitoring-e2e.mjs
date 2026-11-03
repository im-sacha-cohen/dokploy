// End-to-end test of the MCP monitoring tools against the LOCAL dev instance:
// server health, Docker disk usage, live stats of a running service, metrics
// history (or its clear refusal when monitoring is not set up), and a
// restricted member without the docker/monitoring permissions.
// Usage: node dev/mcp/monitoring-e2e.mjs   (DOKPLOY_MCP_URL when tunnelled)
import {
	call,
	createSession,
	devEnv,
	login,
} from "../demo-apps/api-client.mjs";
import {
	authorize,
	check,
	registerClient,
	summarize,
	toolCall,
} from "./mcp-client.mjs";

const result = (res) => res.json?.result ?? {};
const data = (res) => result(res).structuredContent ?? {};
const text = (res) => result(res).content?.[0]?.text ?? res.text;

await login();
const settings = await call("/api/mcp.getSettings", undefined, "GET");
const demo = (await call("/api/project.all", undefined, "GET")).find(
	(p) => p.name === "Smart Deploy Demo",
);
const appA = demo.environments
	.flatMap((e) => e.applications)
	.find((a) => a.name === "a-healthy").applicationId;

const client = await registerClient("Dokploy monitoring E2E", ["mcp:read"]);
const token = (
	await authorize(client.client_id, ["mcp:read"], settings.organizationId)
).access_token;
const tool = (name, args = {}) => toolCall(token, name, args);

try {
	const health = data(await tool("dokploy_get_server_health"));
	check(
		"dokploy_get_server_health: memory, CPUs and disk",
		health.memory?.totalGB > 0 &&
			health.cpuCount > 0 &&
			health.disk?.totalGB > 0 &&
			typeof health.disk?.percent === "number",
		`RAM ${health.memory?.usedGB}/${health.memory?.totalGB} GB, ${health.cpuCount} CPUs, disk ${health.disk?.percent}%`,
	);

	const disk = await tool("dokploy_get_disk_usage");
	check(
		"dokploy_get_disk_usage: images, volumes, cache",
		!result(disk).isError && /image/i.test(text(disk)),
		text(disk).slice(0, 160),
	);

	const stats = data(
		await tool("dokploy_get_service_stats", {
			serviceType: "application",
			serviceId: appA,
		}),
	);
	const sample = stats.live?.[0];
	check(
		"dokploy_get_service_stats: live container CPU and memory",
		stats.runningContainers > 0 &&
			typeof sample?.cpuPercent === "number" &&
			sample?.memoryUsedMB > 0,
		JSON.stringify(sample),
	);

	const metrics = await tool("dokploy_get_metrics_history");
	check(
		"dokploy_get_metrics_history: history, or a clear refusal without monitoring",
		(!result(metrics).isError && data(metrics).points > 0) ||
			(result(metrics).isError &&
				/Monitoring|monitoring agent|No metrics/.test(text(metrics))),
		text(metrics).slice(0, 160),
	);

	const forged = await tool("dokploy_get_server_health", {
		serverId: "not-mine",
	});
	check(
		"unknown server → refused",
		result(forged).isError === true,
		text(forged).slice(0, 120),
	);

	const member = createSession();
	await member.signIn(devEnv.DEMO_MEMBER_EMAIL, devEnv.DEMO_MEMBER_PASSWORD);
	const memberClient = await registerClient("Dokploy monitoring E2E (member)", [
		"mcp:read",
	]);
	const memberToken = (
		await authorize(
			memberClient.client_id,
			["mcp:read"],
			settings.organizationId,
			member,
		)
	).access_token;
	const memberHealth = await toolCall(memberToken, "dokploy_get_server_health");
	check(
		"member without the docker permission → server health refused",
		result(memberHealth).isError === true,
		text(memberHealth).slice(0, 120),
	);
	await member.call("/api/mcp.revokeGrant", {
		clientId: memberClient.client_id,
	});
} catch (error) {
	check("scenario runs without exception", false, error.stack);
} finally {
	await call("/api/mcp.revokeGrant", { clientId: client.client_id });
}

summarize();
