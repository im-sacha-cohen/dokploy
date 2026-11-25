import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	lastDigest: "nginx@sha256:old" as string | null,
}));

vi.mock("@dokploy/server/db", () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: () =>
			Promise.resolve(
				mocks.lastDigest ? [{ imageDigest: mocks.lastDigest }] : [],
			),
	};
	return { db: chain };
});

import {
	checkApplicationUpdate,
	pickVersionTag,
	splitImageName,
} from "@dokploy/server/auto-update/app-check";
import { listRegistryTags } from "@dokploy/server/services/image-update";

describe("splitImageName", () => {
	it.each([
		["nginx", { name: "nginx", tag: "latest", digest: null }],
		["nginx:1.25", { name: "nginx", tag: "1.25", digest: null }],
		[
			"registry.example.com:5000/team/api:2.1.0",
			{
				name: "registry.example.com:5000/team/api",
				tag: "2.1.0",
				digest: null,
			},
		],
		[
			"localhost:5000/api",
			{ name: "localhost:5000/api", tag: "latest", digest: null },
		],
		[
			"nginx:latest@sha256:abc",
			{ name: "nginx", tag: "latest", digest: "sha256:abc" },
		],
		["nginx@sha256:abc", { name: "nginx", tag: null, digest: "sha256:abc" }],
	])("%s", (image, expected) => {
		expect(splitImageName(image)).toEqual(expected);
	});
});

describe("pickVersionTag", () => {
	const tags = [
		"1.25.3",
		"1.25.4",
		"1.25.10",
		"1.26.0",
		"2.0.0",
		"1.25.5-alpine",
		"1.26",
		"latest",
		"1.25.11-rc1",
		"v1.25.12",
	];
	it("keeps to patches, comparing numbers rather than text", () => {
		expect(pickVersionTag("1.25.3", tags, "patch")).toBe("1.25.10");
	});
	it("allows minors, then majors", () => {
		expect(pickVersionTag("1.25.3", tags, "minor")).toBe("1.26.0");
		expect(pickVersionTag("1.25.3", tags, "major")).toBe("2.0.0");
	});
	it("only moves between tags written the same way", () => {
		expect(pickVersionTag("1.25.3-alpine", tags, "major")).toBe(
			"1.25.5-alpine",
		);
		expect(pickVersionTag("1.25", tags, "major")).toBe("1.26");
		expect(pickVersionTag("v1.25.3", tags, "patch")).toBe("v1.25.12");
	});
	it("finds nothing newer, or nothing for a non-version tag", () => {
		expect(pickVersionTag("2.0.0", tags, "major")).toBeNull();
		expect(pickVersionTag("latest", tags, "major")).toBeNull();
	});
});

type Route = (url: URL, init?: RequestInit) => Response | undefined;
const json = (body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", ...headers },
	});
const stubRegistry = (route: Route) => {
	const calls: { url: string; auth: string | null }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const headers = new Headers(init?.headers);
			calls.push({ url: url.toString(), auth: headers.get("authorization") });
			return route(url, init) ?? new Response("", { status: 404 });
		}),
	);
	return calls;
};

describe("listRegistryTags", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("follows pagination links", async () => {
		stubRegistry((url) => {
			if (url.pathname !== "/v2/team/api/tags/list") return undefined;
			if (url.searchParams.get("last") === "1.1.0") {
				return json({ tags: ["1.2.0"] });
			}
			return json(
				{ tags: ["1.0.0", "1.1.0"] },
				{ link: '</v2/team/api/tags/list?last=1.1.0&n=1000>; rel="next"' },
			);
		});
		await expect(
			listRegistryTags("registry.example.com/team/api:1.0.0"),
		).resolves.toEqual(["1.0.0", "1.1.0", "1.2.0"]);
	});

	it("sends the application's credentials to a registry asking for Basic auth", async () => {
		const calls = stubRegistry((url, init) => {
			const auth = new Headers(init?.headers).get("authorization");
			if (!auth) {
				return new Response("", {
					status: 401,
					headers: { "www-authenticate": 'Basic realm="registry"' },
				});
			}
			return url.pathname.endsWith("/tags/list")
				? json({ tags: ["1.0.0"] })
				: undefined;
		});
		await listRegistryTags("registry.example.com/team/api:1.0.0", {
			username: "bot",
			password: "secret",
		});
		expect(calls[1]?.auth).toBe(
			`Basic ${Buffer.from("bot:secret").toString("base64")}`,
		);
	});
});

