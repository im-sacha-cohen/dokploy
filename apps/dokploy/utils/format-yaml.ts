import { type Document, isMap, isScalar, parseAllDocuments } from "yaml";

export type FormatYamlResult =
	| { ok: true; formatted: string; changed: boolean; warnings: string[] }
	| { ok: false; error: string; line?: number };

const expandLeadingTabs = (text: string, width: number) =>
	text.replace(/^[ \t]+/gm, (indent) =>
		indent.replace(/\t/g, " ".repeat(width)),
	);

const firstError = (documents: Document.Parsed[]) =>
	documents.flatMap((doc) => doc.errors)[0];

const parse = (text: string) => {
	const documents = parseAllDocuments(text);
	return Array.isArray(documents) ? documents : [];
};

/**
 * YAML forbids tabs in indentation, but files pasted from editors often use
 * them. The tab width is unknown, so try the common ones and keep the first
 * that gives a sound compose file. A file that already parses is never
 * touched: tabs inside a block scalar are content, not indentation.
 */
const parseTolerant = (source: string) => {
	const asIs = parse(source);
	if (!firstError(asIs) || !/^ *\t/m.test(source)) return asIs;
	let fallback: Document.Parsed[] | undefined;
	for (const width of [2, 4, 8]) {
		const documents = parse(expandLeadingTabs(source, width));
		if (firstError(documents)) continue;
		if (!documents.some((doc) => composeWarnings(doc.contents).length > 0)) {
			return documents;
		}
		fallback ??= documents;
	}
	return fallback ?? asIs;
};

/**
 * Re-indents a YAML file with 2 spaces, keeping comments, quotes, key order,
 * anchors and flow lists as written. Returns the parse error (with its line)
 * when the file is not valid YAML.
 */
export const formatYaml = (input: string): FormatYamlResult => {
	const source = input.replace(/\r\n/g, "\n");
	if (!source.trim()) {
		return { ok: true, formatted: input, changed: false, warnings: [] };
	}
	const documents = parseTolerant(source);
	if (documents.length === 0) {
		return { ok: false, error: "Not a YAML document" };
	}
	const error = firstError(documents);
	if (error) {
		return {
			ok: false,
			error: error.message.split("\n")[0] ?? "Invalid YAML",
			line: error.linePos?.[0]?.line,
		};
	}
	const formatted = `${documents
		.map((doc, index) => {
			const text = doc
				.toString({
					indent: 2,
					indentSeq: true,
					lineWidth: 0,
					flowCollectionPadding: false,
				})
				.replace(/\n+$/, "");
			// Later documents print their own `---` (possibly with a comment).
			return index > 0 && !text.startsWith("---") ? `---\n${text}` : text;
		})
		.join("\n")}\n`;
	return {
		ok: true,
		formatted,
		changed: formatted !== input,
		warnings: documents.flatMap((doc) => composeWarnings(doc.contents)),
	};
};

/**
 * Valid YAML can still be a broken compose file when a line sits at the wrong
 * depth: `image:` aligned with the service name makes the service empty.
 */
const composeWarnings = (root: unknown): string[] => {
	if (!isMap(root)) return [];
	const services = root.get("services", true);
	if (!isMap(services)) return [];
	const warnings: string[] = [];
	for (const item of services.items) {
		const name = isScalar(item.key) ? String(item.key.value) : "?";
		const value = item.value;
		if (value === null || (isScalar(value) && value.value === null)) {
			warnings.push(
				`Service "${name}" has no configuration: its lines are probably not indented under it.`,
			);
		} else if (!isMap(value)) {
			warnings.push(`Service "${name}" should be a mapping (image, ports…).`);
		}
	}
	return warnings;
};
