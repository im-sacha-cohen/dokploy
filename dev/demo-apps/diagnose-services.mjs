// Smart Deploy on databases and compose stacks, for real, against the demo
// services of seed-services.mjs: expected diagnosis of each, then one-click
// fixes (compose port, stopped database, image change not deployed) and their
// effect, then the broken demo state is restored. Also checks the MCP tool.
// Usage: node dev/demo-apps/diagnose-services.mjs
// (when /mcp is reached through a tunnel, set DOKPLOY_MCP_URL for the MCP part)
import http from "node:http";
import {
	authorize,
	check,
	registerClient,
	summarize,
	toolCall,
} from "../mcp/mcp-client.mjs";
import { call, login } from "./api-client.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const qs = (params) => new URLSearchParams(params).toString();
const get = (path, params) =>
	call(`/api/${path}?${qs(params)}`, undefined, "GET");

const viaTraefik = (host) =>
	new Promise((resolve) => {
		http
			.get(
				{ host: "127.0.0.1", port: 8880, path: "/", headers: { host } },
				(res) => {
					res.resume();
					res.on("end", () => resolve(res.statusCode));
				},
			)
			.on("error", () => resolve(0));
	});

await login();
const env = (await call("/api/project.all", undefined, "GET")).find(
	(p) => p.name === "Smart Deploy Demo",
).environments[0];
const services = {};
for (const type of ["postgres", "mysql", "mongo", "redis"]) {
	for (const s of env[type] ?? []) {
		const row = await get(`${type}.one`, { [`${type}Id`]: s[`${type}Id`] });
		services[row.name] = { type, id: s[`${type}Id`] };
	}
}
for (const c of env.compose ?? [])
	services[c.name] = { type: "compose", id: c.composeId };

const diagnose = (name) =>
	get("smartDeploy.diagnoseService", {
		serviceType: services[name].type,
		serviceId: services[name].id,
	});
const codes = (report) =>
	report.findings.map((f) => `${f.code}${f.service ? `[${f.service}]` : ""}`);
const finding = (report, code, service) =>
	report.findings.find(
		(f) => f.code === code && (service === undefined || f.service === service),
	);

const expectations = [
	["l-pg-healthy", "healthy", []],
	["f-compose", "healthy", []],
	["h-pg-upgraded", null, ["DATA_DIRECTORY_INCOMPATIBLE"]],
	["i-mysql-bad-image", "down", ["IMAGE_PULL_FAILED"]],
	["k-mongo-stopped", "stopped", ["SERVICE_STOPPED"]],
	["j-redis-pending", "degraded", ["CONFIG_NOT_APPLIED"]],
	[
		"m-compose-broken",
		"down",
		[
			"PORT_MISMATCH[web]",
			"CONTAINER_CRASH_LOOP[worker]",
			"MISSING_ENVIRONMENT_VARIABLE[worker]",
			"MISSING_ENVIRONMENT_VARIABLE",
		],
	],
];