describe("checkApplicationUpdate", () => {
	beforeEach(() => {
		mocks.lastDigest = "nginx@sha256:old";
	});
	afterEach(() => vi.unstubAllGlobals());

	const app = (dockerImage: string | null) => ({
		applicationId: "app-1",
		dockerImage,
		username: null,
		password: null,
	});
	const manifest = (digest: string) =>
		new Response(JSON.stringify({}), {
			status: 200,
			headers: { "docker-content-digest": digest },
		});
	const dockerHub: (digests: Record<string, string>, tags?: string[]) => Route =
		(digests, tags = []) =>
		(url) => {
			if (url.hostname === "auth.docker.io") return json({ token: "t" });
			const match = url.pathname.match(
				/^\/v2\/library\/nginx\/manifests\/(.+)$/,
			);
			if (match && digests[match[1] as string]) {
				return manifest(digests[match[1] as string] as string);
			}
			if (url.pathname === "/v2/library/nginx/tags/list") {
				return json({ tags });
			}
			return undefined;
		};

	it("follows a moving tag: same image set back, new digest recorded", async () => {
		stubRegistry(dockerHub({ latest: "sha256:new" }));
		await expect(
			checkApplicationUpdate(app("nginx:latest"), "digest"),
		).resolves.toMatchObject({
			available: true,
			currentPinned: "nginx:latest@sha256:old",
			targetImage: "nginx:latest",
			targetPinned: "nginx:latest@sha256:new",
			label: "latest",
		});
	});

	it("says up to date when the tag still points to the deployed image", async () => {
		stubRegistry(dockerHub({ latest: "sha256:old" }));
		await expect(
			checkApplicationUpdate(app("nginx:latest"), "digest"),
		).resolves.toEqual({ available: false });
	});

	it("moves a version tag within the rule", async () => {
		stubRegistry(
			dockerHub({ "1.25.4": "sha256:v1254" }, ["1.25.3", "1.25.4", "1.26.0"]),
		);
		await expect(
			checkApplicationUpdate(app("nginx:1.25.3"), "patch"),
		).resolves.toMatchObject({
			available: true,
			targetImage: "nginx:1.25.4",
			targetPinned: "nginx:1.25.4@sha256:v1254",
		});
	});

	it("starts from the digest of an image pinned after a put-back", async () => {
		mocks.lastDigest = null;
		stubRegistry(dockerHub({ latest: "sha256:bad" }));
		await expect(
			checkApplicationUpdate(app("nginx:latest@sha256:old"), "digest"),
		).resolves.toMatchObject({
			available: true,
			currentPinned: "nginx:latest@sha256:old",
			targetImage: "nginx:latest",
		});
	});

	it("explains what it cannot check", async () => {
		await expect(checkApplicationUpdate(app(null), "digest")).resolves.toEqual({
			available: false,
			reason: "The application has no image.",
		});
		await expect(
			checkApplicationUpdate(app("nginx@sha256:abc"), "digest"),
		).resolves.toMatchObject({
			available: false,
			reason: expect.stringContaining("pinned"),
		});
		mocks.lastDigest = null;
		await expect(
			checkApplicationUpdate(app("nginx:latest"), "digest"),
		).resolves.toMatchObject({
			available: false,
			reason: expect.stringContaining("no successful deployment"),
		});
	});
});
