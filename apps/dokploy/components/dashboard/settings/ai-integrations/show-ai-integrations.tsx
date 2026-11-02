import copy from "copy-to-clipboard";
import { CheckCircle2, Copy, Plug, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api, type RouterOutputs } from "@/utils/api";

type Scope = "mcp:read" | "mcp:deploy" | "mcp:config";
const SCOPES: Scope[] = ["mcp:read", "mcp:deploy", "mcp:config"];

const OUTCOME_VARIANT: Record<
	string,
	"green" | "red" | "orange" | "yellow" | "outline"
> = {
	ok: "green",
	denied: "orange",
	error: "red",
	rate_limited: "yellow",
	invalid: "red",
};

const SettingsCard = ({
	settings,
}: {
	settings: RouterOutputs["mcp"]["getSettings"];
}) => {
	const utils = api.useUtils();
	const update = api.mcp.updateSettings.useMutation();
	const test = api.mcp.testConnection.useMutation();
	const [enabled, setEnabled] = useState(settings.enabled);
	const [scopes, setScopes] = useState<Scope[]>(
		settings.allowedScopes as Scope[],
	);
	const mcpUrl = settings.resourceUrls[0];

	useEffect(() => {
		setEnabled(settings.enabled);
		setScopes(settings.allowedScopes as Scope[]);
	}, [settings]);

	const dirty =
		enabled !== settings.enabled ||
		scopes.length !== settings.allowedScopes.length ||
		scopes.some((s) => !settings.allowedScopes.includes(s));

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Plug className="size-5" /> MCP server
				</CardTitle>
				<CardDescription>
					Lets AI clients (Claude, IDE agents…) read and operate this
					organization through the Model Context Protocol. Each user signs in
					with their own Dokploy account and approves the access; clients never
					get more than that user's permissions.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-6">
				{!settings.configured && (
					<AlertBlock type="warning">
						The public MCP URL is not configured. Set{" "}
						<code>DOKPLOY_MCP_RESOURCE_URL</code> (for example{" "}
						<code>https://dokploy.example.com/mcp</code>) and restart Dokploy.
					</AlertBlock>
				)}
				{mcpUrl && (
					<div className="flex flex-col gap-2">
						<Label>MCP URL</Label>
						<div className="flex items-center gap-2">
							<code className="rounded bg-muted px-2 py-1 text-sm">
								{mcpUrl}
							</code>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									copy(mcpUrl);
									toast.success("Copied");
								}}
							>
								<Copy className="size-4" />
							</Button>
						</div>
						<p className="text-sm text-muted-foreground">
							Claude Code:{" "}
							<code>claude mcp add --transport http dokploy {mcpUrl}</code>.
							Other clients: add a remote MCP server with this URL;
							authorization is OAuth 2.1 and is discovered automatically.
						</p>
					</div>
				)}

				<div className="flex items-center gap-3">
					<Switch
						id="mcp-enabled"
						checked={enabled}
						onCheckedChange={setEnabled}
						disabled={!settings.canManage}
					/>
					<Label htmlFor="mcp-enabled">
						Enable AI integrations for this organization
					</Label>
				</div>

				<div className="flex flex-col gap-3">
					<Label>Permissions clients may request</Label>
					{SCOPES.map((scope) => (
						<div key={scope} className="flex items-start gap-3">
							<Checkbox
								id={`allowed-${scope}`}
								checked={scopes.includes(scope)}
								disabled={!settings.canManage}
								onCheckedChange={(checked) =>
									setScopes((prev) =>
										checked
											? [...prev, scope]
											: prev.filter((s) => s !== scope),
									)
								}
							/>
							<div className="flex flex-col">
								<Label htmlFor={`allowed-${scope}`}>
									<code>{scope}</code>
								</Label>
								<span className="text-sm text-muted-foreground">
									{settings.scopeDescriptions[scope]}
								</span>
							</div>
						</div>
					))}
					<p className="text-xs text-muted-foreground">
						Removing a permission takes effect immediately for every connected
						client.
					</p>
				</div>

				<div className="flex flex-wrap gap-2">
					{settings.canManage && (
						<Button
							disabled={!dirty}
							isLoading={update.isPending}
							onClick={async () => {
								await update
									.mutateAsync({ enabled, allowedScopes: scopes })
									.then(async () => {
										toast.success("AI integration settings saved");
										await utils.mcp.getSettings.invalidate();
									})
									.catch((e) => toast.error(e.message));
							}}
						>
							Save
						</Button>
					)}
					<Button
						variant="outline"
						isLoading={test.isPending}
						onClick={() => test.mutate()}
					>
						Test connection
					</Button>
				</div>

				{test.data && (
					<ul className="flex flex-col gap-1 text-sm">
						{test.data.checks.map((c) => (
							<li key={c.name} className="flex items-start gap-2">
								{c.ok ? (
									<CheckCircle2 className="mt-0.5 size-4 text-emerald-500" />
								) : (
									<XCircle className="mt-0.5 size-4 text-red-500" />
								)}
								<span>
									<span className="font-medium">{c.name}</span>{" "}
									<span className="text-muted-foreground">{c.detail}</span>
								</span>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
};

const ClientsCard = ({ isAdmin }: { isAdmin: boolean }) => {
	const utils = api.useUtils();
	const { data: grants } = api.mcp.listGrants.useQuery();
	const revoke = api.mcp.revokeGrant.useMutation();
	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Connected clients</CardTitle>
				<CardDescription>
					{isAdmin
						? "Every AI client authorized by a member of this organization."
						: "AI clients you authorized."}{" "}
					Revoking takes effect on the next request: tokens already issued are
					refused.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{!grants?.length ? (
					<p className="text-sm text-muted-foreground">No client connected.</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Client</TableHead>
								{isAdmin && <TableHead>User</TableHead>}
								<TableHead>Permissions</TableHead>
								<TableHead>Authorized</TableHead>
								<TableHead>Last used</TableHead>
								<TableHead />
							</TableRow>
						</TableHeader>
						<TableBody>
							{grants.map((g) => (
								<TableRow key={g.grantId}>
									<TableCell>
										<div className="flex flex-col">
											<span className="font-medium">{g.clientName}</span>
											<span className="text-xs text-muted-foreground">
												{g.clientId}
											</span>
										</div>
									</TableCell>
									{isAdmin && <TableCell>{g.user?.email ?? "—"}</TableCell>}
									<TableCell>
										<div className="flex flex-wrap gap-1">
											{g.scopes.map((s) => (
												<Badge key={s} variant="outline">
													{s}
												</Badge>
											))}
										</div>
									</TableCell>
									<TableCell className="text-xs">
										{new Date(g.createdAt).toLocaleString()}
									</TableCell>
									<TableCell className="text-xs">
										{g.lastUsedAt
											? new Date(g.lastUsedAt).toLocaleString()
											: "Never"}
									</TableCell>
									<TableCell className="text-right">
										<DialogAction
											title={`Revoke ${g.clientName}?`}
											description="The client loses access immediately. It will have to ask for authorization again."
											onClick={async () => {
												await revoke
													.mutateAsync({
														clientId: g.clientId,
														userId: g.user?.id,
													})
													.then(async () => {
														toast.success("Access revoked");
														await utils.mcp.listGrants.invalidate();
														await utils.mcp.auditLog.invalidate();
													})
													.catch((e) => toast.error(e.message));
											}}
										>
											<Button
												variant="ghost"
												size="sm"
												className="text-destructive"
											>
												Revoke
											</Button>
										</DialogAction>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
};

const AuditCard = () => {
	const { data: entries } = api.mcp.auditLog.useQuery({ limit: 100 });
	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Audit history</CardTitle>
				<CardDescription>
					Every MCP tool call, refused request, consent and revocation
					(arguments are sanitized; secrets are never stored).
				</CardDescription>
			</CardHeader>
			<CardContent>
				{!entries?.length ? (
					<p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Date</TableHead>
								<TableHead>Client</TableHead>
								<TableHead>Action</TableHead>
								<TableHead>Result</TableHead>
								<TableHead>Target</TableHead>
								<TableHead>Detail</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{entries.map((e) => (
								<TableRow key={e.id}>
									<TableCell className="whitespace-nowrap text-xs">
										{new Date(e.createdAt).toLocaleString()}
									</TableCell>
									<TableCell className="text-xs">
										{e.clientName ?? e.clientId ?? "—"}
									</TableCell>
									<TableCell className="text-xs">
										<code>{e.name}</code>
									</TableCell>
									<TableCell>
										<Badge variant={OUTCOME_VARIANT[e.outcome] ?? "outline"}>
											{e.outcome}
										</Badge>
									</TableCell>
									<TableCell className="text-xs">{e.targetId ?? "—"}</TableCell>
									<TableCell className="max-w-xs truncate text-xs text-muted-foreground">
										{e.detail ??
											(e.durationMs !== null ? `${e.durationMs} ms` : "")}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
};

export const ShowAiIntegrations = () => {
	const { data: settings, error } = api.mcp.getSettings.useQuery();
	if (error) return <AlertBlock type="error">{error.message}</AlertBlock>;
	if (!settings) return null;
	return (
		<div className="flex w-full flex-col gap-4">
			<SettingsCard settings={settings} />
			<ClientsCard isAdmin={settings.canManage} />
			<AuditCard />
		</div>
	);
};
