import {
	Check,
	CloudCog,
	Globe,
	Loader2,
	RefreshCw,
	Server,
	TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { useDebounce } from "@/utils/hooks/use-debounce";

export interface DnsRecordChoice {
	dnsProviderId: string;
	zoneId: string;
	zoneName: string;
	name: string;
	ip: string;
	proxied: boolean;
	/** "tunnel": a CNAME to the server's Cloudflare Tunnel, plus its route. */
	target: "ip" | "tunnel";
	tunnelName: string | null;
	/** False while the name is taken, invalid or being checked. */
	ready: boolean;
}

/** How the domain reaches the server; "manual" leaves DNS to the user. */
export type ExposureMode = "tunnel" | "ip" | "manual";

const ExposureOption = ({
	value,
	disabled,
	icon,
	title,
	note,
	detail,
	children,
}: {
	value: ExposureMode;
	disabled?: boolean;
	icon: ReactNode;
	title: string;
	note?: string;
	detail: string;
	children?: ReactNode;
}) => (
	<div className={cn("flex gap-3 px-3 py-2.5", disabled && "opacity-60")}>
		<RadioGroupItem
			value={value}
			id={`exposure-${value}`}
			disabled={disabled}
			className="mt-0.5"
		/>
		<div className="flex min-w-0 flex-1 flex-col gap-0.5">
			<Label
				htmlFor={`exposure-${value}`}
				className="flex cursor-pointer flex-wrap items-center gap-x-1.5 font-normal"
			>
				<span className="flex items-center gap-1.5 font-medium">
					{icon}
					{title}
				</span>
				{note && (
					<span className="text-xs text-muted-foreground">· {note}</span>
				)}
			</Label>
			<span className="text-xs text-muted-foreground">{detail}</span>
			{children}
		</div>
	</div>
);

/**
 * In the "add domain" form: the domain's address and how it is exposed. With
 * a connected DNS provider, Dokploy suggests a free subdomain and creates the
 * record on submit, as a Cloudflare Tunnel route when cloudflared runs on the
 * server or as an A record to its IP. `manualAddress` is the plain host field,
 * shown when the user manages DNS themselves.
 */
export const DnsRecordSection = ({
	serviceType,
	serviceId,
	onChange,
	manualAddress,
}: {
	serviceType: "application" | "compose";
	serviceId: string;
	onChange: (choice: DnsRecordChoice | null) => void;
	manualAddress: ReactNode;
}) => {
	const { data: context, isLoading } = api.domainDns.context.useQuery({
		serviceType,
		serviceId,
	});
	const [mode, setMode] = useState<ExposureMode | null>(null);
	const [modeChosen, setModeChosen] = useState(false);
	const [providerId, setProviderId] = useState("");
	const [zoneId, setZoneId] = useState("");
	const [label, setLabel] = useState("");
	const [edited, setEdited] = useState(false);
	const [ip, setIp] = useState("");
	const [proxied, setProxied] = useState(false);

	const providers = context?.providers ?? [];
	const cloudflareProviders = providers.filter(
		(p) => p.providerType === "cloudflare",
	);
	const canUseDns = providers.length > 0 && !!context?.canCreateRecords;
	const tunnelDetected =
		context?.tunnel?.status === "found" && cloudflareProviders.length > 0;

	useEffect(() => {
		if (mode || !context) return;
		setMode(tunnelDetected ? "tunnel" : canUseDns ? "ip" : "manual");
	}, [context, mode, tunnelDetected, canUseDns]);

	// A tunnel route needs a Cloudflare zone.
	const providerChoices = mode === "tunnel" ? cloudflareProviders : providers;
	useEffect(() => {
		if (!providerChoices.some((p) => p.dnsProviderId === providerId)) {
			setProviderId(providerChoices[0]?.dnsProviderId ?? "");
		}
	}, [providerChoices, providerId]);
	const provider = providers.find((p) => p.dnsProviderId === providerId);

	useEffect(() => {
		if (!ip && context?.serverIps[0]) setIp(context.serverIps[0]);
	}, [context, ip]);

	const usesDns = mode === "tunnel" || mode === "ip";
	const { data: zones, isLoading: zonesLoading } =
		api.dnsProvider.listZones.useQuery(
			{ dnsProviderId: providerId },
			{ enabled: !!providerId && usesDns },
		);
	useEffect(() => {
		if (zones && !zones.some((z) => z.id === zoneId)) {
			setZoneId(zones[0]?.id ?? "");
		}
	}, [zones, zoneId]);
	const zone = zones?.find((z) => z.id === zoneId);
	const zoneName = zone?.name.replace(/\.$/, "").toLowerCase() ?? "";

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
			target: mode === "tunnel" ? "tunnel" : "ip",
		},
		{ enabled: usesDns && !!providerId && !!zoneId, retry: false },
	);
	const tunnelCheck = check?.tunnel ?? null;

	// The tunnel may not serve this zone (another account, missing token
	// permission): fall back to an A record unless the user picked a mode.
	useEffect(() => {
		if (mode === "tunnel" && !modeChosen && tunnelCheck?.usable === false) {
			setMode(canUseDns ? "ip" : "manual");
		}
	}, [mode, modeChosen, tunnelCheck, canUseDns]);

	// Fill the suggestion until the user types their own name.
	useEffect(() => {
		if (!edited && check?.suggestion && zoneName) {
			const fqdn = check.suggestion.fqdn;
			setLabel(fqdn === zoneName ? "@" : fqdn.slice(0, -(zoneName.length + 1)));
		}
	}, [check, edited, zoneName]);

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
		(mode === "tunnel" ? !!tunnelCheck?.usable : !!ip) &&
		fqdn === status.fqdn;

	useEffect(() => {
		onChange(
			usesDns && provider && zoneId && fqdn
				? {
						dnsProviderId: providerId,
						zoneId,
						zoneName,
						name: fqdn,
						ip,
						proxied: mode === "tunnel" ? true : proxied,
						target: mode === "tunnel" ? "tunnel" : "ip",
						tunnelName: tunnelCheck?.usable ? tunnelCheck.name : null,
						ready,
					}
				: null,
		);
	}, [
		usesDns,
		mode,
		provider,
		providerId,
		zoneId,
		zoneName,
		fqdn,
		ip,
		proxied,
		tunnelCheck,
		ready,
		onChange,
	]);

	const choose = (next: ExposureMode) => {
		setMode(next);
		setModeChosen(true);
		setEdited(false);
	};

	if (isLoading || !mode) {
		return (
			<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Loader2 className="size-3.5 animate-spin" /> Checking DNS providers…
			</p>
		);
	}

	if (!canUseDns) {
		return (
			<div className="flex flex-col gap-2">
				{manualAddress}
				{providers.length === 0 && (
					<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Globe className="size-3.5" />
						Connect a DNS provider in{" "}
						<Link href="/dashboard/settings/dns" className="text-primary">
							Settings › DNS
						</Link>{" "}
						to create the DNS record from here.
					</p>
				)}
			</div>
		);
	}

	const tunnelDetail = tunnelCheck?.usable
		? `Route in tunnel ${tunnelCheck.name}, no port opened on the server`
		: tunnelCheck
			? "Not available for this zone"
			: "Checking the tunnel…";

	return (
		<div className="flex flex-col gap-4">
			{usesDns ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="dns-record-name">Address</Label>
					<div className="flex items-center gap-2">
						{providerChoices.length > 1 && (
							<Select value={providerId} onValueChange={setProviderId}>
								<SelectTrigger
									className="w-36 shrink-0"
									aria-label="DNS provider"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{providerChoices.map((p) => (
										<SelectItem key={p.dnsProviderId} value={p.dnsProviderId}>
											{p.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
						<Input
							id="dns-record-name"
							className="min-w-0 flex-1"
							value={label}
							onChange={(event) => {
								setLabel(event.target.value);
								setEdited(true);
							}}
							placeholder="app"
						/>
						<Select
							value={zoneId}
							onValueChange={(value) => {
								setZoneId(value);
								setEdited(false);
							}}
							disabled={zonesLoading}
						>
							<SelectTrigger
								className="w-auto max-w-[45%] shrink-0"
								aria-label="Zone"
							>
								<SelectValue
									placeholder={zonesLoading ? "Loading zones…" : "No zone"}
								>
									{zoneName ? `.${zoneName}` : undefined}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{zones?.map((z) => (
									<SelectItem key={z.id} value={z.id}>
										.{z.name.replace(/\.$/, "")}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
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
			) : (
				manualAddress
			)}

			<div className="flex flex-col gap-1.5">
				<Label>Expose through</Label>
				<RadioGroup
					value={mode}
					onValueChange={(value) => choose(value as ExposureMode)}
					className="gap-0 divide-y rounded-lg border"
				>
					{tunnelDetected && (
						<ExposureOption
							value="tunnel"
							disabled={tunnelCheck?.usable === false}
							icon={<CloudCog className="size-4" />}
							title="Cloudflare Tunnel"
							note="recommended"
							detail={tunnelDetail}
						/>
					)}
					<ExposureOption
						value="ip"
						disabled={context.serverIps.length === 0}
						icon={<Server className="size-4" />}
						title="Server IP"
						detail={
							ip ? `A record to ${ip}` : "No IPv4 address found for this server"
						}
					>
						{mode === "ip" &&
							(context.serverIps.length > 1 ||
								provider?.providerType === "cloudflare") && (
								<div className="mt-2 flex flex-wrap items-center gap-4">
									{context.serverIps.length > 1 && (
										<Select value={ip} onValueChange={setIp}>
											<SelectTrigger
												className="h-8 w-44"
												aria-label="Server IP"
											>
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
									)}
									{provider?.providerType === "cloudflare" && (
										<div className="flex items-center gap-2">
											<Switch
												id="dns-record-proxied"
												checked={proxied}
												onCheckedChange={setProxied}
											/>
											<Label
												htmlFor="dns-record-proxied"
												className="font-normal"
											>
												Proxy through Cloudflare
											</Label>
										</div>
									)}
								</div>
							)}
					</ExposureOption>
					<ExposureOption
						value="manual"
						icon={<Globe className="size-4" />}
						title="Existing DNS"
						detail="Dokploy creates no record: you point the name to the server"
					/>
				</RadioGroup>
				{tunnelDetected && tunnelCheck && !tunnelCheck.usable && (
					<span className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300">
						<TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
						Cloudflare Tunnel: {tunnelCheck.reason}
					</span>
				)}
				{context.tunnel?.status === "unsupported" && (
					<span className="flex items-start gap-1 text-xs text-muted-foreground">
						<TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
						Cloudflare Tunnel found on this server: {context.tunnel.reason}
					</span>
				)}
				{mode === "tunnel" &&
					tunnelCheck?.usable &&
					tunnelCheck.mode === "file" && (
						<span className="text-xs text-muted-foreground">
							The route is written to the tunnel's config.yml and cloudflared
							restarts: the sites behind this tunnel, Dokploy included if you
							reach it through the tunnel, are cut off for a few seconds.
						</span>
					)}
			</div>
		</div>
	);
};

/** One line for the dialog footer: what Dokploy creates on submit. */
export const describeDnsChoice = (
	choice: DnsRecordChoice | null,
	host: string,
) => {
	if (!choice) {
		return host
			? `Point ${host} to this server at your DNS provider`
			: "Point the domain to this server at your DNS provider";
	}
	if (choice.target === "tunnel") {
		return `Creates a route in tunnel ${choice.tunnelName ?? ""} and a proxied CNAME in ${choice.zoneName}`;
	}
	return `Creates an A record to ${choice.ip} in ${choice.zoneName}${choice.proxied ? ", proxied by Cloudflare" : ""}`;
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
				<Check className="size-3.5" /> {status.fqdn} already points here: it
				will be reused, not created.
			</span>
		);
	}
	return (
		<span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
			<Check className="size-3.5" /> {status.fqdn} is available.
		</span>
	);
};
