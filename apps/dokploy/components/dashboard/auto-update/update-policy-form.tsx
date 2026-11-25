import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { cn } from "@/lib/utils";

export type UpdateMode = "notify" | "auto";
export type VersionRule = "digest" | "patch" | "minor" | "major";

export interface UpdatePolicySettings {
	enabled: boolean;
	mode: UpdateMode;
	versionRule: VersionRule;
	minAgeHours: number;
	window: {
		days: number[];
		startTime: string;
		durationMinutes: number;
		timezone: string;
	};
	verifyMinutes: number;
	backupIds: string[];
}

/** The saved rule, as the API returns it. */
export interface StoredUpdatePolicy {
	enabled: boolean;
	mode: UpdateMode;
	versionRule: VersionRule;
	minAgeHours: number;
	windowDays: number[];
	windowStart: string;
	windowDurationMinutes: number;
	timezone: string;
	verifyMinutes: number;
	backupIds: string[];
	nextWindow: { start: Date | string; end: Date | string } | null;
}

const DAYS = [
	{ value: 1, label: "Mon" },
	{ value: 2, label: "Tue" },
	{ value: 3, label: "Wed" },
	{ value: 4, label: "Thu" },
	{ value: 5, label: "Fri" },
	{ value: 6, label: "Sat" },
	{ value: 0, label: "Sun" },
];

const browserTimezone = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
};

const timezones = () => {
	const intl = Intl as unknown as {
		supportedValuesOf?: (key: string) => string[];
	};
	return intl.supportedValuesOf?.("timeZone") ?? ["UTC"];
};

export const toSettings = (
	policy: StoredUpdatePolicy | null | undefined,
): UpdatePolicySettings =>
	policy
		? {
				enabled: policy.enabled,
				mode: policy.mode,
				versionRule: policy.versionRule,
				minAgeHours: policy.minAgeHours,
				window: {
					days: policy.windowDays,
					startTime: policy.windowStart,
					durationMinutes: policy.windowDurationMinutes,
					timezone: policy.timezone,
				},
				verifyMinutes: policy.verifyMinutes,
				backupIds: policy.backupIds,
			}
		: {
				enabled: false,
				mode: "notify",
				versionRule: "digest",
				minAgeHours: 72,
				window: {
					days: [0],
					startTime: "03:00",
					durationMinutes: 120,
					timezone: browserTimezone(),
				},
				verifyMinutes: 5,
				backupIds: [],
			};

export const formatWhen = (date: Date | string) =>
	new Date(date).toLocaleString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});

