import { validateRequest } from "@dokploy/server";
import { ShieldCheck } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { OnboardingLayout } from "@/components/layouts/onboarding-layout";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { CardDescription, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { authClient } from "@/lib/auth-client";
import { api } from "@/utils/api";

type Scope = "mcp:read" | "mcp:deploy" | "mcp:config";

const followRedirect = (data: unknown) => {
	const target = data as { url?: string; redirect_uri?: string } | null;
	const url = target?.url ?? target?.redirect_uri;
	if (url) window.location.href = url;
};

/**
 * OAuth consent for MCP clients. The organization and the checked scopes are
 * enforced server-side: they become the grant checked on every MCP request,
 * and only the checked scopes are sent with the OAuth consent.
 */
const OAuthConsent = () => {
	const router = useRouter();
	const clientId =
		typeof router.query.client_id === "string" ? router.query.client_id : "";
	const requestedRaw =
		typeof router.query.scope === "string" ? router.query.scope : "";
	const { data, error, isLoading } = api.mcp.consentInfo.useQuery(
		{ clientId, requestedScopes: requestedRaw },
		{ enabled: !!clientId, retry: false },
	);
	const recordGrant = api.mcp.recordGrant.useMutation();
	const [organizationId, setOrganizationId] = useState("");
	const [selected, setSelected] = useState<Scope[]>([]);
	const [submitting, setSubmitting] = useState(false);

	const organization = useMemo(
		() => data?.organizations.find((o) => o.organizationId === organizationId),
		[data, organizationId],
	);
	const offeredScopes = (data?.requestedScopes ?? []).filter((s) =>
		organization?.allowedScopes.includes(s),
	) as Scope[];

	useEffect(() => {
		if (!data) return;
		const preferred =
			data.organizations.find(
				(o) => o.organizationId === data.activeOrganizationId && o.enabled,
			) ?? data.organizations.find((o) => o.enabled);
		if (preferred) setOrganizationId(preferred.organizationId);
	}, [data]);

	useEffect(() => {
		// Least privilege by default: only read access is pre-checked.
		setSelected(offeredScopes.includes("mcp:read") ? ["mcp:read"] : []);
		// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the organization changes
	}, [organizationId, data]);

	const deny = async () => {
		setSubmitting(true);
		const { data: result, error: denyError } = await authClient.oauth2.consent({
			accept: false,
		});
		if (denyError)
			toast.error(denyError.message ?? "Could not deny the request");
		else followRedirect(result);
		setSubmitting(false);
	};

	const allow = async () => {
		if (!organizationId || selected.length === 0) return;
		setSubmitting(true);
		try {
			await recordGrant.mutateAsync({
				clientId,
				organizationId,
				scopes: selected,
			});
			const wantsRefresh = requestedRaw.split(" ").includes("offline_access");
			const { data: result, error: consentError } =
				await authClient.oauth2.consent({
					accept: true,
					scope: [
						...selected,
						...(wantsRefresh ? ["offline_access"] : []),
					].join(" "),
				});
			if (consentError)
				throw new Error(consentError.message ?? "Consent failed");
			followRedirect(result);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Consent failed");
			setSubmitting(false);
		}
	};

	if (!clientId) {
		return (
			<AlertBlock type="error">
				Missing client_id: open this page from an MCP client.
			</AlertBlock>
		);
	}
	if (isLoading)
		return <p className="text-sm text-muted-foreground">Loading…</p>;
	if (error || !data) {
		return (
			<AlertBlock type="error">{error?.message ?? "Unknown client"}</AlertBlock>
		);
	}

	const enabledOrgs = data.organizations.filter((o) => o.enabled);

	return (
		<div className="flex w-full max-w-lg flex-col gap-6">
			<div className="flex flex-col gap-2">
				<ShieldCheck className="size-8 text-primary" />
				<CardTitle className="text-2xl">Authorize {data.client.name}</CardTitle>
				<CardDescription>
					This AI client will act on Dokploy <strong>as you</strong>, limited by
					your own permissions and by the access you grant below. You can revoke
					it at any time in Settings › AI Integrations.
				</CardDescription>
				<p className="text-xs text-muted-foreground">
					Redirects to: {data.client.redirectHosts.join(", ") || "unknown"}
					{data.client.uri ? ` · ${data.client.uri}` : ""}
				</p>
			</div>

			{enabledOrgs.length === 0 ? (
				<AlertBlock type="warning">
					AI integrations are disabled in all your organizations. An owner or
					admin can enable them in Settings › AI Integrations.
				</AlertBlock>
			) : (
				<>
					<div className="flex flex-col gap-2">
						<Label>Organization</Label>
						<RadioGroup
							value={organizationId}
							onValueChange={setOrganizationId}
						>
							{data.organizations.map((o) => (
								<div key={o.organizationId} className="flex items-center gap-2">
									<RadioGroupItem
										value={o.organizationId}
										id={`org-${o.organizationId}`}
										disabled={!o.enabled}
									/>
									<Label
										htmlFor={`org-${o.organizationId}`}
										className="font-normal"
									>
										{o.name}
										{!o.enabled && (
											<span className="text-muted-foreground">
												{" "}
												(AI integrations disabled)
											</span>
										)}
									</Label>
								</div>
							))}
						</RadioGroup>
					</div>

					<div className="flex flex-col gap-3">
						<Label>Permissions requested</Label>
						{data.requestedScopes.length === 0 && (
							<AlertBlock type="warning">
								The client did not request any Dokploy permission.
							</AlertBlock>
						)}
						{data.requestedScopes.map((scope) => {
							const allowed = organization?.allowedScopes.includes(scope);
							return (
								<div key={scope} className="flex items-start gap-3">
									<Checkbox
										id={`scope-${scope}`}
										checked={selected.includes(scope as Scope)}
										disabled={!allowed}
										onCheckedChange={(checked) =>
											setSelected((prev) =>
												checked
													? [...prev, scope as Scope]
													: prev.filter((s) => s !== scope),
											)
										}
									/>
									<div className="flex flex-col">
										<Label htmlFor={`scope-${scope}`}>
											<code>{scope}</code>
										</Label>
										<span className="text-sm text-muted-foreground">
											{data.scopeDescriptions[scope as Scope]}
											{!allowed && " — not allowed in this organization"}
										</span>
									</div>
								</div>
							);
						})}
						<p className="text-xs text-muted-foreground">
							No arbitrary command, shell or docker exec is ever exposed.
							Secrets and environment variable values are never returned.
						</p>
					</div>
				</>
			)}

			<div className="flex justify-end gap-2">
				<Button variant="outline" onClick={deny} disabled={submitting}>
					Deny
				</Button>
				<Button
					onClick={allow}
					isLoading={submitting}
					disabled={!organizationId || selected.length === 0}
				>
					Allow
				</Button>
			</div>
		</div>
	);
};

export default OAuthConsent;

OAuthConsent.getLayout = (page: ReactElement) => (
	<OnboardingLayout>{page}</OnboardingLayout>
);

export async function getServerSideProps(context: GetServerSidePropsContext) {
	const { user } = await validateRequest(context.req);
	if (!user) {
		return { redirect: { permanent: false, destination: "/" } };
	}
	return { props: {} };
}
