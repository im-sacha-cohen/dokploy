import path from "node:path";
import { paths } from "@dokploy/server/constants";
import {
	type Application,
	findApplicationById,
} from "@dokploy/server/services/application";
import { getEnvironmentVariablesObject } from "@dokploy/server/utils/docker/utils";
import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import { cloneGitRepository } from "@dokploy/server/utils/providers/git";
import { cloneGiteaRepository } from "@dokploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@dokploy/server/utils/providers/gitlab";
import { nanoid } from "nanoid";
import { quote } from "shell-quote";
import { parseEnvFileKeys } from "../diagnostics/log-patterns";
import { createRedactor } from "../diagnostics/redact";
import { runOn } from "../versioning/shell";
import { describeSource } from "../versioning/source";
import { analyzeSnapshot } from "./analyze";
import type {
	PreflightConfig,
	PreflightReport,
	RepositorySnapshot,
} from "./types";

const MAX_FILE_BYTES = 65_536;
const CANDIDATE_FILES = [
	"package.json",
	"tsconfig.json",
	"requirements.txt",
	"pyproject.toml",
	"Pipfile",
	"Gemfile",
	"composer.json",
	"Procfile",
	"go.mod",
	"Cargo.toml",
	"docker-compose.yml",
	"docker-compose.yaml",
	"compose.yml",
	"compose.yaml",
	".env.example",
	".env.sample",
	".env.template",
];
const CODE_PATHSPECS = [
	"*.js",
	"*.mjs",
	"*.cjs",
	"*.jsx",
	"*.ts",
	"*.tsx",
	"*.py",
	"*.go",
	"*.rb",
	"*.php",
	"*.rs",
	"*.java",
	"*.kt",
	"*.cs",
	":!:**/node_modules/**",
	":!:**/dist/**",
	":!:**/vendor/**",
	":!:*.min.js",
];
const ENV_GREP =
	'process\\.env(\\.[A-Z][A-Z0-9_]+|\\[[\'"][A-Z][A-Z0-9_]+[\'"]\\])|import\\.meta\\.env\\.[A-Z][A-Z0-9_]+|os\\.environ(\\.get)?\\(?\\[?[\'"][A-Z][A-Z0-9_]+|os\\.getenv\\([\'"][A-Z][A-Z0-9_]+|os\\.Getenv\\("[A-Z][A-Z0-9_]+|ENV(\\.fetch\\(|\\[)[\'"][A-Z][A-Z0-9_]+|env::var\\("[A-Z][A-Z0-9_]+|env\\([\'"][A-Z][A-Z0-9_]+';
const LISTEN_GREP =
	"\\.listen\\(|app\\.run\\(|PORT *(\\|\\||\\?\\?)|--host|uvicorn\\.run|['\"`]/(api/)?(health|healthz|status)['\"`]|host *[:=] *['\"](127\\.0\\.0\\.1|localhost)['\"]";

const sourceBuildPath = (app: Application) => {
	switch (app.sourceType) {
		case "github":
			return app.buildPath;
		case "gitlab":
			return app.gitlabBuildPath;
		case "bitbucket":
			return app.bitbucketBuildPath;
		case "gitea":
			return app.giteaBuildPath;
		case "drop":
			return app.dropBuildPath;
		case "git":
			return app.customGitBuildPath;
		default:
			return "";
	}
};

/** Shell script that prints a marker-delimited snapshot of the working tree. */
export const snapshotScript = (dir: string, dockerfilePath: string) => {
	const files = [...new Set([...CANDIDATE_FILES, dockerfilePath])];
	return [
		// Never fall back to the server's working directory.
		`cd ${quote([dir])} || exit 1`,
		'echo "@@HEAD"',
		"git rev-parse HEAD 2>/dev/null || echo",
		'echo "@@FILES"',
		"(git ls-files 2>/dev/null || find . -type f -not -path './.git/*' | sed 's|^\\./||') | head -n 3000",
		`for f in ${quote(files)}; do if [ -f "$f" ] && [ "$(wc -c < "$f")" -le ${MAX_FILE_BYTES} ]; then echo "@@FILE $f"; cat "$f"; echo; echo "@@ENDFILE"; fi; done`,
		'echo "@@ENVREFS"',
		`git grep -h -o -E ${quote([ENV_GREP])} -- ${quote(CODE_PATHSPECS)} 2>/dev/null | sort -u | head -n 500`,
		'echo "@@LISTEN"',
		`git grep -h -E ${quote([LISTEN_GREP])} -- ${quote(CODE_PATHSPECS)} 2>/dev/null | head -n 80`,
		'echo "@@END"',
	].join("\n");
};

export const parseSnapshotOutput = (
	output: string,
): RepositorySnapshot | null => {
	const start = output.indexOf("@@HEAD\n");
	if (start === -1 || !output.includes("@@END")) return null;
	const lines = output.slice(start).split("\n");
	const snapshot: RepositorySnapshot = {
		commitSha: null,
		files: [],
		contents: {},
		envReferences: [],
		listenLines: [],
		truncated: false,
	};
	let section = "";
	let currentFile: string | null = null;
	let buffer: string[] = [];

	for (const line of lines) {
		if (currentFile) {
			if (line === "@@ENDFILE") {
				snapshot.contents[currentFile] = buffer.join("\n").replace(/\n$/, "");
				currentFile = null;
				buffer = [];
			} else {
				buffer.push(line);
			}
			continue;
		}
		if (line.startsWith("@@FILE ")) {
			currentFile = line.slice(7);
			continue;
		}
		if (/^@@(HEAD|FILES|ENVREFS|LISTEN|END)$/.test(line)) {
			section = line;
			continue;
		}
		if (!line) continue;
		if (section === "@@HEAD" && /^[0-9a-f]{40}$/.test(line))
			snapshot.commitSha = line;
		else if (section === "@@FILES") snapshot.files.push(line);
		else if (section === "@@ENVREFS") snapshot.envReferences.push(line);
		else if (section === "@@LISTEN") snapshot.listenLines.push(line);
	}
	snapshot.truncated = snapshot.files.length >= 3000;
	return snapshot;
};

