import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
	endTime,
	type Preset,
	PresetSelect,
	TimePicker,
	TimezonePicker,
} from "./window-pickers";

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

const formatDuration = (minutes: number) => {
	if (minutes < 60) return `${minutes} minutes`;
	const hours = minutes / 60;
	return Number.isInteger(hours)
		? `${hours} hour${hours > 1 ? "s" : ""}`
		: `${Math.floor(hours)} h ${minutes % 60} min`;
};

const WINDOW_LENGTHS: Preset[] = [30, 60, 120, 180, 240, 360, 480, 720].map(
	(minutes) => ({ value: minutes, label: formatDuration(minutes) }),
);
const RELEASE_DELAYS: Preset[] = [
	{ value: 0, label: "Right away" },
	{ value: 24, label: "1 day" },
	{ value: 48, label: "2 days" },
	{ value: 72, label: "3 days (recommended)" },
	{ value: 168, label: "1 week" },
];
const CHECK_DURATIONS: Preset[] = [
	{ value: 2, label: "2 minutes" },
	{ value: 5, label: "5 minutes (recommended)" },
	{ value: 10, label: "10 minutes" },
	{ value: 15, label: "15 minutes" },
	{ value: 30, label: "30 minutes" },
];

const DAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];
const describeDays = (days: number[]) => {
	if (days.length === 7) return "Every day";
	const order = [1, 2, 3, 4, 5, 6, 0];
	return `Every ${order
		.filter((d) => days.includes(d))
		.map((d) => DAY_NAMES[d])
		.join(", ")}`;
};

const browserTimezone = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
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
				hint={`Updates only start inside this window. Application updates stay ${marginMinutes} minutes away from the Dokploy window, before and after it.`}
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
						<TimePicker
							value={settings.window.startTime}
							onChange={(value) => setWindow("startTime", value)}
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">Window length</span>
						<PresetSelect
							value={settings.window.durationMinutes}
							onChange={(value) => setWindow("durationMinutes", value)}
							presets={WINDOW_LENGTHS}
							describe={(minutes) => formatDuration(minutes)}
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">Time zone</span>
						<TimezonePicker
							value={settings.window.timezone}
							onChange={(value) => setWindow("timezone", value)}
						/>
					</div>
				</div>
				<p className="mt-1 text-sm">
					{settings.window.days.length === 0
						? "Pick at least one day."
						: `${describeDays(settings.window.days)}, from ${settings.window.startTime} to ${endTime(settings.window.startTime, settings.window.durationMinutes)}.`}
				</p>
				{conflictNote}
			</Field>

			<div className="grid gap-4 md:grid-cols-2">
				<Field
					label="Wait before installing a new release"
					hint="A release is installed only once it has been out this long. Broken releases are usually replaced within a day or two, so waiting avoids most of them."
				>
					<PresetSelect
						value={settings.minAgeHours}
						onChange={(value) => set("minAgeHours", value)}
						presets={RELEASE_DELAYS}
						describe={(hours) =>
							hours === 0 ? "Right away" : `${hours} hours`
						}
					/>
				</Field>
				<Field
					label="Check after updating"
					hint="The new version must keep running and healthy for this long. If it fails or stops in that time, the previous version is put back automatically."
				>
					<PresetSelect
						value={settings.verifyMinutes}
						onChange={(value) => set("verifyMinutes", value)}
						presets={CHECK_DURATIONS}
						describe={(minutes) => formatDuration(minutes)}
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
