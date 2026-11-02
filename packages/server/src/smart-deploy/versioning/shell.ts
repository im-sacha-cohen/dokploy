import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";

/** Runs a command on the Dokploy host or on a remote server, never throwing. */
export const runOn = async (
	serverId: string | null | undefined,
	command: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
	try {
		const { stdout, stderr } = serverId
			? await execAsyncRemote(serverId, command)
			: await execAsync(command);
		return { ok: true, stdout, stderr };
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; message?: string };
		return {
			ok: false,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? e.message ?? String(error),
		};
	}
};

export const SHA_PATTERN = /^[0-9a-f]{40}$/;
