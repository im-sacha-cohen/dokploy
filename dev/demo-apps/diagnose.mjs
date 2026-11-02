// Runs smartDeploy.diagnoseApplication on every app of the "Smart Deploy Demo"
// project of the LOCAL dev instance and prints a summary.
// Usage: node dev/demo-apps/diagnose.mjs [app-name-filter] [--json]
import { call, login } from "./api-client.mjs";

const asJson = process.argv.includes("--json");
const filter = process.argv.slice(2).find((a) => !a.startsWith("--"));

await login();
const projects = await call("/api/project.all", undefined, "GET");
const project = projects.find((p) => p.name === "Smart Deploy Demo");
if (!project)
	throw new Error('Project "Smart Deploy Demo" not found: run seed.mjs first');

const apps = project.environments
	.flatMap((e) => e.applications ?? [])
	.filter((a) => !filter || a.name.includes(filter))
	.sort((a, b) => a.name.localeCompare(b.name));

for (const app of apps) {
	const query = new URLSearchParams({ applicationId: app.applicationId });
	const report = await call(
		`/api/smartDeploy.diagnoseApplication?${query}`,
		undefined,
		"GET",
	);
	if (asJson) {
		console.log(JSON.stringify(report, null, 2));
		continue;
	}
	console.log(`\n${app.name}  →  ${report.verdict.toUpperCase()}`);
	for (const f of report.findings) {
		const fix = f.autoFixable
			? "  [fix auto possible, confirmation requise]"
			: "";
		const cause = f.causedBy
			? `  (conséquence de ${f.causedBy.join(", ")})`
			: "";
		console.log(
			`  - ${f.code} [${f.severity}/${f.confidence}] ${f.title}${cause}${fix}`,
		);
	}
	for (const e of report.collectionErrors) {
		console.log(`  ! non collecté (${e.source}) : ${e.message}`);
	}
}
