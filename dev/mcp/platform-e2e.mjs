// End-to-end test of the MCP tools that cover the whole Dokploy API, against
// the LOCAL dev instance: scopes opt-in, a full lifecycle in a throwaway
// project (create, configure, env vars, domain, deploy, logs, stop/start,
// container command, compose stack, delete), the human confirmation flow and
// its forgery cases, secret masking, and a restricted member.
// Needs dev/phase7/setup-isolation.mjs to have run (member account).
// Usage: node dev/mcp/platform-e2e.mjs
import { randomBytes } from "node:crypto";
import http from "node:http";
import {
	baseUrl,
	call,
	createSession,
	devEnv,
	login,
} from "../demo-apps/api-client.mjs";
import {
	authorize,
	check,
	mcp,
	registerClient,
	summarize,
	toolCall,
} from "./mcp-client.mjs";

const ALL = [
	"mcp:read",
	"mcp:deploy",
	"mcp:config",
	"mcp:env",
	"mcp:manage",
	"mcp:exec",
];
const ELICIT = { capabilities: { elicitation: {} } };
const stamp = Date.now().toString(36);
const result = (res) => res.json?.result ?? {};
const data = (res) => result(res).structuredContent ?? {};
const text = (res) => result(res).content?.[0]?.text ?? res.text;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// fetch() drops a custom Host header; Traefik routes on it.
const getThroughTraefik = (host) =>
	new Promise((resolve) => {
		const req = http.get(
			{ host: "127.0.0.1", port: 8880, path: "/", headers: { host } },
			(res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode, body }));
			},
		);
		req.on("error", () => resolve({ status: 0, body: "" }));
	});

await login();
const settings = await call("/api/mcp.getSettings", undefined, "GET");
const orgId = settings.organizationId;
const cleanup = [];

