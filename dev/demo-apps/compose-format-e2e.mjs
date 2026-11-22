// End-to-end check of the compose editor's Format button: a messy compose file
// is formatted exactly as the UI does it, saved, deployed for real by Dokploy,
// then the stack is checked (containers healthy, page served, Smart Deploy
// verdict) and deleted.
// Usage, inside the devbox (it needs tsx for the TypeScript import):
//   docker exec dokploy-devbox sh -c 'cd /workspace && DOKPLOY_DEV_URL=http://127.0.0.1:3000 apps/dokploy/node_modules/.bin/tsx dev/demo-apps/compose-format-e2e.mjs'
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { formatYaml } from "../../apps/dokploy/utils/format-yaml.ts";
import { call, login } from "./api-client.mjs";

const results = [];
const check = (name, ok, detail = "") => {
	results.push(ok);
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
	);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (path, params) =>
	call(`/api/${path}?${new URLSearchParams(params)}`, undefined, "GET");

const messy = readFileSync(
	new URL(
		"../../apps/dokploy/__test__/compose/fixtures/messy-compose.yml",
		import.meta.url,
	),
	"utf8",
);
const formatted = formatYaml(messy);
check(
	"Format accepts the messy file",
	formatted.ok && formatted.warnings.length === 0,
);
if (!formatted.ok) process.exit(1);

await login();
const demo = (await call("/api/project.all", undefined, "GET")).find(
	(p) => p.name === "Smart Deploy Demo",
);
const environmentId = demo.environments[0].environmentId;
const created = await call("/api/compose.create", {
	name: "format-e2e",
	environmentId,
	composeType: "docker-compose",
});
const composeId = created.composeId;

try {
	await call("/api/compose.update", {
		composeId,
		composeFile: formatted.formatted,
		composePath: "./docker-compose.yml",
		sourceType: "raw",
	});
	const saved = await get("compose.one", { composeId });
	check(
		"saved file is the formatted one",
		saved.composeFile === formatted.formatted,
	);

	await call("/api/compose.deploy", { composeId });
	let compose;
	for (let i = 0; i < 90; i++) {
		await wait(2000);
		compose = await get("compose.one", { composeId });
		if (["done", "error"].includes(compose.composeStatus)) break;
	}
	check(
		"Dokploy deployment finishes",
		compose.composeStatus === "done",
		compose.composeStatus,
	);

	let ps = "";
	for (let i = 0; i < 30; i++) {
		ps = execFileSync("docker", [
			"ps",
			"--filter",
			`label=com.docker.compose.project=${compose.appName}`,
			"--format",
			'{{.Label "com.docker.compose.service"}} {{.Status}} {{.Label "com.example.stack"}}',
		]).toString();
		if (/cache .*\(healthy\)/.test(ps) && /web Up/.test(ps)) break;
		await wait(2000);
	}
	console.log(ps.trim());
	check(
		"both services run, cache healthy (healthcheck nesting kept)",
		/cache .*\(healthy\)/.test(ps) && /web Up/.test(ps),
	);
	check(
		"anchor and merge key applied (label from x-common on both services)",
		(ps.match(/format-test/g) ?? []).length === 2,
	);

	const page = await fetch("http://127.0.0.1:18080/").then((r) => r.text());
	check(
		"web serves the page written by the block-scalar command",
		page.includes("<h1>formatted</h1>"),
		page.trim(),
	);

	const webId = execFileSync("docker", [
		"ps",
		"-q",
		"--filter",
		`label=com.docker.compose.project=${compose.appName}`,
		"--filter",
		"label=com.docker.compose.service=web",
	])
		.toString()
		.trim();
	const vars = execFileSync("docker", [
		"inspect",
		webId,
		"--format",
		"{{range .Config.Env}}{{println .}}{{end}}",
	]).toString();
	check(
		"quoted environment value kept intact",
		vars.includes("QUOTED=a: b # not a comment") &&
			vars.includes("GREETING=hello world"),
	);

	const diagnosis = await get("smartDeploy.diagnoseService", {
		serviceType: "compose",
		serviceId: composeId,
	});
	check(
		"Smart Deploy finds nothing wrong",
		diagnosis.verdict === "healthy",
		`${diagnosis.verdict}${diagnosis.issues?.length ? `: ${diagnosis.issues.map((i) => i.code).join(", ")}` : ""}`,
	);
} catch (error) {
	check("scenario runs without exception", false, error.stack);
} finally {
	await call("/api/compose.delete", { composeId, deleteVolumes: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
