import { findApplicationById } from "@dokploy/server/services/application";
import { collectApplicationContext } from "./collect/application";
import { collectComposeContexts } from "./collect/compose";
import { collectDatabaseContext } from "./collect/database";
import {
	DATABASE_RULES,
	runComposeDiagnostics,
	runDiagnostics,
} from "./engine";
import type { DatabaseType, DiagnosticReport, TargetType } from "./types";

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

/** Read-only diagnosis of any service: application, compose stack or database. */
export const diagnoseService = async (
	type: TargetType,
	id: string,
	options: { probes?: boolean } = {},
): Promise<DiagnosticReport> => {
	if (type === "application") return diagnoseApplication(id, options);
	if (type === "compose") {
		const { stack, services } = await collectComposeContexts(id, options);
		return runComposeDiagnostics(stack, services);
	}
	const ctx = await collectDatabaseContext(type as DatabaseType, id);
	return runDiagnostics(ctx, DATABASE_RULES);
};
