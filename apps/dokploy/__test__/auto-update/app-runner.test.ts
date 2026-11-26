import { hasVerdict } from "@dokploy/server/auto-update/app-runner";
import { swarmRollback } from "@dokploy/server/smart-deploy/versioning/verify";
import { describe, expect, it } from "vitest";

describe("Smart Deploy verdict of an app update", () => {
	it("waits while the check has not concluded", () => {
		expect(hasVerdict(null)).toBe(false);
		expect(hasVerdict("pending")).toBe(false);
		expect(hasVerdict("verifying")).toBe(false);
	});

	it("takes the verdict once there is one", () => {
		for (const status of [
			"healthy",
			"running",
			"degraded",
			"failed",
			"unknown",
		]) {
			expect(hasVerdict(status)).toBe(true);
		}
	});
});

describe("Swarm rolling a service back", () => {
	const since = Date.parse("2026-11-26T08:00:00Z");

	it("is a failure of the deployment when it happened during it", () => {
		expect(
			swarmRollback(
				{
					State: "rollback_completed",
					StartedAt: "2026-11-26T08:01:00Z",
					Message:
						"update rolled back due to failure or early termination of task x",
				},
				since,
			),
		).toBe(
			"Swarm put the previous image back: update rolled back due to failure or early termination of task x",
		);
	});

	it("ignores an older rollback and a normal update", () => {
		expect(
			swarmRollback(
				{ State: "rollback_completed", StartedAt: "2026-11-25T08:00:00Z" },
				since,
			),
		).toBeNull();
		expect(
			swarmRollback(
				{ State: "completed", StartedAt: "2026-11-26T08:01:00Z" },
				since,
			),
		).toBeNull();
		expect(swarmRollback(undefined, since)).toBeNull();
	});
});
