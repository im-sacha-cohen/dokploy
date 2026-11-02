import { findApplicationById } from "@dokploy/server/services/application";
import {
	findDomainById,
	updateDomainById,
} from "@dokploy/server/services/domain";
import { manageDomain } from "@dokploy/server/utils/traefik/domain";
import { TRPCError } from "@trpc/server";
import { diagnoseApplication } from "../diagnostics";
import type { Finding, FixAction } from "../diagnostics/types";

export const sameFixAction = (a: FixAction, b: FixAction) =>
	JSON.stringify(a, Object.keys(a).sort()) ===
	JSON.stringify(b, Object.keys(b).sort());

/**
 * A fix may only be applied if a fresh diagnosis still proposes it as
 * auto-fixable. Clients (UI, MCP) can never submit arbitrary changes.
 */
export const findProposedFix = (findings: Finding[], action: FixAction) =>
	findings.find(
		(f) =>
			f.autoFixable &&
			f.recommendedFix.action !== undefined &&
			sameFixAction(f.recommendedFix.action, action),
	);

export const validateFix = async (applicationId: string, action: FixAction) => {
	const report = await diagnoseApplication(applicationId);
	const finding = findProposedFix(report.findings, action);
	if (!finding) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"This fix is not proposed by the current diagnosis (the situation may have changed). Run the diagnosis again.",
		});
	}
	return finding;
};

/** Changes only the domain's target port, then regenerates its Traefik route. */
export const applyDomainPortFix = async (
	applicationId: string,
	action: Extract<FixAction, { kind: "update_domain_port" }>,
) => {
	const domain = await findDomainById(action.domainId);
	if (domain.applicationId !== applicationId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The domain does not belong to this application",
		});
	}
	const previousPort = domain.port;
	await updateDomainById(domain.domainId, { port: action.port });
	const application = await findApplicationById(applicationId);
	await manageDomain(application, await findDomainById(domain.domainId));
	return {
		domainId: domain.domainId,
		host: domain.host,
		previousPort,
		port: action.port,
	};
};
