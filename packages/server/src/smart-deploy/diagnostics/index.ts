import { findApplicationById } from "@dokploy/server/services/application";
import { collectApplicationContext } from "./collect/application";
import { runDiagnostics } from "./engine";
import type { DiagnosticReport } from "./types";

export { DEFAULT_RULES, runDiagnostics } from "./engine";
export * from "./types";

/** Read-only: inspects Docker and Traefik, never changes configuration. */
export const diagnoseApplication = async (
	applicationId: string,
	options: { probes?: boolean } = {},
): Promise<DiagnosticReport> => {
	const application = await findApplicationById(applicationId);
	const ctx = await collectApplicationContext(application, options);
	return runDiagnostics(ctx);
};
