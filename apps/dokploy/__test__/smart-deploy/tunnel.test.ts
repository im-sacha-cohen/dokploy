import { classifyName } from "@dokploy/server/smart-deploy/dns/names";
import {
	addRouteToConfig,
	readTunnelConfig,
	removeRouteFromConfig,
} from "@dokploy/server/smart-deploy/tunnel/config-file";
import {
	decodeCredentials,
	decodeTunnelToken,
	parseDetection,
	resolveConnector,
	toHostPath,
	tunnelHostname,
} from "@dokploy/server/smart-deploy/tunnel/detect";
import { parseHostFiles } from "@dokploy/server/smart-deploy/tunnel/host";
import {
	addRoute,
	removeRoute,
} from "@dokploy/server/smart-deploy/tunnel/ingress";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TUNNEL = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
const TOKEN = Buffer.from(
	JSON.stringify({ a: ACCOUNT, t: TUNNEL, s: "c2VjcmV0" }),
).toString("base64");

const output = (containers: unknown[], processes: string[] = []) =>
	[
		"---DOKPLOY-TUNNEL-DOCKER---",
		containers.length ? JSON.stringify(containers) : "",
		"---DOKPLOY-TUNNEL-PROCESSES---",
		...processes,
	].join("\n");

const container = (overrides: Record<string, unknown> = {}) => ({
	Name: "/cloudflared",
	Args: ["tunnel", "--no-autoupdate", "run"],
	Config: { Env: [`TUNNEL_TOKEN=${TOKEN}`], Cmd: null },
	HostConfig: { NetworkMode: "bridge" },
	NetworkSettings: { Networks: { bridge: { Gateway: "172.17.0.1" } } },
	...overrides,
});

describe("tunnel token", () => {
	it("keeps the account and tunnel ids, never the secret", () => {
		const ids = decodeTunnelToken(TOKEN);
		expect(ids).toEqual({ accountId: ACCOUNT, tunnelId: TUNNEL });
		expect(JSON.stringify(ids)).not.toContain("c2VjcmV0");
	});

	it("rejects anything else", () => {
		expect(decodeTunnelToken("not-a-token")).toBeNull();
		expect(
			decodeTunnelToken(
				Buffer.from(JSON.stringify({ a: ACCOUNT, t: "nope" })).toString(
					"base64",
				),
			),
		).toBeNull();
	});
});

const detect = async (
	out: string,
	port = 80,
	files: Record<string, string> = {},
) => {
	const connector = parseDetection(out, port);
	return connector
		? resolveConnector(connector, async (paths) =>
				Object.fromEntries(
					paths.filter((p) => p in files).map((p) => [p, files[p] as string]),
				),
			)
		: null;
};

describe("tunnel detection", () => {
	it("reads TUNNEL_TOKEN from a container and reaches Traefik on the bridge gateway", async () => {
		expect(await detect(output([container()]))).toEqual({
			status: "found",
			accountId: ACCOUNT,
			tunnelId: TUNNEL,
			origin: "http://172.17.0.1:80",
			source: "docker",
			connector: "container cloudflared",
		});
	});

	it("uses Traefik's container name on dokploy-network", async () => {
		const detected = await detect(
			output([
				container({
					NetworkSettings: { Networks: { "dokploy-network": {} } },
				}),
			]),
		);
		expect(detected).toMatchObject({ origin: "http://dokploy-traefik:80" });
	});

	it("uses localhost in host network mode and for a system service", async () => {
		expect(
			await detect(
				output([container({ HostConfig: { NetworkMode: "host" } })]),
				8080,
			),
		).toMatchObject({ origin: "http://localhost:8080" });
		expect(
			await detect(
				output(
					[],
					[
						`cloudflared.service|/usr/bin/cloudflared --no-autoupdate tunnel run --token ${TOKEN}`,
					],
				),
			),
		).toMatchObject({
			status: "found",
			source: "process",
			origin: "http://localhost:80",
		});
	});

	it("reads --token=… from the container arguments", async () => {
		const detected = await detect(
			output([
				container({
					Args: ["tunnel", "run", `--token=${TOKEN}`],
					Config: { Env: [] },
				}),
			]),
		);
		expect(detected).toMatchObject({ status: "found", tunnelId: TUNNEL });
	});

	it("prefers containers over their own process line", async () => {
		const detected = await detect(
			output([container()], ["|cloudflared tunnel --no-autoupdate run"]),
		);
		expect(detected).toMatchObject({ status: "found", source: "docker" });
	});

	it("reports token files as unsupported", async () => {
		expect(
			await detect(
				output(
					[],
					["cloudflared.service|cloudflared tunnel run --token-file /run/t"],
				),
			),
		).toMatchObject({ status: "unsupported" });
	});

	it("finds nothing when no connector runs", async () => {
		expect(await detect(output([]))).toBeNull();
		expect(await detect("bash: docker: command not found")).toBeNull();
	});
});

