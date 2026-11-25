import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetDockerResourceType = vi.hoisted(() => vi.fn());
const mockSpawnAsync = vi.hoisted(() => vi.fn());
const mockGetUpdateData = vi.hoisted(() => vi.fn());
const mockGetDokployImage = vi.hoisted(() => vi.fn(() => "dokploy/dokploy"));
const updater = vi.hoisted(() => ({
	busy: vi.fn(async () => false),
	hasUpdater: vi.fn(async () => false),
	start: vi.fn(async () => ({})),
}));

const noop = vi.fn();

vi.mock("@dokploy/server", () => ({
	CLEANUP_CRON_JOB: "0 0 * * *",
	checkGPUStatus: noop,
	checkPortInUse: noop,
	checkPostgresHealth: noop,
	checkTraefikHealth: noop,
	cleanupAll: noop,
	cleanupAllBackground: noop,
	cleanupBuilders: noop,
	cleanupContainers: noop,
	cleanupImages: noop,
	cleanupSystem: noop,
	cleanupVolumes: noop,
	DEFAULT_UPDATE_DATA: { latestVersion: null, updateAvailable: false },
	findServerById: noop,
	getDockerDiskUsage: noop,
	getDockerResourceType: mockGetDockerResourceType,
	getDokployImage: mockGetDokployImage,
	getDokployImageTag: () => "canary",
	getLogCleanupStatus: noop,
	getUpdateData: mockGetUpdateData,
	getWebServerSettings: noop,
	IS_CLOUD: false,
	parseRawConfig: noop,
	paths: () => ({
		MAIN_TRAEFIK_PATH: "/tmp",
		LOGS_PATH: "/tmp",
		MONITORING_PATH: "/tmp",
		DYNAMIC_TRAEFIK_PATH: "/tmp",
	}),
	prepareEnvironmentVariables: noop,
	processLogs: noop,
	readConfig: noop,
	readConfigInPath: noop,
	readDirectory: noop,
	readEnvironmentVariables: noop,
	readMainConfig: noop,
	readMonitoringConfig: noop,
	readPorts: noop,
	recreateDirectory: noop,
	reloadDockerResource: noop,
	sendDockerCleanupNotifications: noop,
	setupGPUSupport: noop,
	spawnAsync: mockSpawnAsync,
	startLogCleanup: noop,
	stopLogCleanup: noop,
	updateLetsEncryptEmail: noop,
	updateServerById: noop,
	updateServerTraefik: noop,
	updateWebServerSettings: noop,
	writeConfig: noop,
	writeMainConfig: noop,
	writeTraefikConfigInPath: noop,
	writeTraefikSetup: noop,
}));

vi.mock("@dokploy/server/auto-update/dokploy-check", () => ({
	serviceImage: vi.fn(async () => "dokploy/dokploy:v1.0.0@sha256:old"),
}));

vi.mock("@dokploy/server/auto-update/dokploy-updater", () => ({
	isDokployUpdateBusy: updater.busy,
	imageHasUpdater: updater.hasUpdater,
	startDokployUpdater: updater.start,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/root", () => ({
	appRouter: {},
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

const { settingsRouter } = await import("@/server/api/routers/settings");

const caller = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

describe("settings.updateServer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		updater.busy.mockResolvedValue(false);
		updater.hasUpdater.mockResolvedValue(false);
	});

	it("fails with a clear error when no dokploy docker resource exists", async () => {
		mockGetDockerResourceType.mockResolvedValue("unknown");

		await expect(caller.updateServer()).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("not running as a Docker service"),
		});

		expect(mockSpawnAsync).not.toHaveBeenCalled();
	});

	it("fails for a standalone container where docker service update cannot run", async () => {
		mockGetDockerResourceType.mockResolvedValue("standalone");
		mockGetUpdateData.mockResolvedValue({
			latestVersion: "v9.9.9",
			updateAvailable: true,
		});

		await expect(caller.updateServer()).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("not running as a Docker service"),
		});

		expect(mockSpawnAsync).not.toHaveBeenCalled();
	});

	it("does not report a fake success when the update command cannot run", async () => {
		mockGetDockerResourceType.mockResolvedValue("unknown");
		mockGetUpdateData.mockResolvedValue({
			latestVersion: "v9.9.9",
			updateAvailable: true,
		});

		await expect(caller.updateServer()).rejects.toBeDefined();
		expect(mockGetUpdateData).not.toHaveBeenCalled();
	});

	it("triggers the docker service update when the service exists", async () => {
		mockGetDockerResourceType.mockResolvedValue("service");
		mockGetUpdateData.mockResolvedValue({
			latestVersion: "v9.9.9",
			updateAvailable: true,
		});
		mockSpawnAsync.mockResolvedValue({ stdout: "", stderr: null });

		await expect(caller.updateServer()).resolves.toBe(true);

		expect(mockSpawnAsync).toHaveBeenCalledWith(
			"docker",
			expect.arrayContaining(["service", "update", "dokploy/dokploy:v9.9.9"]),
		);
	});

	it("updates a fork to the latest build of its own image", async () => {
		mockGetDockerResourceType.mockResolvedValue("service");
		mockGetDokployImage.mockReturnValue("ghcr.io/me/dokploy");
		mockGetUpdateData.mockResolvedValue({
			latestVersion: "smart-deploy",
			updateAvailable: true,
		});
		mockSpawnAsync.mockResolvedValue({ stdout: "", stderr: null });

		await expect(caller.updateServer()).resolves.toBe(true);

		const args = mockSpawnAsync.mock.calls[0]?.[1] as string[];
		expect(args).toContain("ghcr.io/me/dokploy:smart-deploy");
		expect(args.join(" ")).not.toContain("dokploy/dokploy");
	});

	it("goes through the updater when the running image has it", async () => {
		mockGetDockerResourceType.mockResolvedValue("service");
		mockGetDokployImage.mockReturnValue("ghcr.io/me/dokploy");
		mockGetUpdateData.mockResolvedValue({
			latestVersion: "smart-deploy",
			updateAvailable: true,
		});
		updater.hasUpdater.mockResolvedValue(true);

		await expect(caller.updateServer()).resolves.toBe(true);

		expect(updater.start).toHaveBeenCalledWith({
			currentImage: "dokploy/dokploy:v1.0.0@sha256:old",
			args: ["--target", "ghcr.io/me/dokploy:smart-deploy"],
			kind: "update",
			toImage: "ghcr.io/me/dokploy:smart-deploy",
		});
		expect(mockSpawnAsync).not.toHaveBeenCalled();
	});

	it("refuses while a Dokploy update runs or waits to be resumed", async () => {
		mockGetDockerResourceType.mockResolvedValue("service");
		mockGetUpdateData.mockResolvedValue({
			latestVersion: "v9.9.9",
			updateAvailable: true,
		});
		updater.busy.mockResolvedValue(true);

		await expect(caller.updateServer()).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(updater.start).not.toHaveBeenCalled();
		expect(mockSpawnAsync).not.toHaveBeenCalled();
	});
});
