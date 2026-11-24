import type {
	CloudflareTokenReport,
	PermissionCheck,
} from "@dokploy/server/utils/dns/cloudflare-permissions";
import { CircleCheck, CircleDashed, CircleX, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

const PERMISSIONS = [
	{ key: "zoneRead", name: "Zone › Zone › Read" },
	{ key: "dnsEdit", name: "Zone › DNS › Edit" },
	{ key: "tunnelEdit", name: "Account › Cloudflare Tunnel › Edit" },
] as const;

const STATUS_LABEL: Record<PermissionCheck["status"], string> = {
	ok: "",
	missing: "missing",
	error: "failed",
	skipped: "not tested",
};

export const CheckRow = ({
	label,
	check,
}: {
	label: string;
	check?: PermissionCheck;
}) => {
	const ok = check?.status === "ok";
	const bad = check?.status === "missing" || check?.status === "error";
	const Icon = ok ? CircleCheck : bad ? CircleX : CircleDashed;
	const detail = check && "detail" in check ? check.detail : undefined;
	return (
		<div
			className={cn(
				"flex gap-2.5 rounded-md px-3 py-2 text-sm",
				ok &&
					"bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
				bad && "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200",
				!ok && !bad && "bg-muted text-muted-foreground",
			)}
		>
			<Icon className="mt-0.5 size-4 shrink-0" />
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex justify-between gap-2">
					<span className="font-medium">{label}</span>
					{check && !ok && (
						<span className="text-xs">{STATUS_LABEL[check.status]}</span>
					)}
				</div>
				{detail && <span className="text-xs opacity-90">{detail}</span>}
			</div>
		</div>
	);
};

export const EditTokenLink = () => (
	<a
		href={TOKENS_URL}
		target="_blank"
		rel="noreferrer"
		className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
	>
		Edit the token in Cloudflare
		<ExternalLink className="size-3" />
	</a>
);

/**
 * The permissions the Cloudflare API token needs: grey until "Test
 * connection" runs, then green or red with what Cloudflare answered.
 */
export const CloudflareTokenPermissions = ({
	report,
}: {
	report?: CloudflareTokenReport | null;
}) => {
	const dnsBroken =
		report &&
		(report.zoneRead.status !== "ok" || report.dnsEdit.status !== "ok");
	const tunnelBroken = report && report.tunnelEdit.status !== "ok";
	return (
		<div className="flex flex-col gap-1.5">
			<p className="text-sm font-medium">Permissions of this token</p>
			{report && report.token.status !== "ok" && (
				<CheckRow label="Token" check={report.token} />
			)}
			{PERMISSIONS.map((permission) => (
				<CheckRow
					key={permission.key}
					label={permission.name}
					check={report?.[permission.key]}
				/>
			))}
			<p className="text-sm text-muted-foreground">
				{!report
					? "Test the connection to check each permission. "
					: report.token.status !== "ok"
						? "Fix the token first. "
						: dnsBroken
							? "Without the red ones, Dokploy can't create DNS records. "
							: tunnelBroken
								? "Without the red one, domains get an A record instead of a tunnel route. "
								: "All set. "}
				<EditTokenLink />
			</p>
		</div>
	);
};