const cloneCommand = async (
	app: Application,
	serverId: string | null,
	dir: string,
) => {
	const entity = {
		...app,
		serverId,
		outputPathOverride: dir,
		type: "application" as const,
	};
	switch (app.sourceType) {
		case "github":
			return cloneGithubRepository(entity);
		case "gitlab":
			return cloneGitlabRepository(entity);
		case "gitea":
			return cloneGiteaRepository(entity);
		case "bitbucket":
			return cloneBitbucketRepository(entity);
		case "git":
			return cloneGitRepository(entity);
		default:
			return null;
	}
};

/**
 * Analyses the repository before deploying: shallow-clones the configured
 * branch into a temporary directory (deleted on exit), reads a few manifest
 * files and greps the code. Never builds or runs anything from the repository.
 */
export const runPreflight = async (
	applicationId: string,
): Promise<PreflightReport> => {
	const started = Date.now();
	const app = await findApplicationById(applicationId);
	const source = describeSource(app);
	const buildPath = (sourceBuildPath(app) ?? "").replace(/^\/+/, "");
	const serverId = app.buildServerId || app.serverId;

	let env: Record<string, string> = {};
	try {
		env = getEnvironmentVariablesObject(
			app.env,
			app.environment.project.env,
			app.environment.env,
		);
	} catch {
		env = Object.fromEntries(
			parseEnvFileKeys(app.env ?? "").map((k) => [k, ""]),
		);
	}
	const redact = createRedactor(env);

	const config: PreflightConfig = {
		buildType: app.buildType,
		dockerfilePath: app.dockerfile || "Dockerfile",
		buildPath,
		domains: app.domains.map((d) => ({
			domainId: d.domainId,
			host: d.host,
			port: d.port ?? null,
		})),
		envKeys: Object.keys(env),
		swarmHealthcheck: !!app.healthCheckSwarm?.Test?.length,
	};

	const base: Omit<PreflightReport, keyof ReturnType<typeof analyzeSnapshot>> =
		{
			generatedAt: new Date().toISOString(),
			source: {
				type: app.sourceType,
				repository: source.repository,
				branch: source.branch,
				commitSha: null,
				buildPath: buildPath || "/",
			},
			durationMs: 0,
		};
	const empty = analyzeSnapshot(
		{
			commitSha: null,
			files: [],
			contents: {},
			envReferences: [],
			listenLines: [],
			truncated: false,
		},
		config,
	);
	const unavailable = (reason: string): PreflightReport => ({
		...base,
		...empty,
		checks: [
			{
				code: "SOURCE_UNAVAILABLE",
				severity: "warning",
				confidence: "high",
				title: "Source code not analyzed",
				detail: reason,
				recommendation:
					"Check the source (repository, branch, access) in the General tab.",
			},
			...empty.checks.filter((c) => c.code === "NO_DOMAIN"),
		],
		durationMs: Date.now() - started,
		error: reason,
	});

	let script: string;
	if (app.sourceType === "docker") {
		return unavailable(
			"The source is a Docker image: there is no code to analyze.",
		);
	}
	if (app.sourceType === "drop") {
		const codeDir = path.join(
			paths(!!serverId).APPLICATIONS_PATH,
			app.appName,
			"code",
			buildPath,
		);
		script = snapshotScript(codeDir, config.dockerfilePath);
	} else {
		const tmp = path.join(
			paths(!!serverId).BASE_PATH,
			"smart-deploy",
			"preflight",
			`${app.appName}-${nanoid(8)
				.toLowerCase()
				.replace(/[^a-z0-9]/g, "x")}`,
		);
		const clone = await cloneCommand(app, serverId, tmp);
		if (!clone)
			return unavailable(`Source "${app.sourceType}" is not supported.`);
		script = [
			`trap ${quote([`rm -rf ${tmp}`])} EXIT`,
			`(${clone}) >/dev/null 2>&1`,
			snapshotScript(path.join(tmp, buildPath), config.dockerfilePath),
		].join("\n");
	}

	const result = await runOn(serverId, script);
	const snapshot = parseSnapshotOutput(result.stdout);
	if (!snapshot) {
		return unavailable(
			"The repository could not be cloned or read (access, missing branch or invalid build path).",
		);
	}

	const analysis = analyzeSnapshot(snapshot, config);
	if (analysis.startCommand)
		analysis.startCommand.value = redact(analysis.startCommand.value);
	if (analysis.dockerfile?.value.cmd) {
		analysis.dockerfile.value.cmd = redact(analysis.dockerfile.value.cmd);
	}
	for (const check of analysis.checks) check.detail = redact(check.detail);
	for (const port of analysis.ports) port.evidence = redact(port.evidence);

	return {
		...base,
		...analysis,
		source: { ...base.source, commitSha: snapshot.commitSha },
		durationMs: Date.now() - started,
	};
};

export type { PreflightCheck, PreflightReport } from "./types";
