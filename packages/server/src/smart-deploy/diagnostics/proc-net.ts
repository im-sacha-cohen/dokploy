import type { ListeningSocket } from "./types";

const TCP_LISTEN = "0A";
// Docker's embedded DNS resolver listens inside every container namespace.
const DOCKER_DNS_ADDRESS = "127.0.0.11";

const parseIpv4 = (hex: string) => {
	const bytes = hex.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? [];
	return bytes.reverse().join(".");
};

// /proc/net/tcp6 stores the address as four little-endian 32-bit words.
const parseIpv6 = (hex: string) => {
	const words = hex.match(/.{8}/g) ?? [];
	const bytes = words.flatMap((word) => (word.match(/../g) ?? []).reverse());
	const groups: string[] = [];
	for (let i = 0; i < bytes.length; i += 2) {
		groups.push(Number.parseInt(`${bytes[i]}${bytes[i + 1]}`, 16).toString(16));
	}
	const full = groups.join(":");
	if (full === "0:0:0:0:0:0:0:0") return "::";
	if (full === "0:0:0:0:0:0:0:1") return "::1";
	if (full.startsWith("0:0:0:0:0:ffff:")) {
		const v4 = bytes.slice(12).map((b) => Number.parseInt(b, 16));
		return `::ffff:${v4.join(".")}`;
	}
	return full;
};

/** Parses the concatenated content of /proc/net/tcp and /proc/net/tcp6. */
export const parseProcNetTcp = (content: string): ListeningSocket[] => {
	const sockets: ListeningSocket[] = [];
	const seen = new Set<string>();

	for (const raw of content.split("\n")) {
		const fields = raw.trim().split(/\s+/);
		if (fields.length < 4 || !/^\d+:$/.test(fields[0] ?? "")) continue;
		const [, local, , state] = fields;
		if (state !== TCP_LISTEN || !local) continue;

		const [addrHex, portHex] = local.split(":");
		if (!addrHex || !portHex) continue;

		const family = addrHex.length === 32 ? "ipv6" : "ipv4";
		const address = family === "ipv6" ? parseIpv6(addrHex) : parseIpv4(addrHex);
		const port = Number.parseInt(portHex, 16);
		if (address === DOCKER_DNS_ADDRESS) continue;

		const key = `${address}:${port}`;
		if (seen.has(key)) continue;
		seen.add(key);
		sockets.push({ address, port, family });
	}
	return sockets.sort((a, b) => a.port - b.port);
};

export const isLoopback = (address: string) =>
	address.startsWith("127.") ||
	address === "::1" ||
	address.startsWith("::ffff:127.");

export const isWildcard = (address: string) =>
	address === "0.0.0.0" || address === "::";

/** Ports reachable from other containers (any non-loopback bind). */
export const externallyReachablePorts = (sockets: ListeningSocket[]) => [
	...new Set(sockets.filter((s) => !isLoopback(s.address)).map((s) => s.port)),
];