describe("tunnel detection with config.yml", () => {
	const credentials = JSON.stringify({
		AccountTag: ACCOUNT,
		TunnelSecret: "c2VjcmV0",
		TunnelID: TUNNEL,
	});

	it("reads a systemd service's config file and credentials", async () => {
		const detected = await detect(
			output(
				[],
				[
					"cloudflared.service|/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run",
				],
			),
			80,
			{
				"/etc/cloudflared/config.yml":
					"tunnel: home\ncredentials-file: /root/.cloudflared/home.json\n",
				"/root/.cloudflared/home.json": credentials,
			},
		);
		expect(detected).toEqual({
			status: "found",
			tunnelId: TUNNEL,
			accountId: ACCOUNT,
			origin: "http://localhost:80",
			source: "process",
			connector: "systemd unit cloudflared.service",
			configFile: {
				path: "/etc/cloudflared/config.yml",
				restart: { kind: "systemd", unit: "cloudflared.service" },
			},
		});
		expect(JSON.stringify(detected)).not.toContain("c2VjcmV0");
	});

	it("finds a container's config on its volume, by default path", async () => {
		const detected = await detect(
			output([
				container({
					Id: "abc123",
					Config: { Env: [], Cmd: ["tunnel", "run"] },
					Mounts: [{ Source: "/opt/tunnel", Destination: "/etc/cloudflared" }],
				}),
			]),
			80,
			{ "/opt/tunnel/config.yml": `tunnel: ${TUNNEL}\ningress: []\n` },
		);
		expect(detected).toMatchObject({
			status: "found",
			tunnelId: TUNNEL,
			accountId: undefined,
			configFile: {
				path: "/opt/tunnel/config.yml",
				restart: { kind: "docker", container: "abc123" },
			},
		});
	});

	it("keeps API routes possible for a tunnel started by hand", async () => {
		const detected = await detect(
			output([], ["|cloudflared tunnel run home"]),
			80,
			{ "/etc/cloudflared/config.yml": `tunnel: ${TUNNEL}\n` },
		);
		expect(detected).toMatchObject({
			status: "found",
			tunnelId: TUNNEL,
			connector: "cloudflared process",
			configProblem: expect.stringMatching(/systemd/),
		});
		expect(detected).not.toHaveProperty("configFile");
	});

	it("reads a token file, on the host or on a container volume", async () => {
		expect(
			await detect(
				output(
					[],
					[
						"cloudflared.service|cloudflared tunnel run --token-file /etc/cloudflared/token",
					],
				),
				80,
				{ "/etc/cloudflared/token": `${TOKEN}\n` },
			),
		).toMatchObject({ status: "found", tunnelId: TUNNEL, accountId: ACCOUNT });
		expect(
			await detect(
				output([
					container({
						Config: { Env: ["TUNNEL_TOKEN_FILE=/run/token"] },
						Mounts: [{ Source: "/srv/token", Destination: "/run/token" }],
					}),
				]),
				80,
				{ "/srv/token": TOKEN },
			),
		).toMatchObject({ status: "found", tunnelId: TUNNEL });
		expect(
			await detect(
				output([
					container({
						Args: ["tunnel", "run", "--token-file", "/run/secrets/cf"],
						Config: { Env: [] },
						Mounts: [],
					}),
				]),
			),
		).toMatchObject({
			status: "unsupported",
			connector: "container cloudflared",
			reason: expect.stringMatching(/Docker secret/),
		});
	});

	it("explains what it cannot handle", async () => {
		expect(
			await detect(
				output([container({ Id: "abc", Config: { Env: [] }, Mounts: [] })]),
			),
		).toMatchObject({
			status: "unsupported",
			reason: expect.stringMatching(/volume/),
		});
		expect(
			await detect(
				output([], ["cloudflared.service|cloudflared tunnel run home"]),
				80,
				{ "/etc/cloudflared/config.yml": "tunnel: home\n" },
			),
		).toMatchObject({
			status: "unsupported",
			reason: expect.stringMatching(/tunnel id/),
		});
	});

	it("maps container paths to the host through mounts", () => {
		const mounts = [
			{ Source: "/srv/cf", Destination: "/etc/cloudflared" },
			{ Source: "/srv/cf.yml", Destination: "/etc/cloudflared/config.yml" },
		];
		expect(toHostPath("/etc/cloudflared/config.yml", mounts)).toBe(
			"/srv/cf.yml",
		);
		expect(toHostPath("/etc/cloudflared/cert.json", mounts)).toBe(
			"/srv/cf/cert.json",
		);
		expect(toHostPath("/etc/cloudflared-other/x", mounts)).toBeNull();
		expect(decodeCredentials("{")).toBeNull();
	});

	it("reads files listed by the host script", () => {
		const encoded = Buffer.from("tunnel: x\n---DOKPLOY-FILE fake").toString(
			"base64",
		);
		expect(
			parseHostFiles(
				`---DOKPLOY-FILE /etc/cloudflared/config.yml\n${encoded}\n`,
			),
		).toEqual({
			"/etc/cloudflared/config.yml": "tunnel: x\n---DOKPLOY-FILE fake",
		});
	});
});