try {
	// 1. New scopes are opt-in: not granted while the organization does not allow them
	await call("/api/mcp.updateSettings", {
		enabled: true,
		allowedScopes: ["mcp:read", "mcp:deploy", "mcp:config"],
	});
	const client = await registerClient("Dokploy platform E2E", ALL);
	cleanup.push(() =>
		call("/api/mcp.revokeGrant", { clientId: client.client_id }),
	);
	const limited = await authorize(client.client_id, ALL, orgId);
	const limitedExec = await toolCall(
		limited.access_token,
		"dokploy_exec_command",
		{
			serviceType: "application",
			serviceId: "x",
			command: "true",
		},
	);
	check(
		"scopes env/manage/exec non autorisés par l'organisation → non accordés (403)",
		limitedExec.status === 403,
		`HTTP ${limitedExec.status}`,
	);

	// 2. Allow everything, authorize again
	await call("/api/mcp.updateSettings", { enabled: true, allowedScopes: ALL });
	const token = (await authorize(client.client_id, ALL, orgId)).access_token;
	// Mutations are limited per user and client; wait as an agent would.
	let rateLimited = 0;
	const tool = async (name, args = {}, extra = {}, options = {}) => {
		for (;;) {
			const res = await toolCall(token, name, args, extra, options);
			const retry = /Rate limit reached for changes; retry in (\d+)s/.exec(
				text(res),
			);
			if (!retry) return res;
			rateLimited++;
			await wait((Number(retry[1]) + 1) * 1000);
		}
	};

	const confirmed = async (name, args, answer = { confirm: true }) => {
		const first = await tool(name, args, {}, ELICIT);
		const pending = result(first);
		if (pending.resultType !== "input_required") return { first, final: first };
		const final = await tool(
			name,
			args,
			{
				inputResponses: { confirm: { action: "accept", content: answer } },
				requestState: pending.requestState,
			},
			ELICIT,
		);
		return { first, final };
	};

	const names = (result(await mcp(token, "tools/list")).tools ?? []).map(
		(t) => t.name,
	);
	const expected = [
		"dokploy_list_services",
		"dokploy_get_service",
		"dokploy_get_service_logs",
		"dokploy_get_env_vars",
		"dokploy_set_env_vars",
		"dokploy_update_service_settings",
		"dokploy_set_application_source",
		"dokploy_set_build_type",
		"dokploy_update_compose_file",
		"dokploy_create_domain",
		"dokploy_delete_domain",
		"dokploy_deploy_service",
		"dokploy_start_service",
		"dokploy_stop_service",
		"dokploy_cancel_deployment",
		"dokploy_create_project",
		"dokploy_create_environment",
		"dokploy_create_service",
		"dokploy_delete_service",
		"dokploy_delete_environment",
		"dokploy_delete_project",
		"dokploy_list_backup_files",
		"dokploy_run_backup",
		"dokploy_restore_backup",
		"dokploy_exec_command",
	];
	check(
		"tools/list expose les nouveaux outils",
		expected.every((n) => names.includes(n)),
		`${names.length} outils; manquants: ${expected.filter((n) => !names.includes(n)).join(", ") || "aucun"}`,
	);

	const listed = data(await tool("dokploy_list_services"));
	const demo = listed.projects?.find((p) => p.name === "Smart Deploy Demo");
	check(
		"dokploy_list_services : projets, environnements et services typés",
		!!demo?.environments[0]?.services.some(
			(s) => s.serviceType === "application" && s.name === "a-healthy",
		),
	);

	// 3. Throwaway project
	const project = data(
		await tool("dokploy_create_project", { name: `MCP E2E ${stamp}` }),
	);
	check(
		"dokploy_create_project",
		!!project.projectId && !!project.environmentId,
		JSON.stringify(project),
	);
	const staging = data(
		await tool("dokploy_create_environment", {
			projectId: project.projectId,
			name: "staging",
		}),
	);
	check("dokploy_create_environment", !!staging.environmentId);

	const app = data(
		await tool("dokploy_create_service", {
			serviceType: "application",
			environmentId: project.environmentId,
			name: "web",
		}),
	);
	check("dokploy_create_service (application)", !!app.serviceId);
	const appRef = { serviceType: "application", serviceId: app.serviceId };

	const source = await tool("dokploy_set_application_source", {
		applicationId: app.serviceId,
		source: { type: "docker", image: "traefik/whoami:v1.10" },
	});
	check(
		"dokploy_set_application_source (image Docker)",
		data(source).saved === true,
		text(source),
	);

	// 4. Environment variables: masked reads, merge writes
	const secret = `tok-${randomBytes(12).toString("hex")}`;
	const setEnv = await tool("dokploy_set_env_vars", {
		...appRef,
		set: { GREETING: "bonjour", API_TOKEN: secret },
	});
	check(
		"dokploy_set_env_vars (ajout)",
		data(setEnv).saved === true,
		text(setEnv),
	);
	const envRead = await tool("dokploy_get_env_vars", appRef);
	check(
		"dokploy_get_env_vars : valeur normale lisible, secret masqué",
		data(envRead).env?.GREETING === "bonjour" &&
			data(envRead).env?.API_TOKEN === "[secret: set]" &&
			!envRead.text.includes(secret),
		JSON.stringify(data(envRead).env),
	);
	const writeMask = await tool("dokploy_set_env_vars", {
		...appRef,
		set: { API_TOKEN: "[secret: set]" },
	});
	check(
		"réécrire un placeholder masqué est refusé",
		result(writeMask).isError === true,
		text(writeMask),
	);
	await tool("dokploy_set_env_vars", { ...appRef, unset: ["GREETING"] });
	const described = data(await tool("dokploy_get_service", appRef));
	check(
		"dokploy_set_env_vars (suppression) garde les autres variables",
		described.envKeys?.includes("API_TOKEN") &&
			!described.envKeys?.includes("GREETING"),
		JSON.stringify(described.envKeys),
	);
	check(
		"dokploy_get_service ne renvoie aucun secret",
		!JSON.stringify(described).includes(secret) &&
			!("env" in described) &&
			!("password" in described),
	);

	// 5. Settings, domain, deploy, logs
	const settingsRes = await tool("dokploy_update_service_settings", {
		...appRef,
		description: "Created by the MCP e2e test",
		replicas: 1,
	});
	check(
		"dokploy_update_service_settings",
		data(settingsRes).updated?.includes("replicas"),
		text(settingsRes),
	);
	const badSetting = await tool("dokploy_update_service_settings", {
		...appRef,
		dockerImage: "nginx",
	});
	check(
		"réglage non applicable au type de service → refus explicite",
		result(badSetting).isError === true,
		text(badSetting),
	);

	const host = `mcp-e2e-${stamp}.docker.localhost`;
	const domain = data(
		await tool("dokploy_create_domain", {
			...appRef,
			host,
			port: 80,
		}),
	);
	check("dokploy_create_domain", !!domain.domainId, JSON.stringify(domain));

	const deploy = await tool("dokploy_deploy_service", appRef);
	check(
		"dokploy_deploy_service (application)",
		data(deploy).queued === true,
		text(deploy),
	);
	let status = "";
	for (let i = 0; i < 40 && status !== "done" && status !== "error"; i++) {
		await wait(3000);
		status = data(await tool("dokploy_get_service", appRef)).applicationStatus;
	}
	check("le déploiement se termine", status === "done", status);
	let httpStatus = 0;
	let body = "";
	for (let i = 0; i < 15 && httpStatus !== 200; i++) {
		({ status: httpStatus, body } = await getThroughTraefik(host));
		if (httpStatus !== 200) await wait(2000);
	}
	check(
		"le domaine créé par MCP sert l'application",
		httpStatus === 200 && body.includes("Hostname"),
		`HTTP ${httpStatus}`,
	);
	const logs = await tool("dokploy_get_service_logs", { ...appRef, tail: 50 });
	check(
		"dokploy_get_service_logs (application)",
		!result(logs).isError && text(logs).length > 0,
		text(logs).slice(0, 120),
	);

	// 6. Database + container command with human confirmation
	const db = data(
		await tool("dokploy_create_service", {
			serviceType: "postgres",
			environmentId: project.environmentId,
			name: "db",
			dockerImage: "postgres:16-alpine",
		}),
	);
	const dbRef = { serviceType: "postgres", serviceId: db.serviceId };
	const dbDescribed = await tool("dokploy_get_service", dbRef);
	check(
		"dokploy_create_service (postgres) : mot de passe généré, jamais renvoyé",
		!!db.serviceId && !/password/i.test(JSON.stringify(data(dbDescribed))),
		JSON.stringify(data(dbDescribed)).slice(0, 160),
	);
	await tool("dokploy_deploy_service", dbRef);
	status = "";
	for (let i = 0; i < 40 && status !== "done" && status !== "error"; i++) {
		await wait(3000);
		status = data(await tool("dokploy_get_service", dbRef)).applicationStatus;
	}
	check("la base de données démarre", status === "done", status);
	for (let i = 0; i < 20; i++) {
		const probe = await tool("dokploy_get_service_logs", {
			...dbRef,
			tail: 20,
		});
		if (text(probe).includes("ready to accept connections")) break;
		await wait(2000);
	}

	const command = "echo hello-mcp; printenv POSTGRES_PASSWORD";
	const execArgs = { ...dbRef, command };
	const noElicit = await tool("dokploy_exec_command", execArgs);
	check(
		"commande sans client compatible confirmation → refus clair",
		result(noElicit).isError === true &&
			text(noElicit).includes("does not support confirmation"),
		text(noElicit).slice(0, 120),
	);

	const ask = await tool("dokploy_exec_command", execArgs, {}, ELICIT);
	const pending = result(ask);
	check(
		"commande → demande de confirmation (input_required) avec la commande exacte",
		pending.resultType === "input_required" &&
			pending.inputRequests?.confirm?.params?.message?.includes(command) &&
			!!pending.requestState,
		pending.inputRequests?.confirm?.params?.message,
	);
	const declined = await tool(
		"dokploy_exec_command",
		execArgs,
		{
			inputResponses: { confirm: { action: "decline" } },
			requestState: pending.requestState,
		},
		ELICIT,
	);
	check(
		"confirmation refusée → rien n'est exécuté",
		result(declined).isError === true && text(declined).includes("Cancelled"),
		text(declined),
	);
	const forged = await tool(
		"dokploy_exec_command",
		execArgs,
		{
			inputResponses: {
				confirm: { action: "accept", content: { confirm: true } },
			},
			requestState: `${pending.requestState.slice(0, -4)}AAAA`,
		},
		ELICIT,
	);
	check(
		"état de confirmation falsifié → requête rejetée",
		!!forged.json?.error && !text(forged).includes("hello-mcp"),
		JSON.stringify(forged.json?.error ?? result(forged)).slice(0, 120),
	);
	const swapped = await tool(
		"dokploy_exec_command",
		{ ...dbRef, command: "echo swapped" },
		{
			inputResponses: {
				confirm: { action: "accept", content: { confirm: true } },
			},
			requestState: pending.requestState,
		},
		ELICIT,
	);
	check(
		"confirmation réutilisée pour une autre commande → nouvelle confirmation demandée",
		result(swapped).resultType === "input_required" &&
			!swapped.text.includes("swapped\\n"),
		result(swapped).resultType,
	);
	const noState = await tool(
		"dokploy_exec_command",
		execArgs,
		{
			inputResponses: {
				confirm: { action: "accept", content: { confirm: true } },
			},
		},
		ELICIT,
	);
	check(
		"acceptation sans état signé → nouvelle confirmation demandée",
		result(noState).resultType === "input_required",
		result(noState).resultType,
	);
	const approved = await tool(
		"dokploy_exec_command",
		execArgs,
		{
			inputResponses: {
				confirm: { action: "accept", content: { confirm: true } },
			},
			requestState: pending.requestState,
		},
		ELICIT,
	);
	const out = data(approved);
	check(
		"commande confirmée → exécutée, sortie renvoyée",
		out.exitCode === 0 && out.stdout?.includes("hello-mcp"),
		JSON.stringify(out).slice(0, 200),
	);
	check(
		"sortie de commande : mot de passe de la base masqué",
		out.stdout?.includes("[REDACTED") &&
			!/hello-mcp\n[0-9a-f]{48}/.test(out.stdout),
		out.stdout,
	);
	const failing = await confirmed("dokploy_exec_command", {
		...dbRef,
		command: "echo oops >&2; exit 3",
	});
	check(
		"commande en échec → code de sortie et stderr",
		data(failing.final).exitCode === 3 &&
			result(failing.final).isError === true &&
			data(failing.final).stderr?.includes("oops"),
		JSON.stringify(data(failing.final)),
	);

	// 7. Stop (confirmed) and start
	const stop = await confirmed("dokploy_stop_service", appRef);
	check(
		"dokploy_stop_service demande confirmation puis arrête",
		result(stop.first).resultType === "input_required" &&
			data(stop.final).stopped === true,
		text(stop.final),
	);
	const start = await tool("dokploy_start_service", appRef);
	check("dokploy_start_service", data(start).started === true, text(start));

	const deleteDomain = await confirmed("dokploy_delete_domain", {
		domainId: domain.domainId,
	});
	check(
		"dokploy_delete_domain (confirmé), nom d'hôte dans la question",
		result(
			deleteDomain.first,
		).inputRequests?.confirm?.params?.message?.includes(host) &&
			data(deleteDomain.final).deleted === domain.domainId,
		text(deleteDomain.final),
	);

	// 8. Compose stack
	const compose = data(
		await tool("dokploy_create_service", {
			serviceType: "compose",
			environmentId: staging.environmentId,
			name: "stack",
			composeFile:
				"services:\n  whoami:\n    image: traefik/whoami:v1.10\n    command: --port 8081\n",
		}),
	);
	const composeRef = { serviceType: "compose", serviceId: compose.serviceId };
	check(
		"dokploy_create_service (compose, fichier fourni)",
		!!compose.serviceId,
	);
	await tool("dokploy_deploy_service", composeRef);
	status = "";
	for (let i = 0; i < 40 && status !== "done" && status !== "error"; i++) {
		await wait(3000);
		status = data(await tool("dokploy_get_service", composeRef)).composeStatus;
	}
	check("le compose se déploie", status === "done", status);
	let composeLogs;
	for (let i = 0; i < 10; i++) {
		composeLogs = await tool("dokploy_get_service_logs", composeRef);
		if (text(composeLogs).includes("8081")) break;
		await wait(2000);
	}
	check(
		"dokploy_get_service_logs (compose, conteneur choisi)",
		text(composeLogs).includes("8081"),
		text(composeLogs).slice(0, 120),
	);

	// 9. Restricted member: Dokploy permissions still apply through every new tool
	const member = createSession();
	await member.signIn(devEnv.DEMO_MEMBER_EMAIL, devEnv.DEMO_MEMBER_PASSWORD);
	const memberClient = await registerClient(
		"Dokploy platform E2E (member)",
		ALL,
	);
	const memberToken = (
		await authorize(memberClient.client_id, ALL, orgId, member)
	).access_token;
	const memberTool = (name, args = {}, options = {}) =>
		toolCall(memberToken, name, args, {}, options);
	const memberList = data(await memberTool("dokploy_list_services"));
	check(
		"membre : ne voit ni le projet restreint ni le projet de test",
		!memberList.projects?.some(
			(p) => p.name === "Restricted project" || p.name === `MCP E2E ${stamp}`,
		),
		memberList.projects?.map((p) => p.name).join(", "),
	);
	const memberRead = await memberTool("dokploy_get_env_vars", appRef);
	check(
		"membre : variables d'un service non accessible → refus",
		result(memberRead).isError === true &&
			!memberRead.text.includes("API_TOKEN"),
		text(memberRead).slice(0, 120),
	);
	const memberDelete = await memberTool(
		"dokploy_delete_service",
		appRef,
		ELICIT,
	);
	check(
		"membre : suppression d'un service non accessible → refus avant toute confirmation",
		result(memberDelete).isError === true &&
			result(memberDelete).resultType !== "input_required",
		text(memberDelete).slice(0, 120),
	);
	const memberExec = await memberTool("dokploy_exec_command", execArgs, ELICIT);
	check(
		"membre : commande dans un service non accessible → refus",
		result(memberExec).isError === true &&
			result(memberExec).resultType !== "input_required",
		text(memberExec).slice(0, 120),
	);
	await call("/api/mcp.revokeGrant", {
		clientId: memberClient.client_id,
	}).catch(() =>
		member.call("/api/mcp.revokeGrant", { clientId: memberClient.client_id }),
	);

	check(
		"limite de mutations par client atteinte puis respectée",
		rateLimited > 0,
		`${rateLimited} attente(s)`,
	);

	// 10. Audit trail
	const audit = await call("/api/mcp.auditLog?limit=200", undefined, "GET");
	const execAudit = audit.filter((a) => a.name === "dokploy_exec_command");
	check(
		"audit : demande de confirmation, refus et exécution tracés",
		["confirmation_requested", "declined", "ok"].every((o) =>
			execAudit.some((a) => a.outcome === o),
		) && !JSON.stringify(audit).includes(secret),
		execAudit.map((a) => a.outcome).join(","),
	);

	// 11. Cleanup through MCP itself
	for (const ref of [appRef, dbRef, composeRef]) {
		const removed = await confirmed("dokploy_delete_service", {
			...ref,
			deleteVolumes: ref.serviceType === "compose",
		});
		check(
			`dokploy_delete_service (${ref.serviceType}, confirmé)`,
			data(removed.final).deleted === ref.serviceId,
			text(removed.final).slice(0, 120),
		);
	}
	const removedEnv = await confirmed("dokploy_delete_environment", {
		environmentId: staging.environmentId,
	});
	check(
		"dokploy_delete_environment (confirmé)",
		data(removedEnv.final).deleted === staging.environmentId,
		text(removedEnv.final),
	);
	const removedProject = await confirmed("dokploy_delete_project", {
		projectId: project.projectId,
	});
	const after = data(await tool("dokploy_list_services"));
	check(
		"dokploy_delete_project (confirmé) → projet disparu",
		data(removedProject.final).deleted === project.projectId &&
			!after.projects?.some((p) => p.projectId === project.projectId),
		text(removedProject.final),
	);
} catch (error) {
	check("exécution du scénario sans exception", false, error.stack);
} finally {
	for (const fn of cleanup) await fn().catch(() => {});
	await call("/api/mcp.updateSettings", {
		enabled: settings.enabled,
		allowedScopes: settings.allowedScopes,
	});
	console.log(
		`(réglages MCP restaurés : ${settings.allowedScopes.join(" ")}; ${baseUrl})`,
	);
}

summarize();
