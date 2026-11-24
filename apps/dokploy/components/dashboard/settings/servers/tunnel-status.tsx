import { CloudCog, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { CheckRow, EditTokenLink } from "../dns/cloudflare-token-permissions";

/**
 * The cloudflared connector found on a server (the Dokploy host without
 * `serverId`), and whether domains will be published as tunnel routes.
 */
export const TunnelStatus = ({ serverId }: { serverId?: string }) => {
	const [refresh, setRefresh] = useState(false);
	const { data, isFetching, refetch } = api.domainDns.tunnelStatus.useQuery(
		{ serverId, refresh },
		{ refetchOnWindowFocus: false },
	);

	// Switching to `refresh: true` changes the query, which runs it again.
	const recheck = () => (refresh ? void refetch() : setRefresh(true));

	const tunnel = data?.tunnel;
	const found = tunnel?.status === "found" ? tunnel : null;
	const providers = data?.providers ?? [];
	const tokenBroken = providers.some((provider) => !provider.status.usable);
	const routesOn =
		!!found &&
		!found.configProblem &&
		providers.some((provider) => provider.status.usable);

	return (
		<div className="flex flex-col gap-1.5">
			{isFetching && !data ? (
				<p className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<Loader2 className="size-4 animate-spin" /> Looking for cloudflared on
					this server…
				</p>
			) : !tunnel ? (
				<CheckRow label="No cloudflared on this server: domains get an A record" />
			) : tunnel.status === "unsupported" ? (
				<CheckRow
					label={`cloudflared found (${tunnel.connector}), but Dokploy can't add routes to it`}
					check={{ status: "error", detail: tunnel.reason }}
				/>
			) : (
				<>
					<div className="mb-1 flex flex-wrap items-center justify-between gap-2">
						<p className="text-sm text-muted-foreground">
							{tunnel.connector} · routes go to{" "}
							<span className="font-mono text-xs">{tunnel.origin}</span>
						</p>
						<span
							className={cn(
								"rounded-md px-2.5 py-0.5 text-xs font-medium",
								routesOn
									? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
									: "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200",
							)}
						>
							{routesOn ? "Routes on" : "Routes off"}
						</span>
					</div>
					<CheckRow
						label="cloudflared running on this server"
						check={{
							status: "ok",
							detail: `Tunnel ${tunnel.tunnelId} · ${tunnel.configPath ?? "token from the Cloudflare dashboard"}`,
						}}
					/>
					{tunnel.configProblem && (
						<CheckRow
							label="Tunnel configuration"
							check={{ status: "error", detail: tunnel.configProblem }}
						/>
					)}
					<CheckRow
						label="Cloudflare connected in Settings › DNS"
						check={
							providers.length > 0
								? { status: "ok" }
								: {
										status: "missing",
										detail:
											"Connect Cloudflare so Dokploy can add routes to this tunnel.",
									}
						}
					/>
					{providers.map((provider) => (
						<CheckRow
							key={provider.name}
							label={
								provider.status.usable
									? `Token of ${provider.name} can edit tunnel ${provider.status.name}`
									: `Token of ${provider.name} can edit this tunnel`
							}
							check={
								provider.status.usable
									? {
											status: "ok",
											detail:
												provider.status.mode === "file"
													? "Routes are written to config.yml, then cloudflared restarts for a few seconds."
													: "Routes are added through the Cloudflare API.",
										}
									: { status: "missing", detail: provider.status.reason }
							}
						/>
					))}
				</>
			)}
			<div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={recheck}
					disabled={isFetching}
				>
					<RefreshCw
						className={isFetching ? "size-4 animate-spin" : "size-4"}
					/>
					Check again
				</Button>
				{found && tokenBroken && <EditTokenLink />}
			</div>
		</div>
	);
};

export const TunnelStatusCard = () => (
	<div className="w-full">
		<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader>
					<CardTitle className="text-xl flex flex-row gap-2">
						<CloudCog className="size-6 text-muted-foreground self-center" />
						Cloudflare Tunnel
					</CardTitle>
					<CardDescription>
						When cloudflared runs on this server, new domains are published as
						routes of its tunnel instead of A records.
					</CardDescription>
				</CardHeader>
				<CardContent className="py-6 border-t">
					<TunnelStatus />
				</CardContent>
			</div>
		</Card>
	</div>
);

export const TunnelStatusModal = ({
	serverId,
	children,
}: {
	serverId: string;
	children: React.ReactNode;
}) => {
	const [isOpen, setIsOpen] = useState(false);
	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Cloudflare Tunnel</DialogTitle>
					<DialogDescription>
						When cloudflared runs on this server, new domains are published as
						routes of its tunnel instead of A records.
					</DialogDescription>
				</DialogHeader>
				{isOpen && <TunnelStatus serverId={serverId} />}
			</DialogContent>
		</Dialog>
	);
};