describe("config.yml routes", () => {
	const service = "http://localhost:80";
	const config = [
		`tunnel: ${TUNNEL}`,
		"credentials-file: /root/.cloudflared/t.json",
		"",
		"# My services",
		"ingress:",
		"  - hostname: grafana.example.com # kept as is",
		"    service: http://localhost:3000",
		"  - service: http_status:404",
		"",
	].join("\n");

	it("adds the route on top and keeps comments", () => {
		const result = addRouteToConfig(config, "app.example.com", service);
		expect(result.status).toBe("changed");
		const text = result.status === "changed" ? result.text : "";
		expect(text).toContain("# My services");
		expect(text).toContain("# kept as is");
		expect(text).toContain("# Added by Dokploy");
		expect(text.indexOf("app.example.com")).toBeLessThan(
			text.indexOf("grafana.example.com"),
		);
		expect(addRouteToConfig(text, "app.example.com", service)).toEqual({
			status: "unchanged",
		});
		const removed = removeRouteFromConfig(text, "app.example.com", service);
		expect(removed.status === "changed" && removed.text).toBe(config);
	});

	it("creates the ingress list when there is none", () => {
		const result = addRouteToConfig(
			`tunnel: ${TUNNEL}\n`,
			"app.example.com",
			service,
		);
		expect(result.status === "changed" && result.text).toContain(
			"http_status:404",
		);
	});

	it("turns a single `url` into the catch-all rule", () => {
		const result = addRouteToConfig(
			`tunnel: ${TUNNEL}\nurl: http://localhost:8000\n`,
			"a.example.com",
			service,
		);
		expect(result.status).toBe("changed");
		const text = result.status === "changed" ? result.text : "";
		expect(text).not.toMatch(/^url:/m);
		expect(parse(text).ingress).toEqual([
			{ hostname: "a.example.com", service },
			{ service: "http://localhost:8000" },
		]);
	});

	it("never takes over a hostname routed elsewhere", () => {
		expect(() =>
			addRouteToConfig(config, "grafana.example.com", service),
		).toThrow(/already routed/);
	});

	it("reads the tunnel keys", () => {
		expect(readTunnelConfig(config)).toEqual({
			tunnel: TUNNEL,
			credentialsFile: "/root/.cloudflared/t.json",
		});
		expect(readTunnelConfig("- just\n- a list")).toBeNull();
	});
});

describe("tunnel routes", () => {
	const service = "http://dokploy-traefik:80";
	const catchAll = { service: "http_status:404" };

	it("puts the route first and keeps the existing rules", () => {
		const ingress = [
			{ hostname: "*.example.com", service: "http://other:80" },
			catchAll,
		];
		expect(addRoute(ingress, "App.example.com.", service)).toMatchObject({
			status: "added",
			ingress: [{ hostname: "app.example.com", service }, ...ingress],
		});
	});

	it("adds the catch-all rule to an empty configuration", () => {
		expect(addRoute(undefined, "app.example.com", service)).toMatchObject({
			status: "added",
			ingress: [{ hostname: "app.example.com", service }, catchAll],
		});
	});

	it("never takes over a hostname routed elsewhere", () => {
		expect(
			addRoute(
				[{ hostname: "app.example.com", service: "http://localhost:3000" }],
				"app.example.com",
				service,
			),
		).toEqual({ status: "conflict", services: ["http://localhost:3000"] });
		expect(
			addRoute(
				[{ hostname: "app.example.com", path: "/api", service }],
				"app.example.com",
				service,
			).status,
		).toBe("conflict");
		expect(
			addRoute(
				[{ hostname: "app.example.com", service }, catchAll],
				"app.example.com",
				service,
			),
		).toEqual({ status: "exists" });
	});

	it("removes only the route Dokploy added", () => {
		const ingress = [
			{ hostname: "app.example.com", service },
			{ hostname: "other.example.com", service },
			catchAll,
		];
		expect(removeRoute(ingress, "app.example.com", service)).toEqual([
			{ hostname: "other.example.com", service },
			catchAll,
		]);
		expect(
			removeRoute(ingress, "app.example.com", "http://localhost:3000"),
		).toBeNull();
	});
});

describe("names on a tunnel", () => {
	const here = { type: "CNAME" as const, contents: [tunnelHostname(TUNNEL)] };

	it("reuses a CNAME already pointing to the tunnel", () => {
		expect(
			classifyName(
				[
					{
						id: "r1",
						name: "app.example.com",
						type: "CNAME",
						content: `${TUNNEL}.cfargotunnel.com.`,
					},
				],
				"app.example.com",
				here,
			),
		).toEqual({ status: "points_here", recordId: "r1" });
	});

	it("treats an A record to the server as taken in tunnel mode", () => {
		expect(
			classifyName(
				[
					{
						id: "r1",
						name: "app.example.com",
						type: "A",
						content: "203.0.113.10",
					},
				],
				"app.example.com",
				here,
			).status,
		).toBe("taken");
	});
});