const Field = ({
	label,
	hint,
	children,
	className,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
	className?: string;
}) => (
	<div className={cn("flex flex-col gap-1.5", className)}>
		<Label>{label}</Label>
		{children}
		{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
	</div>
);

const RULES: { value: VersionRule; label: string; hint: string }[] = [
	{
		value: "digest",
		label: "Same tag, new build",
		hint: "Follows the tag in use (latest, a fork's tag): updates when it points to a new image.",
	},
	{
		value: "patch",
		label: "Patch versions",
		hint: "1.25.3 → 1.25.4, never 1.26.",
	},
	{
		value: "minor",
		label: "Minor versions",
		hint: "1.25.3 → 1.26.0, never 2.0.",
	},
	{
		value: "major",
		label: "All versions",
		hint: "Up to the highest release, majors included.",
	},
];

export const UpdatePolicyForm = ({
	policy,
	saving,
	onSave,
	rules = RULES.map((r) => r.value),
	backupOptions,
	marginMinutes,
	conflictNote,
}: {
	policy: StoredUpdatePolicy | null | undefined;
	saving: boolean;
	onSave: (settings: UpdatePolicySettings) => void;
	rules?: VersionRule[];
	backupOptions?: { backupId: string; label: string }[];
	marginMinutes: number;
	conflictNote?: React.ReactNode;
}) => {
	const [settings, setSettings] = useState(() => toSettings(policy));
	useEffect(() => setSettings(toSettings(policy)), [policy]);
	const zones = useMemo(timezones, []);
	const set = <K extends keyof UpdatePolicySettings>(
		key: K,
		value: UpdatePolicySettings[K],
	) => setSettings((s) => ({ ...s, [key]: value }));
	const setWindow = <K extends keyof UpdatePolicySettings["window"]>(
		key: K,
		value: UpdatePolicySettings["window"][K],
	) => setSettings((s) => ({ ...s, window: { ...s.window, [key]: value } }));
	const toggleDay = (day: number) =>
		setWindow(
			"days",
			settings.window.days.includes(day)
				? settings.window.days.filter((d) => d !== day)
				: [...settings.window.days, day],
		);
	const rule = RULES.find((r) => r.value === settings.versionRule);

	return (
		<form
			className="flex flex-col gap-5"
			onSubmit={(event) => {
				event.preventDefault();
				onSave(settings);
			}}
		>
			<div className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
				<div className="flex flex-col gap-0.5">
					<Label htmlFor="update-enabled">Scheduled updates</Label>
					<p className="text-sm text-muted-foreground">
						Off by default. Nothing is checked or updated until this is on.
					</p>
				</div>
				<Switch
					id="update-enabled"
					checked={settings.enabled}
					onCheckedChange={(enabled) => set("enabled", enabled)}
				/>
			</div>

			<div className="grid gap-4 md:grid-cols-2">
				<Field
					label="When an update is found"
					hint={
						settings.mode === "notify"
							? "Sends a notification once per new version; you update yourself."
							: "Installs it in the window, and puts the previous version back if it does not stay healthy."
					}
				>
					<Select
						value={settings.mode}
						onValueChange={(mode) => set("mode", mode as UpdateMode)}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="notify">Notify me</SelectItem>
							<SelectItem value="auto">Update automatically</SelectItem>
						</SelectContent>
					</Select>
				</Field>
				<Field label="Versions to follow" hint={rule?.hint}>
					<Select
						value={settings.versionRule}
						onValueChange={(value) => set("versionRule", value as VersionRule)}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{RULES.filter((r) => rules.includes(r.value)).map((r) => (
								<SelectItem key={r.value} value={r.value}>
									{r.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			</div>

			<Field
				label="Maintenance window"
				hint={`Updates start inside this window only. Application updates stay ${marginMinutes} minutes away from the Dokploy window, on both sides.`}
			>
				<div className="flex flex-wrap gap-1.5">
					{DAYS.map((day) => (
						<Button
							key={day.value}
							type="button"
							size="sm"
							variant={
								settings.window.days.includes(day.value) ? "default" : "outline"
							}
							aria-pressed={settings.window.days.includes(day.value)}
							onClick={() => toggleDay(day.value)}
						>
							{day.label}
						</Button>
					))}
				</div>
				<div className="mt-2 grid gap-3 sm:grid-cols-3">
					<div className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">Starts at</span>
						<Input
							type="time"
							value={settings.window.startTime}
							onChange={(e) => setWindow("startTime", e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">
							Lasts (minutes)
						</span>
						<Input
							type="number"
							min={15}
							max={720}
							step={15}
							value={settings.window.durationMinutes}
							onChange={(e) =>
								setWindow("durationMinutes", Number(e.target.value))
							}
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">Time zone</span>
						<Input
							list="update-timezones"
							value={settings.window.timezone}
							onChange={(e) => setWindow("timezone", e.target.value)}
						/>
						<datalist id="update-timezones">
							{zones.map((zone) => (
								<option key={zone} value={zone} />
							))}
						</datalist>
					</div>
				</div>
				{conflictNote}
			</Field>

			<div className="grid gap-4 md:grid-cols-2">
				<Field
					label="Safety delay (hours)"
					hint="A release is installed only once it is this old: broken releases are often replaced within a day or two."
				>
					<Input
						type="number"
						min={0}
						max={720}
						value={settings.minAgeHours}
						onChange={(e) => set("minAgeHours", Number(e.target.value))}
					/>
				</Field>
				<Field
					label="Watch after updating (minutes)"
					hint="The new version must stay healthy this long, or the previous one is put back."
				>
					<Input
						type="number"
						min={1}
						max={60}
						value={settings.verifyMinutes}
						onChange={(e) => set("verifyMinutes", Number(e.target.value))}
					/>
				</Field>
			</div>

			{backupOptions && (
				<Field
					label="Backups to run first"
					hint={
						backupOptions.length === 0
							? "No database or compose backup in this environment."
							: "If one fails, the update does not start."
					}
				>
					<div className="flex flex-col gap-2">
						{backupOptions.map((option) => (
							<div key={option.backupId} className="flex items-center gap-2">
								<Checkbox
									id={`backup-${option.backupId}`}
									checked={settings.backupIds.includes(option.backupId)}
									onCheckedChange={(checked) =>
										set(
											"backupIds",
											checked
												? [...settings.backupIds, option.backupId]
												: settings.backupIds.filter(
														(id) => id !== option.backupId,
													),
										)
									}
								/>
								<Label
									htmlFor={`backup-${option.backupId}`}
									className="font-normal"
								>
									{option.label}
								</Label>
							</div>
						))}
					</div>
				</Field>
			)}

			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">
					{policy?.enabled && policy.nextWindow
						? `Next window: ${formatWhen(policy.nextWindow.start)}`
						: "No window planned."}
				</p>
				<Button type="submit" disabled={saving}>
					{saving && <Loader2 className="size-4 animate-spin" />}
					Save
				</Button>
			</div>
		</form>
	);
};
