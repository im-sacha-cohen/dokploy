import {
	demuxDockerOutput,
	isSafeHostname,
	parseWgetOutput,
	safePath,
} from "@dokploy/server/smart-deploy/diagnostics/collect/docker-io";
import {
	extractMissingEnvNames,
	parseEnvFileKeys,
	parseExitCode,
} from "@dokploy/server/smart-deploy/diagnostics/log-patterns";
import { parseProcNetTcp } from "@dokploy/server/smart-deploy/diagnostics/proc-net";
import { createRedactor } from "@dokploy/server/smart-deploy/diagnostics/redact";
import { describe, expect, it } from "vitest";

// Captured from demo apps B (0.0.0.0:3000) and G (127.0.0.1:3000) in the devbox.
const PROC_B = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 806213 1 0000000058f3176d 100 0 0 10 0
   1: 0B00007F:8DE3 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 797533 1 00000000816be602 100 0 0 10 0
   2: 0100007F:A1FC 0100007F:0BB8 06 00000000:00000000 03:00001447 00000000     0        0 0 3 000000009b944821
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode`;
const PROC_G = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0B00007F:9525 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 805237 1 000000003b735125 100 0 0 10 0
   1: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 802708 1 00000000b5d1ec65 100 0 0 10 0`;
const PROC_V6 = `  sl  local_address                         remote_address                        st
   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1
   1: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2`;

describe("parseProcNetTcp", () => {
	it("keeps LISTEN sockets, drops Docker DNS and established connections", () => {
		expect(parseProcNetTcp(PROC_B)).toEqual([
			{ address: "0.0.0.0", port: 3000, family: "ipv4" },
		]);
		expect(parseProcNetTcp(PROC_G)).toEqual([
			{ address: "127.0.0.1", port: 3000, family: "ipv4" },
		]);
	});

	it("decodes IPv6 wildcard and loopback", () => {
		expect(parseProcNetTcp(PROC_V6)).toEqual([
			{ address: "::", port: 8080, family: "ipv6" },
			{ address: "::1", port: 8081, family: "ipv6" },
		]);
	});
});

describe("extractMissingEnvNames", () => {
	it.each([
		[
			"Missing required environment variable(s): DATABASE_URL, SESSION_SECRET",
			["DATABASE_URL", "SESSION_SECRET"],
		],
		["Error: Environment variable STRIPE_KEY is not set", ["STRIPE_KEY"]],
		["KeyError: 'DJANGO_SECRET_KEY'", ["DJANGO_SECRET_KEY"]],
		["/entrypoint.sh: line 3: REDIS_URL: unbound variable", ["REDIS_URL"]],
		["JWT_SECRET must be set", ["JWT_SECRET"]],
		["missing env: API_URL and API_TOKEN", ["API_URL", "API_TOKEN"]],
	])("%s", (line, expected) => {
		expect(extractMissingEnvNames([line]).names).toEqual(expected);
	});

	it("does not flag ordinary log lines", () => {
		expect(
			extractMissingEnvNames([
				"NODE_ENV is set to production",
				"Server listening on PORT 3000",
				"ERROR is required to be handled",
			]).names,
		).toEqual([]);
	});
});

describe("redactor", () => {
	const redact = createRedactor({
		DATABASE_URL: "postgres://app:s3cr3t-pass@db:5432/app",
		SHORT: "abc",
	});

	it("replaces configured secret values by their key", () => {
		expect(redact("connecting to postgres://app:s3cr3t-pass@db:5432/app")).toBe(
			"connecting to [REDACTED:DATABASE_URL]",
		);
	});

	it("does not redact short values that would cause noise", () => {
		expect(redact("abc def")).toBe("abc def");
	});

	it("redacts generic credential patterns", () => {
		expect(redact("password=hunter22 user=bob")).toBe(
			"password=[REDACTED] user=bob",
		);
		expect(redact("Authorization: Bearer abcdefghijklmnop")).toContain(
			"[REDACTED]",
		);
		expect(redact("redis://default:pa55word@cache:6379")).toBe(
			"redis://default:[REDACTED]@cache:6379",
		);
		expect(
			redact(
				"token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
			),
		).not.toContain("eyJ");
		expect(redact("key AKIAIOSFODNN7EXAMPLE")).toBe("key [REDACTED:AWS_KEY]");
	});

	it("strips terminal escapes and control characters (log injection)", () => {
		expect(redact("\u001b[31mred\u001b[0m\u0007 text\r")).toBe("red text");
	});

	it("truncates very long lines", () => {
		expect(redact("x".repeat(2000)).length).toBeLessThanOrEqual(501);
	});
});

describe("collector parsers", () => {
	it("demultiplexes Docker log frames", () => {
		const frame = (type: number, text: string) => {
			const body = Buffer.from(text);
			const header = Buffer.alloc(8);
			header[0] = type;
			header.writeUInt32BE(body.length, 4);
			return Buffer.concat([header, body]);
		};
		const buffer = Buffer.concat([frame(1, "out\n"), frame(2, "err\n")]);
		expect(demuxDockerOutput(buffer)).toBe("out\nerr\n");
		expect(demuxDockerOutput(Buffer.from("plain tty"))).toBe("plain tty");
	});

	it("parses busybox wget output", () => {
		expect(
			parseWgetOutput(
				"  HTTP/1.1 502 Bad Gateway\nwget: server returned error",
			),
		).toEqual({
			ok: false,
			httpStatus: 502,
		});
		expect(parseWgetOutput("  HTTP/1.1 200 OK\n")).toEqual({
			ok: true,
			httpStatus: 200,
		});
		expect(
			parseWgetOutput(
				"wget: can't connect to remote host (10.0.1.8): Connection refused",
			),
		).toEqual({
			ok: false,
			error: "connection_refused",
		});
		expect(parseWgetOutput("wget: bad address 'nope'").error).toBe("dns");
	});

	it("validates probe inputs", () => {
		expect(isSafeHostname("app.docker.localhost")).toBe(true);
		expect(isSafeHostname("evil.com\nHost: x")).toBe(false);
		expect(isSafeHostname("a b")).toBe(false);
		expect(safePath("/api/health")).toBe("/api/health");
		expect(safePath("/$(reboot)")).toBe("/");
		expect(safePath(null)).toBe("/");
	});

	it("parses exit codes and env files", () => {
		expect(parseExitCode("task: non-zero exit (78)")).toBe(78);
		expect(parseExitCode(undefined)).toBeUndefined();
		expect(
			parseEnvFileKeys("# c\nexport A=1\nB=\n\nlower_case=x\n bad line"),
		).toEqual(["A", "B", "lower_case"]);
	});
});