const restore = [];
try {
	// 0. After a Docker restart, plain compose containers stay stopped: that is
	// itself a case to diagnose and fix in one click.
	if (services["m-compose-broken"]) {
		const before = await diagnose("m-compose-broken");
		const stoppedWeb = finding(before, "SERVICE_STOPPED", "web");
		if (stoppedWeb) {
			check(
				"m stopped (Docker restart): web service reported stopped, stack down",
				before.verdict === "down" &&
					stoppedWeb.recommendedFix.action?.kind === "redeploy_service",
				stoppedWeb.description,
			);
			await call("/api/smartDeploy.applyServiceFix", {
				serviceType: "compose",
				serviceId: services["m-compose-broken"].id,
				action: stoppedWeb.recommendedFix.action,
			});
			let after;
			for (let i = 0; i < 20; i++) {
				await wait(3000);
				after = await diagnose("m-compose-broken");
				if (!finding(after, "SERVICE_STOPPED", "web")) break;
			}
			check(
				"m: one-click \"Start\" → services restarted",
				!finding(after, "SERVICE_STOPPED"),
				codes(after).join(", "),
			);
			// Listening ports are only judged once the app had time to boot.
			await wait(25_000);
		}
	}

	// 1. Expected diagnosis of each demo service
	const reports = {};
	for (const [name, verdict, expected] of expectations) {
		if (!services[name]) {
			check(`${name} present (seed-services.mjs)`, false);
			continue;
		}
		const report = await diagnose(name);
		reports[name] = report;
		const found = codes(report);
		check(
			`${name}: ${verdict ?? "—"} ${expected.join(", ") || "no finding"}`,
			(verdict === null || report.verdict === verdict) &&
				expected.every((c) => found.includes(c)) &&
				(expected.length > 0 || found.length === 0),
			`${report.verdict} · ${found.join(", ")}`,
		);
	}

	// 2. Root causes, not symptoms
	const h = reports["h-pg-upgraded"];
	check(
		"h: the unapplied config is attributed to the incompatible data (no redeploy proposed)",
		!finding(h, "CONFIG_NOT_APPLIED") ||
			(finding(h, "CONFIG_NOT_APPLIED").causedBy?.includes(
				"DATA_DIRECTORY_INCOMPATIBLE",
			) &&
				!finding(h, "CONFIG_NOT_APPLIED").recommendedFix.action),
	);
	const m = reports["m-compose-broken"];
	check(
		"m: the worker crash is attributed to the missing variable",
		finding(m, "CONTAINER_CRASH_LOOP", "worker")?.causedBy?.includes(
			"MISSING_ENVIRONMENT_VARIABLE",
		),
	);
	check(
		"m: services listed with their state",
		["api", "web", "worker"].every((n) =>
			m.facts.services?.some((s) => s.name === n),
		),
		m.facts.services?.map((s) => `${s.name}:${s.verdict}`).join(" "),
	);
	const helpers = await call(
		"/api/docker.getContainers",
		undefined,
		"GET",
	).catch(() => null);
	check(
		"no helper container left behind (port probing)",
		!JSON.stringify(helpers ?? "").includes("listening-probe"),
	);

	// 3. Fixes, applied for real
	const portFix = finding(m, "PORT_MISMATCH", "web")?.recommendedFix.action;
	check(
		"m: port fix proposed (8081)",
		portFix?.port === 8081,
		JSON.stringify(portFix),
	);
	if (portFix) {
		const original = (
			await get("domain.byComposeId", {
				composeId: services["m-compose-broken"].id,
			})
		).find((d) => d.domainId === portFix.domainId);
		restore.push(async () => {
			await call("/api/domain.update", {
				domainId: original.domainId,
				host: original.host,
				path: original.path,
				port: original.port,
				https: original.https,
				certificateType: original.certificateType,
				serviceName: original.serviceName,
				domainType: original.domainType,
				internalPath: original.internalPath,
				stripPath: original.stripPath,
			});
			await call("/api/compose.redeploy", {
				composeId: services["m-compose-broken"].id,
			});
		});
		await call("/api/smartDeploy.applyServiceFix", {
			serviceType: "compose",
			serviceId: services["m-compose-broken"].id,
			action: portFix,
		});
		let status = 0;
		for (let i = 0; i < 30 && status !== 200; i++) {
			await wait(4000);
			status = await viaTraefik("m-compose.docker.localhost");
		}
		check(
			"m: after fix + redeploy, the domain answers 200",
			status === 200,
			`HTTP ${status}`,
		);
	}

	const kFix = finding(reports["k-mongo-stopped"], "SERVICE_STOPPED")
		?.recommendedFix.action;
	if (kFix) {
		await call("/api/smartDeploy.applyServiceFix", {
			serviceType: "mongo",
			serviceId: services["k-mongo-stopped"].id,
			action: kFix,
		});
		restore.push(() =>
			call("/api/mongo.stop", { mongoId: services["k-mongo-stopped"].id }),
		);
		let verdict = "";
		for (let i = 0; i < 20 && verdict !== "healthy"; i++) {
			await wait(4000);
			verdict = (await diagnose("k-mongo-stopped")).verdict;
		}
		check(
			"k: one-click \"Start\" → database started and healthy",
			verdict === "healthy",
			verdict,
		);
	}

	const jFix = finding(reports["j-redis-pending"], "CONFIG_NOT_APPLIED")
		?.recommendedFix.action;
	if (jFix) {
		await call("/api/smartDeploy.applyServiceFix", {
			serviceType: "redis",
			serviceId: services["j-redis-pending"].id,
			action: jFix,
		});
		restore.push(async () => {
			await call("/api/redis.update", {
				redisId: services["j-redis-pending"].id,
				dockerImage: "redis:7-alpine",
			});
			await call("/api/redis.deploy", {
				redisId: services["j-redis-pending"].id,
			});
			await call("/api/redis.update", {
				redisId: services["j-redis-pending"].id,
				dockerImage: "redis:7.4-alpine",
			});
		});
		let report;
		for (let i = 0; i < 20; i++) {
			await wait(4000);
			report = await diagnose("j-redis-pending");
			if (report.verdict === "healthy") break;
		}
		check(
			"j: one-click \"Redeploy\" → image applied, database healthy",
			report.verdict === "healthy" &&
				report.facts.database.runningImage === "redis:7.4-alpine",
			`${report.verdict} · ${report.facts.database?.runningImage}`,
		);
	}

	const refused = await call("/api/smartDeploy.applyServiceFix", {
		serviceType: "postgres",
		serviceId: services["l-pg-healthy"].id,
		action: { kind: "redeploy_service" },
	}).catch((e) => e);
	check(
		"fix not proposed by the diagnosis → rejected",
		refused instanceof Error && /not proposed/.test(refused.message),
	);

	// 4. MCP
	if (process.env.DOKPLOY_MCP_URL) {
		const settings = await call("/api/mcp.getSettings", undefined, "GET");
		const client = await registerClient("Smart Deploy services E2E", [
			"mcp:read",
		]);
		restore.push(() =>
			call("/api/mcp.revokeGrant", { clientId: client.client_id }),
		);
		const token = (
			await authorize(client.client_id, ["mcp:read"], settings.organizationId)
		).access_token;
		const res = await toolCall(token, "dokploy_diagnose_service", {
			serviceType: "mysql",
			serviceId: services["i-mysql-bad-image"].id,
		});
		const report = res.json?.result?.structuredContent;
		check(
			"MCP dokploy_diagnose_service (base)",
			report?.findings?.some((f) => f.code === "IMAGE_PULL_FAILED"),
			report?.verdict,
		);
	}
} catch (error) {
	check("scenario ran without exception", false, error.stack);
} finally {
	for (const fn of restore.reverse()) {
		await fn().catch((e) => console.log("restore:", e.message.slice(0, 160)));
	}
	console.log("(demo services restored to their broken state)");
}

summarize();
