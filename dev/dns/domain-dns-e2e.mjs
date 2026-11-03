// End-to-end test of "create the DNS record from the domain form" against a
// REAL DNS zone connected in Settings › DNS. It creates and deletes A records,
// so it only runs on a zone named explicitly, and only touches names starting
// with "dokploy-e2e-" that do not exist yet.
//
// Usage (after connecting the zone in Settings › DNS):
//   DNS_E2E_ZONE=example.com DNS_E2E_CONFIRM=yes \
//   DOKPLOY_DEV_URL=http://127.0.0.1:3000 DOKPLOY_MCP_URL=https://<tunnel>/mcp \
//   node dev/dns/domain-dns-e2e.mjs
// DOKPLOY_MCP_URL is optional: without it the MCP part is skipped.
import { call, login } from "../demo-apps/api-client.mjs";
import {
	authorize,
	check,
	registerClient,
	summarize,
	toolCall,
} from "../mcp/mcp-client.mjs";

const ZONE = (process.env.DNS_E2E_ZONE ?? "").toLowerCase();
if (!ZONE || process.env.DNS_E2E_CONFIRM !== "yes") {
	console.error(
		"Refusing to run: set DNS_E2E_ZONE=<zone> and DNS_E2E_CONFIRM=yes (real DNS records are created and deleted).",
	);
	process.exit(2);
}

const APP_ID = process.env.DNS_E2E_APPLICATION_ID ?? "0JgWA4ty6MSYMiSga4C3Z";
const stamp = Date.now().toString(36);
const LABEL = `dokploy-e2e-${stamp}`;
const result = (res) => res.json?.result ?? {};
const data = (res) => result(res).structuredContent ?? {};
const text = (res) => result(res).content?.[0]?.text ?? res.text;
const qs = (params) => new URLSearchParams(params).toString();

await login();
const providers = await call("/api/dnsProvider.all", undefined, "GET");
let target = null;
for (const provider of providers) {
	const zones = await call(
		`/api/dnsProvider.listZones?${qs({ dnsProviderId: provider.dnsProviderId })}`,
		undefined,
		"GET",
	);
	const zone = zones.find(
		(z) => z.name.replace(/\.$/, "").toLowerCase() === ZONE,
	);
	if (zone) target = { provider, zone };
}
if (!target) {
	console.error(`Zone ${ZONE} is not connected in Settings › DNS.`);
	process.exit(2);
}
const { provider, zone } = target;
const records = () =>
	call(
		`/api/dnsProvider.listRecords?${qs({ dnsProviderId: provider.dnsProviderId, zoneId: zone.id })}`,
		undefined,
		"GET",
	);
const findRecord = async (fqdn) =>
	(await records()).filter(
		(r) => r.name.replace(/\.$/, "").toLowerCase() === fqdn,
	);
const domains = () =>
	call(
		`/api/domain.byApplicationId?${qs({ applicationId: APP_ID })}`,
		undefined,
		"GET",
	);
const cleanup = [];

