import {
	Check,
	CloudCog,
	Loader2,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";
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
import { api } from "@/utils/api";

const Warning = ({ children }: { children: React.ReactNode }) => (
	<p className="flex gap-1.5 text-sm text-amber-700 dark:text-amber-300">
		<TriangleAlert className="mt-0.5 size-4 shrink-0" />
		<span>{children}</span>
	</p>
);

const Ok = ({ children }: { children: React.ReactNode }) => (
	<p className="flex gap-1.5 text-sm text-emerald-700 dark:text-emerald-300">
		<Check className="mt-0.5 size-4 shrink-0" />
		<span>{children}</span>
	</p>
);

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
	return (
		<div className="flex flex-col gap-3">
			{isFetching && !data ? (
				<p className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<Loader2 className="size-4 animate-spin" /> Looking for cloudflared on
					this server…
				</p>
			) : !tunnel ? (
				<p className="text-sm text-muted-foreground">
					No cloudflared runs on this server: domains created with a DNS record
					get an A record to the server's IP.
				</p>
			) : tunnel.status === "unsupported" ? (
				<Warning>
					cloudflared found ({tunnel.connector}), but Dokploy cannot add routes
					to it: {tunnel.reason} Domains get an A record instead.
				</Warning>
			) : (
				<>
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
						<dt className="text-muted-foreground">Connector</dt>
						<dd>{tunnel.connector}</dd>
						<dt className="text-muted-foreground">Tunnel</dt>
						<dd className="break-all font-mono text-xs leading-5">
							{tunnel.tunnelId}
						</dd>
						<dt className="text-muted-foreground">Configuration</dt>
						<dd className="break-all">
							{tunnel.configPath ??
								"Token (managed from the Cloudflare dashboard)"}
						</dd>
						<dt className="text-muted-foreground">Routes point to</dt>
						<dd className="break-all font-mono text-xs leading-5">
							{tunnel.origin}
						</dd>
					</dl>
					{tunnel.configProblem && <Warning>{tunnel.configProblem}</Warning>}
					{data.providers.length === 0 ? (
						<Warning>
							Connect Cloudflare in Settings › DNS so Dokploy can add routes to
							this tunnel.
						</Warning>
					) : (
						data.providers.map((provider) =>
							provider.status.usable ? (
								<Ok key={provider.name}>
									{provider.name}: new domains become routes of tunnel{" "}
									{provider.status.name}
									{provider.status.mode === "file"
										? ", written to config.yml (cloudflared restarts for a few seconds)."
										: ", through the Cloudflare API."}
								</Ok>
							) : (
								<Warning key={provider.name}>
									{provider.name}: {provider.status.reason}
								</Warning>
							),
						)
					)}
				</>
			)}
			<div>
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
