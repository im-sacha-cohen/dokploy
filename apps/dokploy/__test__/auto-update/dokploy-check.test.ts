import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	running: "ghcr.io/me/dokploy:smart-deploy@sha256:old",
	registry: vi.fn(),
	updateData: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(async () => ({ stdout: `${mocks.running}\n`, stderr: "" })),
}));
vi.mock("@dokploy/server/services/image-update", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getRegistryImageInfo: mocks.registry,
}));
vi.mock("@dokploy/server/services/settings", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getUpdateData: mocks.updateData,
}));

import {
	allowedByVersionRule,
	checkDokployUpdate,
} from "@dokploy/server/auto-update/dokploy-check";

describe("allowedByVersionRule", () => {
	it.each([
		["patch", "v0.31.4", "v0.31.5", true],
		["patch", "v0.31.4", "v0.32.0", false],
		["minor", "v0.31.4", "v0.32.0", true],
		["minor", "v0.31.4", "v1.0.0", false],
		["major", "v0.31.4", "v1.0.0", true],
		["digest", "v0.31.4", "v9.0.0", true],
		["patch", "canary", "v0.31.5", false],
	] as const)("%s: %s -> %s is %s", (rule, from, to, expected) => {
		expect(allowedByVersionRule(rule, from, to)).toBe(expected);
	});
});

describe("checkDokployUpdate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.running = "ghcr.io/me/dokploy:smart-deploy@sha256:old";
	});
	afterEach(() => {
		delete process.env.DOKPLOY_IMAGE;
		delete process.env.RELEASE_TAG;
	});

	describe("the fork (a moving tag)", () => {
		beforeEach(() => {
			process.env.DOKPLOY_IMAGE = "ghcr.io/me/dokploy";
			process.env.RELEASE_TAG = "smart-deploy";
		});

		it("offers the new build pinned to its digest, whatever the rule", async () => {
			mocks.registry.mockResolvedValue({
				digest: "sha256:new",
				revision: "bbbbbbb2cafe",
				source: null,
				created: "2026-11-20T08:00:00Z",
			});
			await expect(checkDokployUpdate("v0.31.4", "patch")).resolves.toEqual({
				available: true,
				currentImage: "ghcr.io/me/dokploy:smart-deploy@sha256:old",
				targetImage: "ghcr.io/me/dokploy:smart-deploy@sha256:new",
				label: "smart-deploy (bbbbbbb)",
				createdAt: new Date("2026-11-20T08:00:00Z"),
				allowed: true,
			});
			expect(mocks.registry).toHaveBeenCalledWith(
				"ghcr.io/me/dokploy:smart-deploy",
			);
		});

		it("offers nothing when the service runs that build", async () => {
			mocks.registry.mockResolvedValue({
				digest: "sha256:old",
				revision: null,
				source: null,
				created: null,
			});
			await expect(checkDokployUpdate("v0.31.4", "digest")).resolves.toEqual({
				available: false,
				currentImage: "ghcr.io/me/dokploy:smart-deploy@sha256:old",
			});
		});
	});

	describe("official Dokploy (semver tags)", () => {
		beforeEach(() => {
			mocks.running = "dokploy/dokploy:latest@sha256:old";
		});

		it("refuses a minor release under the patch rule", async () => {
			mocks.updateData.mockResolvedValue({
				latestVersion: "v0.32.0",
				updateAvailable: true,
			});
			mocks.registry.mockResolvedValue({
				digest: "sha256:new",
				revision: null,
				source: null,
				created: "not a date",
			});
			await expect(
				checkDokployUpdate("v0.31.4", "patch"),
			).resolves.toMatchObject({
				available: true,
				targetImage: "dokploy/dokploy:v0.32.0@sha256:new",
				createdAt: null,
				allowed: false,
			});
			expect(mocks.registry).toHaveBeenCalledWith("dokploy/dokploy:v0.32.0");
		});

		it("offers nothing when Docker Hub has nothing newer", async () => {
			mocks.updateData.mockResolvedValue({
				latestVersion: null,
				updateAvailable: false,
			});
			await expect(
				checkDokployUpdate("v0.31.4", "minor"),
			).resolves.toMatchObject({
				available: false,
			});
			expect(mocks.registry).not.toHaveBeenCalled();
		});
	});
});
