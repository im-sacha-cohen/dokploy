import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { formatYaml } from "@/utils/format-yaml";

const ok = (input: string) => {
	const result = formatYaml(input);
	if (!result.ok) throw new Error(result.error);
	return result;
};

describe("formatYaml", () => {
	it("re-indents with 2 spaces and keeps comments, quotes and order", () => {
		const input = [
			"services:",
			"    # the web front",
			"    web:",
			"        image: 'nginx:alpine'   # pinned",
			"        ports:",
			'        - "80:80"',
			"        environment:",
			"            - KEY=value",
			"    db:",
			"        image: postgres:17",
			"",
		].join("\n");
		expect(ok(input).formatted).toBe(
			[
				"services:",
				"  # the web front",
				"  web:",
				"    image: 'nginx:alpine' # pinned",
				"    ports:",
				'      - "80:80"',
				"    environment:",
				"      - KEY=value",
				"  db:",
				"    image: postgres:17",
				"",
			].join("\n"),
		);
	});

	it("accepts tab indentation", () => {
		const result = ok("services:\n\tweb:\n\t\timage: nginx\n");
		expect(result.formatted).toBe("services:\n  web:\n    image: nginx\n");
	});

	it("keeps flow lists, long strings and multi-line commands", () => {
		const input = [
			"services:",
			"  api:",
			'    command: ["node", "server.js", "--port", "3000", "--host", "0.0.0.0", "--very-long-flag-name"]',
			"    entrypoint: |",
			"      sh -c 'echo start'",
			"",
		].join("\n");
		expect(ok(input).formatted).toBe(input);
	});

	it("is stable: formatting twice changes nothing", () => {
		const first = ok("services:\n    web:\n        image: nginx\n").formatted;
		const second = ok(first);
		expect(second.changed).toBe(false);
		expect(second.formatted).toBe(first);
	});

	it("reports the line of a syntax error", () => {
		const result = formatYaml(
			"services:\n  web:\n    image: nginx\n   ports: [\n",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.line).toBeGreaterThan(1);
	});

	it("warns when a service has no configuration (wrong indentation)", () => {
		const result = ok("services:\n  web:\n  image: nginx\n");
		expect(result.warnings).toEqual([
			'Service "web" has no configuration: its lines are probably not indented under it.',
			'Service "image" should be a mapping (image, ports…).',
		]);
	});

	it("keeps multi-document files", () => {
		expect(ok("a: 1\n---\nb:\n    c: 2\n").formatted).toBe(
			"a: 1\n---\nb:\n  c: 2\n",
		);
	});

	it("leaves an empty file alone", () => {
		expect(ok("  \n")).toMatchObject({ changed: false, warnings: [] });
	});

	it("means exactly the same as the original (anchors, merge keys, block scalars)", () => {
		const input = readFileSync(
			new URL("./fixtures/messy-compose.yml", import.meta.url),
			"utf8",
		);
		const { formatted } = ok(input);
		expect(parse(formatted, { merge: true })).toEqual(
			parse(input, { merge: true }),
		);
		expect(formatted).toContain("x-common: &common");
		expect(formatted).toContain("<<: *common");
		expect(formatted).toContain('"format-test" # kept');
	});

	it("guesses the tab width when tabs and spaces are mixed", () => {
		const input =
			"services:\n    cache:\n\timage: redis\n\tports:\n\t    - 6379\n";
		const result = ok(input);
		expect(result.warnings).toEqual([]);
		expect(parse(result.formatted)).toEqual({
			services: { cache: { image: "redis", ports: [6379] } },
		});
	});

	it("leaves tabs inside block scalars alone", () => {
		const input = "script: |\n  line\n  \tindented with a tab\n";
		expect(parse(ok(input).formatted)).toEqual(parse(input));
	});
});