try {
	const context = await call(
		`/api/domainDns.context?${qs({ serviceType: "application", serviceId: APP_ID })}`,
		undefined,
		"GET",
	);
	const ip = context.serverIps[0];
	check("contexte : fournisseur et IP du serveur", !!ip, `IP ${ip}`);

	const fqdn = `${LABEL}.${ZONE}`;
	const before = await findRecord(fqdn);
	check("le nom de test n'existe pas encore", before.length === 0, fqdn);

	const suggest = await call(
		`/api/domainDns.suggest?${qs({
			serviceType: "application",
			serviceId: APP_ID,
			dnsProviderId: provider.dnsProviderId,
			zoneId: zone.id,
			name: LABEL,
		})}`,
		undefined,
		"GET",
	);
	check(
		"suggest : nom libre et valide",
		suggest.requested?.status === "free" && suggest.requested.valid,
		JSON.stringify(suggest.requested),
	);

	// 1. UI path: record + domain in one call
	const created = await call("/api/domainDns.createDomain", {
		applicationId: APP_ID,
		domainType: "application",
		path: "/",
		port: 3000,
		https: false,
		certificateType: "none",
		dnsProviderId: provider.dnsProviderId,
		zoneId: zone.id,
		name: fqdn,
		ip,
		proxied: false,
	});
	cleanup.push(() =>
		call("/api/domainDns.deleteDomain", {
			domainId: created.domain.domainId,
			deleteRecord: true,
		}),
	);
	const atProvider = await findRecord(fqdn);
	check(
		"createDomain : enregistrement A créé chez le fournisseur",
		created.record.created &&
			atProvider.length === 1 &&
			atProvider[0].type === "A" &&
			atProvider[0].content === ip,
		JSON.stringify(atProvider),
	);
	check(
		"createDomain : domaine Dokploy créé avec ce nom",
		(await domains()).some(
			(d) => d.domainId === created.domain.domainId && d.host === fqdn,
		),
	);
	const tracked = await call(
		`/api/domainDns.trackedDomains?${qs({ serviceType: "application", serviceId: APP_ID })}`,
		undefined,
		"GET",
	);
	check(
		"le domaine est marqué comme ayant un enregistrement créé par Dokploy",
		tracked.includes(created.domain.domainId),
	);

	const again = await call("/api/domainDns.createDomain", {
		applicationId: APP_ID,
		domainType: "application",
		path: "/",
		port: 3000,
		https: false,
		certificateType: "none",
		dnsProviderId: provider.dnsProviderId,
		zoneId: zone.id,
		name: fqdn,
		ip,
		proxied: false,
	});
	cleanup.push(() =>
		call("/api/domainDns.deleteDomain", {
			domainId: again.domain.domainId,
			deleteRecord: false,
		}),
	);
	check(
		"même nom pointant déjà ici → réutilisé, pas de doublon",
		again.record.created === false && (await findRecord(fqdn)).length === 1,
	);
	const reusedInfo = await call(
		`/api/domainDns.recordForDomain?${qs({ domainId: again.domain.domainId })}`,
		undefined,
		"GET",
	);
	check(
		"un enregistrement réutilisé n'est jamais proposé à la suppression",
		reusedInfo === null,
	);
	await call("/api/domainDns.deleteDomain", {
		domainId: again.domain.domainId,
		deleteRecord: false,
	});
	cleanup.pop();
	check(
		"supprimer le domaine réutilisant le nom garde l'enregistrement",
		(await findRecord(fqdn)).length === 1,
	);

	const info = await call(
		`/api/domainDns.recordForDomain?${qs({ domainId: created.domain.domainId })}`,
		undefined,
		"GET",
	);
	check(
		"recordForDomain : suppression proposée",
		info?.canDelete === true && info.name === fqdn,
		JSON.stringify(info),
	);
	const removed = await call("/api/domainDns.deleteDomain", {
		domainId: created.domain.domainId,
		deleteRecord: true,
	});
	cleanup.pop();
	check(
		"deleteDomain : domaine et enregistrement supprimés",
		removed.recordDeleted === true &&
			(await findRecord(fqdn)).length === 0 &&
			!(await domains()).some((d) => d.domainId === created.domain.domainId),
		JSON.stringify(removed),
	);

	// 2. MCP path, through the public MCP URL
	if (process.env.DOKPLOY_MCP_URL) {
		const settings = await call("/api/mcp.getSettings", undefined, "GET");
		const scopes = ["mcp:read", "mcp:config"];
		const client = await registerClient("Dokploy DNS E2E", scopes);
		cleanup.push(() =>
			call("/api/mcp.revokeGrant", { clientId: client.client_id }),
		);
		const token = (
			await authorize(client.client_id, scopes, settings.organizationId)
		).access_token;
		const elicit = { capabilities: { elicitation: {} } };

		const suggestion = data(
			await toolCall(token, "dokploy_suggest_subdomain", {
				serviceType: "application",
				serviceId: APP_ID,
				dnsProviderId: provider.dnsProviderId,
				zoneId: zone.id,
				name: `${LABEL}-mcp`,
			}),
		);
		check(
			"MCP dokploy_suggest_subdomain",
			suggestion.requested?.status === "free",
			JSON.stringify(suggestion.requested),
		);
		const mcpFqdn = `${LABEL}-mcp.${ZONE}`;
		const mcpCreated = await toolCall(token, "dokploy_create_domain", {
			serviceType: "application",
			serviceId: APP_ID,
			port: 3000,
			dns: {
				dnsProviderId: provider.dnsProviderId,
				zoneId: zone.id,
				name: `${LABEL}-mcp`,
			},
		});
		const mcpDomainId = data(mcpCreated).domainId;
		if (mcpDomainId) {
			cleanup.push(() =>
				call("/api/domainDns.deleteDomain", {
					domainId: mcpDomainId,
					deleteRecord: true,
				}),
			);
		}
		check(
			"MCP dokploy_create_domain avec dns : enregistrement et domaine créés",
			data(mcpCreated).host === mcpFqdn &&
				(await findRecord(mcpFqdn)).length === 1,
			text(mcpCreated).slice(0, 200),
		);
		const ask = await toolCall(
			token,
			"dokploy_delete_domain",
			{ domainId: mcpDomainId },
			{},
			elicit,
		);
		check(
			"MCP dokploy_delete_domain : la confirmation mentionne l'enregistrement DNS",
			result(ask).inputRequests?.confirm?.params?.message?.includes(
				`DNS record ${mcpFqdn}`,
			),
			result(ask).inputRequests?.confirm?.params?.message,
		);
		const done = await toolCall(
			token,
			"dokploy_delete_domain",
			{ domainId: mcpDomainId },
			{
				inputResponses: {
					confirm: { action: "accept", content: { confirm: true } },
				},
				requestState: result(ask).requestState,
			},
			elicit,
		);
		cleanup.splice(-1, 1);
		check(
			"MCP dokploy_delete_domain confirmé : domaine et enregistrement supprimés",
			data(done).recordDeleted === true &&
				(await findRecord(mcpFqdn)).length === 0,
			text(done).slice(0, 200),
		);
	} else {
		console.log("(partie MCP ignorée : DOKPLOY_MCP_URL non défini)");
	}
} catch (error) {
	check("exécution du scénario sans exception", false, error.stack);
} finally {
	for (const fn of cleanup.reverse()) await fn().catch(() => {});
	const leftovers = (await records()).filter((r) =>
		r.name.toLowerCase().startsWith(LABEL),
	);
	check(
		"aucun enregistrement de test laissé dans la zone",
		leftovers.length === 0,
		leftovers.map((r) => r.name).join(", "),
	);
}

summarize();
