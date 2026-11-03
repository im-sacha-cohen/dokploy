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
	// Official database images (postgres, mysql, mariadb).
	new RegExp(`You (?:must|need to) specify (${ENV_NAME})\\b`),
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
			return "generic application error (unhandled exception, invalid configuration…)";
		case 2:
			return "command misuse (invalid arguments)";
		case 78:
			return "configuration error (EX_CONFIG), often a missing or invalid environment variable";
		case 126:
			return "start command not executable (permissions)";
		case 127:
			return "start command not found in the image";
		case 134:
			return "abnormal termination (SIGABRT)";
		case 137:
			return "process killed (SIGKILL), often out of memory (OOM)";
		case 139:
			return "segmentation fault (SIGSEGV)";
		case 143:
			return "termination requested (SIGTERM)";
		default:
			return code > 128
				? `process terminated by signal ${code - 128}`
				: `exit code ${code}`;
	}
};

const BUILD_ERROR_LINE =
	/\b(?:error|failed|failure|fatal|exception|not found|cannot|denied|exit code|missing)\b|ERR!/i;

export const selectBuildErrorLines = (lines: string[], max = 12): string[] => {
	const relevant = lines.filter((line) => BUILD_ERROR_LINE.test(line));
	return (relevant.length > 0 ? relevant : lines).slice(-max);
};

const IMAGE_PULL_ERROR =
	/no such image|manifest unknown|manifest for .+ not found|pull access denied|repository does not exist|failed to resolve reference|not found: manifest/i;
export const isImagePullError = (text: string | undefined) =>
	!!text && IMAGE_PULL_ERROR.test(text);

const PORT_IN_USE =
	/port is already allocated|address already in use|bind: address already in use|port .* is already in use/i;
export const isPortInUseError = (text: string | undefined) =>
	!!text && PORT_IN_USE.test(text);

export const DISK_FULL = /no space left on device|disk quota exceeded/i;

/** Log lines saying the data volume was written by another engine version. */
export const DATA_INCOMPATIBLE: Record<string, RegExp> = {
	postgres:
		/database files are incompatible with server|initialized by PG_VERSION|was initialized by PostgreSQL version/i,
	mysql:
		/Cannot boot server version .* on data directory built by version|Cannot upgrade server earlier than|Unknown redo log format|InnoDB: Upgrade after a crash is not supported/i,
	mariadb:
		/InnoDB: Upgrade after a crash is not supported|Unknown redo log format|Invalid MySQL server downgrade|Cannot boot server version/i,
	mongo:
		/UPGRADE PROBLEM|Wrong mongod version|too recent to start up on the existing data files|Invalid featureCompatibilityVersion document|unsupported WiredTiger file version/i,
	redis:
		/Can't handle RDB format version|Bad file format reading the append only file/i,
};
