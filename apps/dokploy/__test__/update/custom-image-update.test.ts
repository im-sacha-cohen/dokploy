import {
	getRegistryImageInfo,
	parseImageReference,
} from "@dokploy/server/services/image-update";
import {
	getUpdateData,
	reloadDockerResource,
} from "@dokploy/server/services/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

const IMAGE = "ghcr.io/me/dokploy";
const OLD = "sha256:old";
const NEW = "sha256:new";

const json = (body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status: 200, headers });

/** Fake GHCR: anonymous token, a multi-arch index per digest, labelled configs. */
const fakeRegistry = (tagDigest: string) => {
	const revisions: Record<string, string> = {
		[OLD]: "aaaaaaa1",
		[NEW]: "bbbbbbb2",
	};
	const calls: string[] = [];
	const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		if (url.startsWith("https://ghcr.io/token")) return json({ token: "t" });
		const headers = new Headers(init?.headers);
		if (headers.get("authorization") !== "Bearer t") {
			return new Response("", {
				status: 401,
				headers: {
					"www-authenticate":
						'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:me/dokploy:pull"',
				},
			});
		}
		const path = url.replace("https://ghcr.io/v2/me/dokploy/", "");
		const index = (digest: string) =>
			json(
				{
					manifests: [
						{
							digest: `${digest}-amd64`,
							platform: { os: "linux", architecture: "amd64" },
						},
						{
							digest: `${digest}-arm64`,
							platform: { os: "linux", architecture: "arm64" },
						},
					],
				},
				{ "docker-content-digest": digest },
			);
		if (path === "manifests/smart-deploy") return index(tagDigest);
		if (path === `manifests/${OLD}` || path === `manifests/${NEW}`) {
			return index(path.slice("manifests/".length));
		}
		const platform = path.match(/^manifests\/(sha256:\w+)-(amd64|arm64)$/);
		if (platform) return json({ config: { digest: `config-${platform[1]}` } });
		const config = path.match(/^blobs\/config-(sha256:\w+)$/);
		if (config) {
			return json({
				created: "2026-11-20T08:00:00Z",
				config: {
					Labels: {
						"org.opencontainers.image.revision": revisions[config[1] as string],
						"org.opencontainers.image.source": "https://github.com/me/dokploy",
					},
				},
			});
		}
		return new Response("", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return calls;
};

describe("parseImageReference", () => {
	it.each([
		[
			"ghcr.io/me/dokploy:smart-deploy",
			"ghcr.io",
			"me/dokploy",
			"smart-deploy",
		],
		[
			"ghcr.io/me/dokploy:smart-deploy@sha256:abc",
			"ghcr.io",
			"me/dokploy",
			"sha256:abc",
		],
		[
			"dokploy/dokploy:v0.30.11",
			"registry-1.docker.io",
			"dokploy/dokploy",
			"v0.30.11",
		],
		["nginx", "registry-1.docker.io", "library/nginx", "latest"],
		["localhost:5000/team/dokploy", "localhost:5000", "team/dokploy", "latest"],
	])("%s", (image, registry, repository, reference) => {
		expect(parseImageReference(image)).toEqual({
			registry,
			repository,
			reference,
		});
	});
});

describe("custom Dokploy image (fork) updates", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.DOKPLOY_IMAGE = IMAGE;
		process.env.RELEASE_TAG = "smart-deploy";
	});
	afterEach(() => {
		delete process.env.DOKPLOY_IMAGE;
		delete process.env.RELEASE_TAG;
		vi.unstubAllGlobals();
	});

	const runningDigest = (digest: string) =>
		mocks.execAsync.mockResolvedValue({
			stdout: `${IMAGE}:smart-deploy@${digest}\n`,
			stderr: "",
		});

	it("reads the digest and the commit behind a tag, through an anonymous token", async () => {
		fakeRegistry(NEW);
		await expect(
			getRegistryImageInfo(`${IMAGE}:smart-deploy`),
		).resolves.toEqual({
			digest: NEW,
			revision: "bbbbbbb2",
			source: "https://github.com/me/dokploy",
			created: "2026-11-20T08:00:00Z",
		});
	});

	it("offers an update when the tag points to a new build", async () => {
		const calls = fakeRegistry(NEW);
		runningDigest(OLD);
		await expect(getUpdateData("v0.30.11")).resolves.toEqual({
			latestVersion: "smart-deploy",
			updateAvailable: true,
			image: IMAGE,
			currentRevision: "aaaaaaa1",
			latestRevision: "bbbbbbb2",
			sourceUrl: "https://github.com/me/dokploy",
		});
		expect(calls.some((url) => url.includes("hub.docker.com"))).toBe(false);
	});

	it("says up to date when the service already runs that build", async () => {
		fakeRegistry(NEW);
		runningDigest(NEW);
		await expect(getUpdateData("v0.30.11")).resolves.toMatchObject({
			updateAvailable: false,
			latestVersion: "smart-deploy",
		});
	});

	it("offers no update when the registry cannot be read", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 500 })),
		);
		runningDigest(OLD);
		await expect(getUpdateData("v0.30.11")).resolves.toEqual({
			latestVersion: null,
			updateAvailable: false,
		});
	});

	it("Reload restarts the service without changing its image", async () => {
		mocks.execAsync.mockResolvedValue({ stdout: "service\n", stderr: "" });
		await reloadDockerResource("dokploy", undefined, "v0.30.11");
		const commands = mocks.execAsync.mock.calls.map(([command]) => command);
		expect(commands).toContain("docker service update --force dokploy");
		expect(commands.join("\n")).not.toContain("--image");
	});

	it("Reload of the official image still pins the official version", async () => {
		delete process.env.DOKPLOY_IMAGE;
		delete process.env.RELEASE_TAG;
		mocks.execAsync.mockResolvedValue({ stdout: "service\n", stderr: "" });
		await reloadDockerResource("dokploy", undefined, "v0.30.11");
		const commands = mocks.execAsync.mock.calls.map(([command]) => command);
		expect(commands).toContain(
			"docker service update --force --image dokploy/dokploy:v0.30.11 dokploy",
		);
	});
});
