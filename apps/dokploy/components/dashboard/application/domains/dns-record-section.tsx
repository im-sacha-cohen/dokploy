import { Check, Globe, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";
import { useDebounce } from "@/utils/hooks/use-debounce";

export interface DnsRecordChoice {
	dnsProviderId: string;
	zoneId: string;
	name: string;
	ip: string;
	proxied: boolean;
	/** "tunnel": a CNAME to the server's Cloudflare Tunnel, plus its route. */
	target: "ip" | "tunnel";
	/** False while the name is taken, invalid or being checked. */
	ready: boolean;
}

/**
 * In the "add domain" form: picks a zone of a connected DNS provider, suggests
 * a free subdomain and reports whether it is available. The record itself is
 * created on submit, together with the domain.
 */
export const DnsRecordSection = ({
	serviceType,
	serviceId,
	onChange,
}: {
	serviceType: "application" | "compose";
	serviceId: string;
	onChange: (choice: DnsRecordChoice | null) => void;
}) => {
	const { data: context, isLoading } = api.domainDns.context.useQuery({
		serviceType,
		serviceId,
	});
	const [enabled, setEnabled] = useState(true);
	const [providerId, setProviderId] = useState("");
	const [zoneId, setZoneId] = useState("");
	const [label, setLabel] = useState("");
	const [edited, setEdited] = useState(false);
	const [ip, setIp] = useState("");
	const [proxied, setProxied] = useState(false);
	const [tunnelWanted, setTunnelWanted] = useState(true);

	const providers = context?.providers ?? [];
	const provider = providers.find((p) => p.dnsProviderId === providerId);
	useEffect(() => {
		if (!providerId && providers[0]) setProviderId(providers[0].dnsProviderId);
	}, [providers, providerId]);
	useEffect(() => {
		if (!ip && context?.serverIps[0]) setIp(context.serverIps[0]);
	}, [context, ip]);

	const { data: zones, isLoading: zonesLoading } =
		api.dnsProvider.listZones.useQuery(
			{ dnsProviderId: providerId },
			{ enabled: !!providerId && enabled },
		);
	useEffect(() => {
		if (zones && !zones.some((z) => z.id === zoneId)) {
			setZoneId(zones[0]?.id ?? "");
		}
	}, [zones, zoneId]);
	const zone = zones?.find((z) => z.id === zoneId);
	const zoneName = zone?.name.replace(/\.$/, "").toLowerCase() ?? "";

	const tunnelDetected =
		context?.tunnel?.status === "found" &&
		provider?.providerType === "cloudflare";
	const requestedTarget =
		tunnelDetected && tunnelWanted ? ("tunnel" as const) : ("ip" as const);

	const debouncedLabel = useDebounce(label, 400);
	const {
		data: check,
		isFetching: checking,
		refetch,
	} = api.domainDns.suggest.useQuery(
		{
			serviceType,
			serviceId,
			dnsProviderId: providerId,
			zoneId,
			name: edited && debouncedLabel ? debouncedLabel : undefined,
			target: requestedTarget,
		},
		{ enabled: enabled && !!providerId && !!zoneId, retry: false },
	);

	// Fill the suggestion until the user types their own name.
	useEffect(() => {
		if (!edited && check?.suggestion && zoneName) {
			const fqdn = check.suggestion.fqdn;
			setLabel(fqdn === zoneName ? "@" : fqdn.slice(0, -(zoneName.length + 1)));
		}
	}, [check, edited, zoneName]);

	// The server checks the tunnel against the zone and falls back to an A
	// record when it cannot be used.
	const tunnelCheck = requestedTarget === "tunnel" ? check?.tunnel : null;
	const target =
		requestedTarget === "tunnel" && tunnelCheck?.usable !== false
			? ("tunnel" as const)
			: ("ip" as const);

	const fqdn = useMemo(() => {
		if (!zoneName) return "";
		const value = label.trim().toLowerCase().replace(/\.+$/, "");
		if (!value || value === "@") return zoneName;
		return value.endsWith(`.${zoneName}`) || value === zoneName
			? value
			: `${value}.${zoneName}`;
	}, [label, zoneName]);

	const status = edited
		? debouncedLabel === label
			? (check?.requested ?? undefined)
			: undefined
		: check?.suggestion
			? { ...check.suggestion.status, valid: true, fqdn: check.suggestion.fqdn }
			: undefined;
	const ready =
		!!status &&
		status.valid &&
		status.status !== "taken" &&
		!checking &&
		(target === "tunnel" ? !!tunnelCheck?.usable : !!ip) &&
		fqdn === status.fqdn;

	useEffect(() => {
		onChange(
			enabled && provider && zoneId && fqdn
				? {
						dnsProviderId: providerId,
						zoneId,
						name: fqdn,
						ip,
						proxied,
						target,
						ready,
					}
				: null,
		);
	}, [
		enabled,
		provider,
		providerId,
		zoneId,
		fqdn,
		ip,
		proxied,
		target,
		ready,
		onChange,
	]);

	if (isLoading) return null;
	if (!context || providers.length === 0) {
		return (
			<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Globe className="size-3.5" />
				Connect a DNS provider in{" "}
				<Link href="/dashboard/settings/dns" className="text-primary">
					Settings › DNS
				</Link>{" "}
				to create the DNS record from here.
			</p>
		);
	}
	if (!context.canCreateRecords) return null;

	return (
		<div className="flex flex-col gap-3 rounded-lg border p-4">
			<div className="flex items-center justify-between gap-4">
				<div className="flex flex-col">
					<Label htmlFor="dns-record-enabled">Create the DNS record</Label>
					<span className="text-xs text-muted-foreground">
						{target === "tunnel"
							? "A route is added to the server's Cloudflare Tunnel, with its CNAME record, together with the domain."
							: "An A record is created at your DNS provider together with the domain."}
					</span>
				</div>
				<Switch
					id="dns-record-enabled"
					checked={enabled}
					onCheckedChange={setEnabled}
				/>
			</div>

			{enabled && (
				<>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						{providers.length > 1 && (
							<div className="flex flex-col gap-1.5">
								<Label>DNS provider</Label>
								<Select value={providerId} onValueChange={setProviderId}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{providers.map((p) => (
											<SelectItem key={p.dnsProviderId} value={p.dnsProviderId}>
												{p.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}
						<div className="flex flex-col gap-1.5">
							<Label>Zone</Label>
							<Select
								value={zoneId}
								onValueChange={(value) => {
									setZoneId(value);
									setEdited(false);
								}}
								disabled={zonesLoading}
							>
								<SelectTrigger>
									<SelectValue
										placeholder={zonesLoading ? "Loading zones…" : "No zone"}
									/>
								</SelectTrigger>
								<SelectContent>
									{zones?.map((z) => (
										<SelectItem key={z.id} value={z.id}>
											{z.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="dns-record-name">Subdomain</Label>
						<div className="flex items-center gap-2">
							<Input
								id="dns-record-name"
								value={label}
								onChange={(event) => {
									setLabel(event.target.value);
									setEdited(true);
								}}
								placeholder="app"
							/>
							<span className="shrink-0 text-sm text-muted-foreground">
								.{zoneName || "…"}
							</span>
							{edited && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => {
										setEdited(false);
										void refetch();
									}}
									aria-label="Use the suggestion"
								>
									<RefreshCw className="size-4" />
								</Button>
							)}
						</div>
						<NameStatusLine
							checking={checking || (edited && debouncedLabel !== label)}
							status={status}
						/>
					</div>

					{tunnelDetected && (
						<div className="flex flex-col gap-1.5">
							<div className="flex items-center gap-2">
								<Switch
									id="dns-record-tunnel"
									checked={tunnelWanted}
									onCheckedChange={setTunnelWanted}
								/>
								<Label htmlFor="dns-record-tunnel">
									Route through the Cloudflare Tunnel
									{tunnelCheck?.usable ? ` ${tunnelCheck.name}` : ""}
								</Label>
							</div>
							{tunnelCheck && !tunnelCheck.usable ? (
								<span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
									<TriangleAlert className="size-3.5 shrink-0" />
									{tunnelCheck.reason} An A record is used instead.
								</span>
							) : (
								tunnelWanted && (
									<span className="text-xs text-muted-foreground">
										Cloudflare handles HTTPS: Traefik serves this domain over
										HTTP, without its own certificate.
										{tunnelCheck?.usable && tunnelCheck.mode === "file"
											? " The route is written to the tunnel's config.yml and cloudflared is restarted: the sites behind this tunnel, Dokploy included if you reach it through the tunnel, are cut off for a few seconds."
											: ""}
									</span>
								)
							)}
						</div>
					)}
					{context.tunnel?.status === "unsupported" && (
						<span className="flex items-center gap-1 text-xs text-muted-foreground">
							<TriangleAlert className="size-3.5 shrink-0" />
							Cloudflare Tunnel found on this server: {context.tunnel.reason}
						</span>
					)}

					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label>Points to</Label>
							{target === "tunnel" && context.tunnel?.status === "found" ? (
								<span className="break-all text-sm">
									CNAME {context.tunnel.tunnelId}.cfargotunnel.com
								</span>
							) : context.serverIps.length > 1 ? (
								<Select value={ip} onValueChange={setIp}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{context.serverIps.map((address) => (
											<SelectItem key={address} value={address}>
												{address}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<span className="text-sm">
									{ip ? `A ${ip}` : "No IPv4 address found for this server"}
								</span>
							)}
						</div>
						{provider?.providerType === "cloudflare" && target === "ip" && (
							<div className="flex items-center gap-2 pt-6">
								<Switch
									id="dns-record-proxied"
									checked={proxied}
									onCheckedChange={setProxied}
								/>
								<Label htmlFor="dns-record-proxied">
									Proxy through Cloudflare
								</Label>
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
};

const NameStatusLine = ({
	checking,
	status,
}: {
	checking: boolean;
	status:
		| {
				fqdn: string;
				valid: boolean;
				status: "free" | "points_here" | "taken";
				records?: { type: string; content: string }[];
		  }
		| undefined;
}) => {
	if (checking || !status) {
		return (
			<span className="flex items-center gap-1 text-xs text-muted-foreground">
				<Loader2 className="size-3.5 animate-spin" /> Checking the zone…
			</span>
		);
	}
	if (!status.valid) {
		return (
			<span className="flex items-center gap-1 text-xs text-red-700 dark:text-red-300">
				<TriangleAlert className="size-3.5" /> Not a valid name in this zone.
			</span>
		);
	}
	if (status.status === "taken") {
		return (
			<span className="flex items-center gap-1 text-xs text-red-700 dark:text-red-300">
				<TriangleAlert className="size-3.5" /> {status.fqdn} already exists (
				{status.records?.map((r) => `${r.type} ${r.content}`).join(", ")}).
				Choose another name.
			</span>
		);
	}
	if (status.status === "points_here") {
		return (
			<span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
				<Check className="size-3.5" /> {status.fqdn} already points to this
				server: it will be reused, not created.
			</span>
		);
	}
	return (
		<span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
			<Check className="size-3.5" /> {status.fqdn} is available.
		</span>
	);
};
