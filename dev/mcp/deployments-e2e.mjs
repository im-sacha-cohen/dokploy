// End-to-end test of what an MCP client sees of deployments, Smart Deploy and
// logs, against the LOCAL dev instance: application and compose deployments,
// build logs, status, timeline, preflight, diagnosis and applying a proposed
// fix (on demo app B, whose wrong port is restored afterwards), plus a
// restricted member.
// Usage: node dev/mcp/deployments-e2e.mjs
// (when /mcp is reached through a tunnel, also set DOKPLOY_MCP_URL)
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
const projects = await call("/api/project.all", undefined, "GET");
const demo = projects.find((p) => p.name === "Smart Deploy Demo");
const apps = demo.environments.flatMap((e) => e.applications);
const appA = apps.find((a) => a.name === "a-healthy").applicationId;
const appB = apps.find((a) => a.name === "b-wrong-port").applicationId;
const composeF = demo.environments
	.flatMap((e) => e.compose)
	.find((c) => c.name.startsWith("f-"))?.composeId;

const scopes = ["mcp:read", "mcp:deploy", "mcp:config"];
const client = await registerClient("Dokploy deployments E2E", scopes);
const token = (
	await authorize(client.client_id, scopes, settings.organizationId)
).access_token;
const tool = (name, args = {}) => toolCall(token, name, args);
let restoreB = null;

try {
	// 1. Application deployments, status, logs, timeline
	const appDeployments = data(
		await tool("dokploy_get_deployments", { applicationId: appA, limit: 5 }),
	).deployments;
	check(
		"application deployments",
		appDeployments?.length > 0,
		`${appDeployments?.length} deployment(s)`,
	);
	const appDeploymentId = appDeployments[0].deploymentId;
	const timeline = data(
		await tool("dokploy_get_deployment_timeline", {
			deploymentId: appDeploymentId,
		}),
	);
	check(
		"Smart Deploy timeline of an application deployment",
		Array.isArray(timeline.events) &&
			timeline.events.length > 0 &&
			!("logPath" in timeline),
		`${timeline.events?.length} steps, status ${timeline.status}`,
	);
	const appLogs = data(
		await tool("dokploy_get_deployment_logs", {
			deploymentId: appDeploymentId,
			lines: 20,
		}),
	);
	check("build logs of an application", appLogs.lines?.length > 0);

	// 2. Compose deployments, status, logs
	check("demo compose F present", !!composeF);
	const composeDeployments = data(
		await tool("dokploy_get_deployments", { composeId: composeF, limit: 5 }),
	).deployments;
	check(
		"compose deployments",
		composeDeployments?.length > 0,
		`${composeDeployments?.length} deployment(s)`,
	);
	const composeDeploymentId = composeDeployments[0].deploymentId;
	const composeStatus = data(
		await tool("dokploy_get_deployment_status", {
			deploymentId: composeDeploymentId,
		}),
	);
	check(
		"status of a compose deployment",
		!!composeStatus.status,
		composeStatus.status,
	);
	const composeLogs = data(
		await tool("dokploy_get_deployment_logs", {
			deploymentId: composeDeploymentId,
			lines: 30,
		}),
	);
	check(
		"build logs of a compose",
		composeLogs.lines?.length > 0,
		composeLogs.lines?.slice(-1)[0],
	);
	const both = await tool("dokploy_get_deployments", {
		applicationId: appA,
		composeId: composeF,
	});
	check(
		"applicationId and composeId together → explicit refusal",
		result(both).isError === true,
		text(both),
	);
	const composeTimeline = await tool("dokploy_get_deployment_timeline", {
		deploymentId: composeDeploymentId,
	});
	check(
		"compose timeline → explicit refusal (applications only)",
		result(composeTimeline).isError === true,
		text(composeTimeline),
	);

	// 3. Runtime logs (already covered by platform-e2e, checked again here)
	const runtime = await tool("dokploy_get_service_logs", {
		serviceType: "application",
		serviceId: appA,
		tail: 20,
	});
	check(
		"runtime logs of an application",
		!result(runtime).isError && text(runtime).length > 0,
	);

	// 4. Smart Deploy: preflight, diagnosis, fix
	const preflight = await tool("dokploy_preflight", { applicationId: appA });
	check(
		"Smart Deploy preflight",
		!result(preflight).isError && Object.keys(data(preflight)).length > 0,
		text(preflight).slice(0, 160),
	);
	const diagnosis = data(
		await tool("dokploy_diagnose_deployment", { applicationId: appB }),
	);
	const fix = diagnosis.findings?.find(
		(f) =>
			f.autoFixable && f.recommendedFix?.action?.kind === "update_domain_port",
	)?.recommendedFix.action;
	check(
		"diagnosis of B: port fix proposed",
		!!fix,
		JSON.stringify(fix),
	);
	const forged = await tool("dokploy_apply_fix", {
		applicationId: appB,
		action: { kind: "redeploy_deployment", deploymentId: appDeploymentId },
	});
	check(
		"fix not proposed by the diagnosis → rejected",
		result(forged).isError === true,
		text(forged).slice(0, 160),
	);
	if (fix) {
		const domains = await call(
			`/api/domain.byApplicationId?applicationId=${appB}`,
			undefined,
			"GET",
		);
		const original = domains.find((d) => d.domainId === fix.domainId);
		restoreB = () =>
			call("/api/domain.update", {
				domainId: original.domainId,
				host: original.host,
				path: original.path,
				port: original.port,
				https: original.https,
				certificateType: original.certificateType,
				domainType: original.domainType,
				internalPath: original.internalPath,
				stripPath: original.stripPath,
			});
		const applied = await tool("dokploy_apply_fix", {
			applicationId: appB,
			action: fix,
		});
		const after = await call(
			`/api/domain.byApplicationId?applicationId=${appB}`,
			undefined,
			"GET",
		);
		check(
			"dokploy_apply_fix: domain port fixed",
			data(applied).applied === "update_domain_port" &&
				after.find((d) => d.domainId === fix.domainId)?.port === fix.port,
			text(applied).slice(0, 160),
		);
	}

	// 5. Restricted member
	const member = createSession();
	await member.signIn(devEnv.DEMO_MEMBER_EMAIL, devEnv.DEMO_MEMBER_PASSWORD);
	const memberClient = await registerClient(
		"Dokploy deployments E2E (member)",
		["mcp:read"],
	);
	const memberToken = (
		await authorize(
			memberClient.client_id,
			["mcp:read"],
			settings.organizationId,
			member,
		)
	).access_token;
	const memberCompose = await toolCall(memberToken, "dokploy_get_deployments", {
		composeId: composeF,
	});
	const memberComposeLogs = await toolCall(
		memberToken,
		"dokploy_get_deployment_logs",
		{ deploymentId: composeDeploymentId },
	);
	check(
		"member: deployments and logs of a compose not granted → denied",
		result(memberCompose).isError === true &&
			result(memberComposeLogs).isError === true &&
			text(memberCompose).includes("not found or access denied"),
		text(memberCompose),
	);
	await member.call("/api/mcp.revokeGrant", {
		clientId: memberClient.client_id,
	});
} catch (error) {
	check("scenario ran without exception", false, error.stack);
} finally {
	if (restoreB) {
		await restoreB();
		const restored = (
			await call(
				`/api/domain.byApplicationId?applicationId=${appB}`,
				undefined,
				"GET",
			)
		).find((d) => d.port !== 3000);
		check("B restored to its broken demo state (wrong port)", !!restored);
	}
	await call("/api/mcp.revokeGrant", { clientId: client.client_id });
}

summarize();
