import {
	seriesSummary,
	summarizeStats,
} from "@dokploy/server/mcp/monitoring-tools";
import { describe, expect, it } from "vitest";

describe("MCP monitoring helpers", () => {
	it("computes CPU and memory like docker stats", () => {
		const summary = summarizeStats({
			cpu_stats: {
				cpu_usage: { total_usage: 2_000_000 },
				system_cpu_usage: 20_000_000,
				online_cpus: 4,
			},
			precpu_stats: {
				cpu_usage: { total_usage: 1_000_000 },
				system_cpu_usage: 10_000_000,
			},
			memory_stats: {
				usage: 300 * 1024 ** 2,
				limit: 1024 * 1024 ** 2,
				stats: { cache: 44 * 1024 ** 2 },
			},
			networks: {
				eth0: { rx_bytes: 2 * 1024 ** 2, tx_bytes: 1024 ** 2 },
				eth1: { rx_bytes: 1024 ** 2, tx_bytes: 0 },
			},
			blkio_stats: {
				io_service_bytes_recursive: [
					{ op: "read", value: 5 * 1024 ** 2 },
					{ op: "write", value: 1024 ** 2 },
				],
			},
		});
		expect(summary).toEqual({
			cpuPercent: 40,
			memoryUsedMB: 256,
			memoryLimitMB: 1024,
			memoryPercent: 25,
			networkRxMB: 3,
			networkTxMB: 1,
			blockReadMB: 5,
			blockWriteMB: 1,
		});
	});

	it("reports 0% CPU on the first sample instead of a bogus value", () => {
		expect(summarizeStats({}).cpuPercent).toBe(0);
	});

	it("summarizes a metric series, ignoring non-numeric points", () => {
		expect(
			seriesSummary(
				[{ cpu: "10.5" }, { cpu: 30 }, { cpu: "n/a" }, { cpu: 20 }],
				"cpu",
			),
		).toEqual({ min: 10.5, avg: 20.2, max: 30 });
		expect(seriesSummary([{ cpu: "n/a" }], "cpu")).toBeNull();
	});
});
