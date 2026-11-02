const MAX_LINE_LENGTH = 500;
const MIN_SECRET_VALUE_LENGTH = 8;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes is the point
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: log-injection protection
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;

const SECRET_KEY_VALUE =
	/\b([A-Za-z0-9_.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AWS_ACCESS_KEY = /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g;
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type Redactor = (line: string) => string;

/**
 * Builds a redactor that removes known secret values (configured environment
 * values) plus generic credential patterns, and neutralizes terminal escapes
 * and control characters so logs can't spoof UI or MCP output.
 */
export const createRedactor = (knownSecrets: Record<string, string> = {}) => {
	const known = Object.entries(knownSecrets)
		.filter(([, value]) => value && value.length >= MIN_SECRET_VALUE_LENGTH)
		.sort((a, b) => b[1].length - a[1].length)
		.map(([key, value]) => ({
			key,
			pattern: new RegExp(escapeRegExp(value), "g"),
		}));

	return ((line: string) => {
		let out = line.replace(ANSI_PATTERN, "").replace(CONTROL_CHARS, "");
		for (const { key, pattern } of known) {
			out = out.replace(pattern, `[REDACTED:${key}]`);
		}
		out = out
			.replace(URL_CREDENTIALS, "$1:[REDACTED]@")
			.replace(SECRET_KEY_VALUE, "$1$2[REDACTED]")
			.replace(BEARER, "$1 [REDACTED]")
			.replace(JWT, "[REDACTED:JWT]")
			.replace(AWS_ACCESS_KEY, "[REDACTED:AWS_KEY]")
			.replace(PEM_BLOCK, "[REDACTED:PRIVATE_KEY]");
		if (out.length > MAX_LINE_LENGTH) {
			out = `${out.slice(0, MAX_LINE_LENGTH)}…`;
		}
		return out;
	}) satisfies Redactor;
};

export const redactLines = (
	lines: string[],
	redact: Redactor,
	max = 50,
): string[] =>
	lines
		.map((line) => redact(line.trimEnd()))
		.filter((line) => line.length > 0)
		.slice(-max);
