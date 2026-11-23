// Runs commands on the machine where cloudflared lives: over SSH for a remote
// server, or from the Dokploy container for the Dokploy host itself.
import { TRAEFIK_VERSION } from "../../setup/traefik-setup";
import { execAsync, execAsyncRemote } from "../../utils/process/execAsync";

export const shellQuote = (value: string) =>
	`'${value.replace(/'/g, `'\\''`)}'`;

/** Docker commands, which the Dokploy container can run too. */
export const runOnServer = (
	serverId: string | null | undefined,
	command: string,
) => (serverId ? execAsyncRemote(serverId, command) : execAsync(command));

/**
 * A command run on the machine itself: its files, processes and systemd.
 * The Dokploy container sees none of them, so locally the command runs from
 * a throwaway privileged container of the Traefik image (always present)
 * that enters the host's namespaces, as an SSH session would.
 */
export const runOnHost = (
	serverId: string | null | undefined,
	command: string,
) =>
	serverId
		? execAsyncRemote(serverId, command)
		: execAsync(
				`docker run --rm --privileged --pid=host --entrypoint nsenter traefik:v${TRAEFIK_VERSION} -t 1 -m -u -i -n -p -- sh -c ${shellQuote(command)}`,
			);

const FILE_MARKER = "---DOKPLOY-FILE ";

/** Contents of the files that exist among `paths`. */
export const readHostFiles = async (
	serverId: string | null | undefined,
	paths: string[],
) => {
	if (paths.length === 0) return {};
	// base64 keeps file contents from looking like a marker line.
	const command = paths
		.map(
			(path) =>
				`if [ -f ${shellQuote(path)} ]; then echo ${shellQuote(`${FILE_MARKER}${path}`)}; base64 < ${shellQuote(path)} | tr -d '\\n'; echo; fi`,
		)
		.join("\n");
	const { stdout } = await runOnHost(serverId, command);
	return parseHostFiles(stdout);
};

export const parseHostFiles = (stdout: string) => {
	const files: Record<string, string> = {};
	const lines = stdout.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.startsWith(FILE_MARKER)) {
			files[line.slice(FILE_MARKER.length)] = Buffer.from(
				lines[i + 1] ?? "",
				"base64",
			).toString("utf8");
			i++;
		}
	}
	return files;
};

/**
 * Overwrites the file in place, which keeps its owner, its mode and its
 * inode: a file bind-mounted on its own into a container only sees writes
 * to the same inode.
 */
export const writeHostFile = async (
	serverId: string | null | undefined,
	path: string,
	content: string,
	backup = true,
) => {
	const encoded = Buffer.from(content, "utf8").toString("base64");
	const file = shellQuote(path);
	const command = [
		backup ? `cp -p ${file} ${shellQuote(`${path}.dokploy-backup`)}` : "true",
		`printf '%s' ${shellQuote(encoded)} | base64 -d > ${file}`,
	].join(" && ");
	await runOnHost(serverId, command);
};
