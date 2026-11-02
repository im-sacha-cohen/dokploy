import { parseEnvFileKeys } from "../diagnostics/log-patterns";
import type {
	Detection,
	PortCandidate,
	PreflightAnalysis,
	PreflightCheck,
	PreflightConfig,
	RepositorySnapshot,
} from "./types";

const ENV_NAME = /^[A-Z][A-Z0-9_]+$/;
// Provided by the runtime or by Dokploy itself; never worth flagging.
const PLATFORM_ENV = new Set([
	"NODE_ENV",
	"PORT",
	"HOST",
	"HOSTNAME",
	"PATH",
	"HOME",
	"PWD",
	"TZ",
	"LANG",
	"CI",
	"DOKPLOY_DEPLOY_URL",
]);

const NODE_FRAMEWORKS: [dependency: string, name: string, port?: number][] = [
	["next", "Next.js", 3000],
	["nuxt", "Nuxt", 3000],
	["@remix-run/serve", "Remix", 3000],
	["@sveltejs/kit", "SvelteKit", 3000],
	["astro", "Astro", 4321],
	["@nestjs/core", "NestJS", 3000],
	["@angular/core", "Angular"],
	["fastify", "Fastify"],
	["express", "Express"],
	["hono", "Hono"],
	["koa", "Koa"],
	["vite", "Vite"],
	["react-scripts", "Create React App"],
];

