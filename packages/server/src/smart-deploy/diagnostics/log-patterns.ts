const ENV_NAME = "[A-Z][A-Z0-9_]{1,}";
const STRICT_ENV_NAME = /^[A-Z][A-Z0-9_]+$/;

// Prefixes are case-insensitive, but the names that follow must be upper case,
// so they are tokenized separately instead of with a single /i regex.
const ENV_LIST_PREFIXES: RegExp[] = [
	/missing (?:required )?env(?:ironment)?(?: var(?:iable)?s?(?:\(s\))?)?\s*[:=-]?\s*/i,
	/env(?:ironment)? var(?:iable)?s?(?:\(s\))? (?:not set|not defined|missing|undefined)\s*[:=-]?\s*/i,
];
const LEADING_NAME = /^["'`]?([A-Z][A-Z0-9_]+)["'`]?(?:\s*,\s*|\s+and\s+|\s*$)/;

const ENV_SINGLE_PATTERNS: RegExp[] = [
	new RegExp(
		`env(?:ironment)? var(?:iable)? ["'\`]?(${ENV_NAME})["'\`]? (?:is )?(?:not set|not defined|missing|required|undefined|must be set)`,
		"i",
	),
	new RegExp(
		`\\b(${ENV_NAME}) (?:env(?:ironment)? var(?:iable)? )?(?:is (?:not set|not defined|required|missing|undefined)|must be (?:set|defined|provided))\\b`,
	),
	new RegExp(`KeyError: ['"](${ENV_NAME})['"]`),
	new RegExp(`os\\.environ\\[['"](${ENV_NAME})['"]\\]`),
	new RegExp(
		`(?:\\$\\{?)?\\b(${ENV_NAME})\\}?: (?:parameter null or not set|unbound variable)`,
	),
];

const NOT_ENV_WORDS = new Set([
	"ERROR",
	"WARN",
	"WARNING",
	"INFO",
	"DEBUG",
	"FATAL",
	"AND",
	"THE",
	"ENV",
	"PATH",
]);

const isEnvName = (name: string | undefined): name is string =>
	!!name && STRICT_ENV_NAME.test(name) && !NOT_ENV_WORDS.has(name);

const takeLeadingNames = (text: string): string[] => {
	const names: string[] = [];
	let rest = text;
	for (
		let match = rest.match(LEADING_NAME);
		match;
		match = rest.match(LEADING_NAME)
	) {
		if (match[1]) names.push(match[1]);
		rest = rest.slice(match[0].length);
		if (!match[0]) break;
	}
	return names;
};

/** Extracts environment variable names that the application reports as missing. */
export const extractMissingEnvNames = (
	lines: string[],
): { names: string[]; matchedLines: string[] } => {
	const names = new Set<string>();
	const matchedLines: string[] = [];

	for (const line of lines) {
		const found: string[] = [];
		for (const prefix of ENV_LIST_PREFIXES) {
			const match = prefix.exec(line);
			if (match)
				found.push(
					...takeLeadingNames(line.slice(match.index + match[0].length)),
				);
		}
		for (const pattern of ENV_SINGLE_PATTERNS) {
			const name = line.match(pattern)?.[1];
			if (name) found.push(name);
		}
		const valid = found.filter(isEnvName);
		for (const name of valid) names.add(name);
		if (valid.length > 0 && !matchedLines.includes(line))
			matchedLines.push(line);
	}
	return { names: [...names], matchedLines: matchedLines.slice(-5) };
};

/** Parses the env-file format used by `.env.example`; returns keys only. */
export const parseEnvFileKeys = (content: string): string[] => {
	const keys = new Set<string>();
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
		if (match?.[1]) keys.add(match[1]);
	}
	return [...keys];
};

export const parseExitCode = (error?: string): number | undefined => {
	const match = error?.match(/non-zero exit \((\d+)\)/);
	return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
};

export const describeExitCode = (code: number): string => {
	switch (code) {
		case 1:
			return "erreur générique de l'application (exception non gérée, configuration invalide…)";
		case 2:
			return "mauvaise utilisation de la commande (arguments invalides)";
		case 78:
			return "erreur de configuration (EX_CONFIG), souvent une variable d'environnement manquante ou invalide";
		case 126:
			return "commande de démarrage non exécutable (permissions)";
		case 127:
			return "commande de démarrage introuvable dans l'image";
		case 134:
			return "arrêt anormal (SIGABRT)";
		case 137:
			return "processus tué (SIGKILL), souvent un dépassement de mémoire (OOM)";
		case 139:
			return "erreur de segmentation (SIGSEGV)";
		case 143:
			return "arrêt demandé (SIGTERM)";
		default:
			return code > 128
				? `processus terminé par le signal ${code - 128}`
				: `code de sortie ${code}`;
	}
};

const BUILD_ERROR_LINE =
	/\b(?:error|failed|failure|fatal|exception|not found|cannot|denied|exit code|missing)\b|ERR!/i;

export const selectBuildErrorLines = (lines: string[], max = 12): string[] => {
	const relevant = lines.filter((line) => BUILD_ERROR_LINE.test(line));
	return (relevant.length > 0 ? relevant : lines).slice(-max);
};
