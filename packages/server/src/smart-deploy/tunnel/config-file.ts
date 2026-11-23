// Routes of a tunnel configured with a local config.yml: Dokploy edits the
// file on the server, then restarts cloudflared, which only reads it at
// startup.
import { isMap, isSeq, parseDocument } from "yaml";
import {
	readHostFiles,
	runOnHost,
	runOnServer,
	shellQuote,
	writeHostFile,
} from "./host";
import {
	addRoute,
	CATCH_ALL,
	conflictError,
	type IngressRule,
	isCatchAll,
	isRoute,
} from "./ingress";
import { withTunnelLock } from "./lock";

export type ConnectorRestart =
	| { kind: "docker"; container: string }
	| { kind: "systemd"; unit: string };

export interface TunnelConfigFile {
	/** Path of config.yml on the server (not inside a container). */
	path: string;
	restart: ConnectorRestart;
}

const DOKPLOY_COMMENT = " Added by Dokploy";

/** The `tunnel` and `credentials-file` keys, or null if not a config file. */
export const readTunnelConfig = (text: string) => {
	const doc = parseDocument(text);
	if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
	const tunnel = doc.get("tunnel");
	const credentials = doc.get("credentials-file");
	return {
		tunnel: typeof tunnel === "string" ? tunnel : undefined,
		credentialsFile: typeof credentials === "string" ? credentials : undefined,
	};
};

export type ConfigEdit =
	| { status: "changed"; text: string }
	| { status: "unchanged" }
	| { status: "invalid"; reason: string };

/** Adds the route at the top of `ingress`, keeping comments and layout. */
export const addRouteToConfig = (
	text: string,
	hostname: string,
	service: string,
): ConfigEdit => {
	const doc = parseDocument(text);
	if (doc.errors.length > 0 || !isMap(doc.contents)) {
		return { status: "invalid", reason: "config.yml could not be parsed" };
	}
	const ingress = doc.get("ingress", true);
	if (ingress !== undefined && !isSeq(ingress)) {
		return {
			status: "invalid",
			reason: "`ingress` in config.yml is not a list",
		};
	}
	const url = ingress ? undefined : doc.get("url");
	if (url !== undefined && typeof url !== "string") {
		return { status: "invalid", reason: "`url` in config.yml is not a text" };
	}
	// `url` sends every hostname to one service: as the catch-all rule of a
	// new ingress list, it keeps doing so for every name but the new route.
	const fallback: IngressRule = url ? { service: url } : CATCH_ALL;
	const rules = ingress ? (ingress.toJSON() as IngressRule[]) : undefined;
	const result = addRoute(rules, hostname, service);
	if (result.status === "conflict") {
		throw conflictError(hostname, result.services);
	}
	if (result.status === "exists") return { status: "unchanged" };

	const route = doc.createNode(result.route);
	route.commentBefore = DOKPLOY_COMMENT;
	if (ingress) {
		ingress.items.unshift(route);
		if (!rules?.some(isCatchAll)) ingress.items.push(doc.createNode(CATCH_ALL));
	} else {
		if (url) doc.delete("url");
		doc.set("ingress", doc.createNode([result.route, fallback]));
		const created = doc.get("ingress", true);
		if (isSeq(created) && created.items[0]) {
			(created.items[0] as { commentBefore?: string }).commentBefore =
				DOKPLOY_COMMENT;
		}
	}
	return { status: "changed", text: doc.toString() };
};

export const removeRouteFromConfig = (
	text: string,
	hostname: string,
	service: string,
): ConfigEdit => {
	const doc = parseDocument(text);
	if (doc.errors.length > 0 || !isMap(doc.contents)) {
		return { status: "invalid", reason: "config.yml could not be parsed" };
	}
	const ingress = doc.get("ingress", true);
	if (!isSeq(ingress)) return { status: "unchanged" };
	const rules = ingress.toJSON() as IngressRule[];
	const index = rules.findIndex((rule) => isRoute(rule, hostname, service));
	if (index === -1) return { status: "unchanged" };
	ingress.items.splice(index, 1);
	// Once parsed, the comment above the first item belongs to the list, not
	// to the item, so it would stay behind on the next one.
	if (index === 0 && ingress.commentBefore) {
		const lines = ingress.commentBefore
			.split("\n")
			.filter((line) => line !== DOKPLOY_COMMENT);
		ingress.commentBefore = lines.length ? lines.join("\n") : undefined;
	}
	return { status: "changed", text: doc.toString() };
};

const SETTLE_SECONDS = 5;

/**
 * Restarts cloudflared, then checks it is still up a few seconds later: with
 * a bad configuration it exits at once, and its restart policy (Docker) or
 * unit (systemd) starts it over and over.
 */
const restartConnector = async (
	serverId: string | null | undefined,
	restart: ConnectorRestart,
) => {
	if (restart.kind === "docker") {
		const id = shellQuote(restart.container);
		const { stdout } = await runOnServer(
			serverId,
			`before=$(docker inspect -f '{{.RestartCount}}' ${id}) && docker restart ${id} >/dev/null && sleep ${SETTLE_SECONDS} && echo "$(docker inspect -f '{{.State.Running}} {{.State.Restarting}} {{.RestartCount}}' ${id}) $before"`,
		);
		const [running, restarting, count, before] = stdout.trim().split(/\s+/);
		return running === "true" && restarting === "false" && count === before;
	}
	const unit = shellQuote(restart.unit);
	const { stdout } = await runOnHost(
		serverId,
		`systemctl restart ${unit} && sleep ${SETTLE_SECONDS}; systemctl is-active ${unit} || true`,
	);
	return stdout.trim() === "active";
};

const editConfigFile = (
	serverId: string | null | undefined,
	tunnelId: string,
	file: TunnelConfigFile,
	edit: (text: string) => ConfigEdit,
) =>
	withTunnelLock(tunnelId, async () => {
		const original = (await readHostFiles(serverId, [file.path]))[file.path];
		if (original === undefined) {
			throw new Error(`${file.path} no longer exists on the server`);
		}
		const result = edit(original);
		if (result.status === "invalid") throw new Error(result.reason);
		if (result.status === "unchanged") return false;

		await writeHostFile(serverId, file.path, result.text);
		if (await restartConnector(serverId, file.restart)) return true;

		await writeHostFile(serverId, file.path, original, false);
		await restartConnector(serverId, file.restart).catch(() => false);
		throw new Error(
			"cloudflared did not start with the new config.yml; the previous file was restored",
		);
	});

export const addConfigFileRoute = (
	serverId: string | null | undefined,
	tunnelId: string,
	file: TunnelConfigFile,
	hostname: string,
	service: string,
) =>
	editConfigFile(serverId, tunnelId, file, (text) =>
		addRouteToConfig(text, hostname, service),
	);

export const removeConfigFileRoute = (
	serverId: string | null | undefined,
	tunnelId: string,
	file: TunnelConfigFile,
	hostname: string,
	service: string,
) =>
	editConfigFile(serverId, tunnelId, file, (text) =>
		removeRouteFromConfig(text, hostname, service),
	);