const PYTHON_FRAMEWORKS: [pattern: RegExp, name: string, port: number][] = [
	[/(?:^|["'\s])django\b/im, "Django", 8000],
	[/(?:^|["'\s])fastapi\b/im, "FastAPI", 8000],
	[/(?:^|["'\s])flask\b/im, "Flask", 5000],
];

const COMPOSE_FILES = [
	"docker-compose.yml",
	"docker-compose.yaml",
	"compose.yml",
	"compose.yaml",
];
const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template"];

const has = (snapshot: RepositorySnapshot, file: string) =>
	snapshot.files.includes(file);

const detection = <T>(
	value: T,
	confidence: Detection<T>["confidence"],
	evidence: string[],
): Detection<T> => ({ value, confidence, evidence });

const parsePackageJson = (snapshot: RepositorySnapshot) => {
	const raw = snapshot.contents["package.json"];
	if (!raw) return null;
	try {
		return JSON.parse(raw) as {
			scripts?: Record<string, string>;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			packageManager?: string;
		};
	} catch {
		return null;
	}
};

const detectLanguage = (snapshot: RepositorySnapshot) => {
	if (has(snapshot, "package.json")) {
		const ts =
			has(snapshot, "tsconfig.json") ||
			!!parsePackageJson(snapshot)?.devDependencies?.typescript;
		return detection(
			ts ? "TypeScript (Node.js)" : "JavaScript (Node.js)",
			"high",
			["package.json", ...(ts ? ["tsconfig.json"] : [])],
		);
	}
	const markers: [string[], string][] = [
		[["pyproject.toml", "requirements.txt", "Pipfile"], "Python"],
		[["go.mod"], "Go"],
		[["Cargo.toml"], "Rust"],
		[["Gemfile"], "Ruby"],
		[["composer.json"], "PHP"],
		[["pom.xml", "build.gradle", "build.gradle.kts"], "Java / JVM"],
	];
	for (const [files, language] of markers) {
		const found = files.filter((f) => has(snapshot, f));
		if (found.length) return detection(language, "high", found);
	}
	const csproj = snapshot.files.find((f) => f.endsWith(".csproj"));
	if (csproj) return detection(".NET", "high", [csproj]);
	const byExtension: [RegExp, string][] = [
		[/\.(?:ts|tsx)$/, "TypeScript (Node.js)"],
		[/\.(?:js|mjs|cjs)$/, "JavaScript (Node.js)"],
		[/\.py$/, "Python"],
		[/\.go$/, "Go"],
		[/\.rb$/, "Ruby"],
		[/\.php$/, "PHP"],
	];
	for (const [pattern, language] of byExtension) {
		const sources = snapshot.files.filter(
			(f) => pattern.test(f) && !f.includes("/"),
		);
		if (sources.length) {
			return detection(language, "low", [
				`${sources.slice(0, 3).join(", ")} (sans fichier manifeste)`,
			]);
		}
	}
	if (has(snapshot, "index.html")) {
		return detection("HTML statique", "medium", ["index.html"]);
	}
	return null;
};

const detectFramework = (snapshot: RepositorySnapshot) => {
	const pkg = parsePackageJson(snapshot);
	if (pkg) {
		const deps = { ...pkg.dependencies, ...pkg.devDependencies };
		const match = NODE_FRAMEWORKS.find(([dep]) => dep in deps);
		if (match) {
			return {
				framework: detection(match[1], "high", [`package.json › ${match[0]}`]),
				defaultPort: match[2],
			};
		}
	}
	const requirements = [
		snapshot.contents["requirements.txt"],
		snapshot.contents["pyproject.toml"],
		snapshot.contents.Pipfile,
	]
		.filter(Boolean)
		.join("\n");
	if (requirements) {
		const match = PYTHON_FRAMEWORKS.find(([pattern]) =>
			pattern.test(requirements),
		);
		if (match) {
			return {
				framework: detection(match[1], "high", ["dépendances Python"]),
				defaultPort: match[2],
			};
		}
	}
	if (/^\s*gem ['"]rails['"]/m.test(snapshot.contents.Gemfile ?? "")) {
		return {
			framework: detection("Ruby on Rails", "high", ["Gemfile"]),
			defaultPort: 3000,
		};
	}
	if (/"laravel\/framework"/.test(snapshot.contents["composer.json"] ?? "")) {
		return {
			framework: detection("Laravel", "high", ["composer.json"]),
			defaultPort: 8000,
		};
	}
	return { framework: null, defaultPort: undefined };
};

const detectPackageManager = (snapshot: RepositorySnapshot) => {
	const declared = parsePackageJson(snapshot)?.packageManager?.split("@")[0];
	if (declared)
		return detection(declared, "high", ["package.json › packageManager"]);
	const lockfiles: [string, string][] = [
		["pnpm-lock.yaml", "pnpm"],
		["yarn.lock", "yarn"],
		["package-lock.json", "npm"],
		["bun.lockb", "bun"],
		["bun.lock", "bun"],
		["uv.lock", "uv"],
		["poetry.lock", "poetry"],
		["Pipfile.lock", "pipenv"],
		["requirements.txt", "pip"],
		["go.sum", "go modules"],
		["Cargo.lock", "cargo"],
		["Gemfile.lock", "bundler"],
		["composer.lock", "composer"],
	];
	const found = lockfiles.find(([file]) => has(snapshot, file));
	if (found) return detection(found[1], "high", [found[0]]);
	if (has(snapshot, "package.json")) {
		return detection("npm", "low", ["package.json sans lockfile"]);
	}
	return null;
};

export const parseDockerfile = (content: string) => {
	const lines = content
		.replace(/\\\r?\n/g, " ")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));
	const exposedPorts = new Set<number>();
	let healthcheck = false;
	let cmd: string | null = null;
	const envKeys: string[] = [];

	for (const line of lines) {
		const [instruction = "", ...rest] = line.split(/\s+/);
		const args = rest.join(" ");
		switch (instruction.toUpperCase()) {
			case "EXPOSE":
				for (const token of rest) {
					const port = Number.parseInt(token, 10);
					if (Number.isInteger(port) && port > 0 && port < 65536)
						exposedPorts.add(port);
				}
				break;
			case "HEALTHCHECK":
				healthcheck = !/^NONE\b/i.test(args);
				break;
			case "CMD":
			case "ENTRYPOINT":
				cmd = args;
				break;
			case "ENV":
				for (const match of args.matchAll(
					/([A-Za-z_][A-Za-z0-9_]*)\s*[=\s]/g,
				)) {
					if (match[1]) envKeys.push(match[1]);
				}
				break;
		}
	}
	return { exposedPorts: [...exposedPorts], healthcheck, cmd, envKeys };
};

export const parseComposeServices = (content: string): string[] => {
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((l) => /^services:\s*$/.test(l));
	if (start === -1) return [];
	const services: string[] = [];
	let indent: number | null = null;
	for (const line of lines.slice(start + 1)) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const lineIndent = line.length - line.trimStart().length;
		if (lineIndent === 0) break;
		indent ??= lineIndent;
		const match = line.match(/^\s+([A-Za-z0-9_.-]+):\s*$/);
		if (lineIndent === indent && match?.[1]) services.push(match[1]);
	}
	return services;
};

const ENV_REFERENCE_PATTERNS = [
	/process\.env\.([A-Z][A-Z0-9_]+)/g,
	/process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
	/import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
	/os\.environ(?:\.get)?\(?\[?['"]([A-Z][A-Z0-9_]+)['"]/g,
	/os\.getenv\(['"]([A-Z][A-Z0-9_]+)['"]/g,
	/os\.Getenv\("([A-Z][A-Z0-9_]+)"\)/g,
	/ENV\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
	/ENV\.fetch\(['"]([A-Z][A-Z0-9_]+)['"]/g,
	/env::var\("([A-Z][A-Z0-9_]+)"\)/g,
	/\benv\(['"]([A-Z][A-Z0-9_]+)['"]/g,
];

export const extractEnvReferences = (matches: string[]): string[] => {
	const names = new Set<string>();
	for (const text of matches) {
		for (const pattern of ENV_REFERENCE_PATTERNS) {
			for (const m of text.matchAll(pattern)) {
				if (m[1] && ENV_NAME.test(m[1])) names.add(m[1]);
			}
		}
	}
	return [...names].sort();
};

const portsFromCommand = (
	command: string | null | undefined,
	evidence: string,
) => {
	const ports: PortCandidate[] = [];
	if (!command) return ports;
	const patterns = [
		/--port[=\s]+(\d{2,5})/,
		/(?:^|\s)-p\s+(\d{2,5})/,
		/--bind[=\s]+[\w.:[\]]*:(\d{2,5})/,
		/-b\s+[\w.:[\]]*:(\d{2,5})/,
	];
	for (const pattern of patterns) {
		const port = command.match(pattern)?.[1];
		if (port)
			ports.push({
				port: Number(port),
				source: "code_default",
				confidence: "high",
				evidence,
			});
	}
	return ports;
};

const LOCALHOST_BIND =
	/(?:listen\([^)]*['"](?:127\.0\.0\.1|localhost)['"]|--host[=\s]+(?:127\.0\.0\.1|localhost)\b|host\s*[:=]\s*['"](?:127\.0\.0\.1|localhost)['"])/;

export const analyzeSnapshot = (
	snapshot: RepositorySnapshot,
	config: PreflightConfig,
): PreflightAnalysis => {
	const checks: PreflightCheck[] = [];
	const language = detectLanguage(snapshot);
	const { framework, defaultPort } = detectFramework(snapshot);
	const packageManager = detectPackageManager(snapshot);
	const pkg = parsePackageJson(snapshot);

	const dockerfileContent = snapshot.contents[config.dockerfilePath];
	const parsedDockerfile = dockerfileContent
		? parseDockerfile(dockerfileContent)
		: null;
	const dockerfile = parsedDockerfile
		? detection(
				{
					path: config.dockerfilePath,
					exposedPorts: parsedDockerfile.exposedPorts,
					healthcheck: parsedDockerfile.healthcheck,
					cmd: parsedDockerfile.cmd,
				},
				"high",
				[config.dockerfilePath],
			)
		: null;

	const composeFile = COMPOSE_FILES.find(
		(f) => snapshot.contents[f] !== undefined,
	);
	const compose = composeFile
		? detection(
				{
					file: composeFile,
					services: parseComposeServices(snapshot.contents[composeFile] ?? ""),
				},
				"high",
				[composeFile],
			)
		: null;

	const procfileWeb =
		snapshot.contents.Procfile?.match(/^web:\s*(.+)$/m)?.[1]?.trim();
	const buildScript = pkg?.scripts?.build;
	const buildCommand = buildScript
		? detection(
				`${packageManager?.value === "npm" || !packageManager ? "npm run" : packageManager.value} build`,
				"high",
				[`package.json › scripts.build : ${buildScript.slice(0, 120)}`],
			)
		: null;

	const startCommand = parsedDockerfile?.cmd
		? detection(parsedDockerfile.cmd, "high", [
				`${config.dockerfilePath} › CMD/ENTRYPOINT`,
			])
		: procfileWeb
			? detection(procfileWeb, "high", ["Procfile › web"])
			: pkg?.scripts?.start
				? detection(pkg.scripts.start, "high", ["package.json › scripts.start"])
				: null;

	const ports: PortCandidate[] = [];
	for (const port of parsedDockerfile?.exposedPorts ?? []) {
		ports.push({
			port,
			source: "dockerfile_expose",
			confidence: "high",
			evidence: `${config.dockerfilePath} › EXPOSE ${port}`,
		});
	}
	ports.push(...portsFromCommand(startCommand?.value, "commande de démarrage"));
	for (const line of snapshot.listenLines) {
		const fallback = line.match(/PORT\s*(?:\|\||\?\?|,)\s*['"]?(\d{2,5})/)?.[1];
		const literal = line.match(/\.listen\(\s*(\d{2,5})\b/)?.[1];
		const port = fallback ?? literal;
		if (port) {
			ports.push({
				port: Number(port),
				source: "code_default",
				confidence: "high",
				evidence: line.slice(0, 160),
			});
		}
	}
	if (defaultPort && framework) {
		ports.push({
			port: defaultPort,
			source: "framework_default",
			confidence: "medium",
			evidence: `port par défaut de ${framework.value}`,
		});
	}
	const uniquePorts = ports.filter(
		(candidate, index) =>
			ports.findIndex((p) => p.port === candidate.port) === index,
	);

	const documented = ENV_EXAMPLE_FILES.flatMap((f) =>
		snapshot.contents[f] ? parseEnvFileKeys(snapshot.contents[f] ?? "") : [],
	);
	const referenced = extractEnvReferences(snapshot.envReferences);
	const providedByImage = new Set(parsedDockerfile?.envKeys ?? []);
	const configured = new Set(config.envKeys);
	const missing = [...new Set([...documented, ...referenced])]
		.filter(
			(name) =>
				!PLATFORM_ENV.has(name) &&
				!configured.has(name) &&
				!providedByImage.has(name),
		)
		.sort();

	if (missing.length > 0) {
		const documentedMissing = missing.filter((n) => documented.includes(n));
		checks.push({
			code: "MISSING_ENVIRONMENT_VARIABLE",
			severity: documentedMissing.length ? "warning" : "info",
			confidence: documentedMissing.length ? "medium" : "low",
			title: `${missing.length} variable(s) d'environnement non définie(s)`,
			detail: `Utilisées par le code ou documentées, absentes de la configuration : ${missing.join(", ")}.`,
			recommendation:
				"Les définir dans l'onglet Environment si elles n'ont pas de valeur par défaut dans le code.",
		});
	}

	const healthRoute = snapshot.listenLines.find((l) =>
		/['"`]\/(?:api\/)?(?:health|healthz|status)['"`]/.test(l),
	);
	const healthcheck = parsedDockerfile?.healthcheck
		? detection("HEALTHCHECK du Dockerfile", "high", [config.dockerfilePath])
		: config.swarmHealthcheck
			? detection("Healthcheck Swarm configuré dans Dokploy", "high", [
					"Advanced › Swarm",
				])
			: null;
	if (!healthcheck) {
		checks.push({
			code: "NO_HEALTHCHECK",
			severity: "info",
			confidence: "high",
			title: "Aucun healthcheck",
			detail: healthRoute
				? `Une route de santé existe dans le code (${healthRoute.trim().slice(0, 100)}) mais aucun healthcheck n'est configuré.`
				: "Sans healthcheck, Dokploy peut vérifier que le conteneur tourne et répond, pas qu'il est sain.",
			recommendation:
				"Ajouter un HEALTHCHECK au Dockerfile ou un healthcheck Swarm (Advanced) qui interroge une route de santé.",
		});
	}

	const localhostLine = snapshot.listenLines.find((l) =>
		LOCALHOST_BIND.test(l),
	);
	if (localhostLine || LOCALHOST_BIND.test(startCommand?.value ?? "")) {
		checks.push({
			code: "APPLICATION_LISTENING_ON_LOCALHOST",
			severity: "warning",
			confidence: "medium",
			title: "Le code semble écouter sur localhost",
			detail: `Ligne trouvée : ${(localhostLine ?? startCommand?.value ?? "").trim().slice(0, 160)}. Une application liée à 127.0.0.1 n'est pas joignable par Traefik.`,
			recommendation:
				"Écouter sur 0.0.0.0 (ou rendre l'hôte configurable via une variable).",
		});
	} else if (
		framework?.value === "Flask" &&
		!/gunicorn|uvicorn|waitress/.test(startCommand?.value ?? "") &&
		snapshot.listenLines.some((l) => /app\.run\((?![^)]*host)/.test(l))
	) {
		checks.push({
			code: "APPLICATION_LISTENING_ON_LOCALHOST",
			severity: "warning",
			confidence: "medium",
			title: "Flask écoute sur 127.0.0.1 par défaut",
			detail:
				"app.run() est appelé sans host : le serveur ne sera pas joignable depuis Traefik.",
			recommendation:
				'Utiliser app.run(host="0.0.0.0") ou un serveur WSGI (gunicorn --bind 0.0.0.0:PORT).',
		});
	}

	if (config.buildType === "dockerfile" && !dockerfile) {
		checks.push({
			code: "BUILD_CONFIGURATION_MISMATCH",
			severity: "error",
			confidence: "high",
			title: "Dockerfile introuvable",
			detail: `Le type de build est « dockerfile » mais ${config.dockerfilePath} n'existe pas dans ${config.buildPath || "/"}.`,
			recommendation:
				"Corriger le chemin du Dockerfile ou choisir un autre type de build (Nixpacks, Railpack).",
		});
	} else if (config.buildType !== "dockerfile" && dockerfile) {
		checks.push({
			code: "BUILD_CONFIGURATION_MISMATCH",
			severity: "info",
			confidence: "medium",
			title: "Un Dockerfile existe mais n'est pas utilisé",
			detail: `Le dépôt contient ${config.dockerfilePath}, le type de build est « ${config.buildType} ».`,
			recommendation: "Vérifier que le type de build est le bon.",
		});
	}

	if (compose && !dockerfile && !language) {
		checks.push({
			code: "COMPOSE_PROJECT",
			severity: "warning",
			confidence: "medium",
			title: "Projet Docker Compose",
			detail: `${compose.value.file} décrit ${compose.value.services.length} service(s) (${compose.value.services.join(", ")}).`,
			recommendation:
				"Créer un service de type Compose plutôt qu'une Application.",
		});
	}

	if (config.domains.length === 0) {
		checks.push({
			code: "NO_DOMAIN",
			severity: "info",
			confidence: "high",
			title: "Aucun domaine",
			detail: "L'application ne sera pas exposée via Traefik.",
			recommendation: "Ajouter un domaine si l'application sert du HTTP.",
		});
	}

	const strongPorts = uniquePorts
		.filter((p) => p.confidence === "high")
		.map((p) => p.port);
	const knownPorts = strongPorts.length
		? strongPorts
		: uniquePorts.map((p) => p.port);
	for (const domain of config.domains) {
		if (
			domain.port === null ||
			knownPorts.length === 0 ||
			knownPorts.includes(domain.port)
		)
			continue;
		checks.push({
			code: "PORT_MISMATCH",
			severity: "warning",
			confidence: strongPorts.length ? "high" : "medium",
			title: `Le domaine ${domain.host} cible le port ${domain.port}`,
			detail: `Ports attendus d'après le dépôt : ${knownPorts.join(", ")}.`,
			recommendation: `Régler le port du domaine sur ${knownPorts[0]} si c'est le port HTTP de l'application.`,
		});
	}

	return {
		language,
		framework,
		packageManager,
		dockerfile,
		compose,
		buildCommand,
		startCommand,
		ports: uniquePorts,
		envVars: {
			referenced: referenced.filter((n) => !PLATFORM_ENV.has(n)),
			documented,
			configured: [...configured].sort(),
			missing,
		},
		healthcheck,
		checks,
	};
};
