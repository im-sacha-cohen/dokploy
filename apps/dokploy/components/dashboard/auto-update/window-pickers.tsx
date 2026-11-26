import { Check, ChevronDown, Clock, Globe } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, h) => pad(h));
const MINUTES = ["00", "15", "30", "45"];

/** `HH:MM`, picked from an hour grid and quarter hours. */
export const TimePicker = ({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) => {
	const [open, setOpen] = useState(false);
	const [hour = "03", minute = "00"] = value.split(":");
	const minutes = MINUTES.includes(minute)
		? MINUTES
		: [...MINUTES, minute].sort();
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					className="w-full justify-between font-normal"
				>
					{hour}:{minute}
					<Clock className="size-4 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-72 p-3" align="start">
				<p className="mb-2 text-xs font-medium text-muted-foreground">Hour</p>
				<div className="grid grid-cols-6 gap-1">
					{HOURS.map((h) => (
						<Button
							key={h}
							type="button"
							size="sm"
							variant={h === hour ? "default" : "ghost"}
							className="h-8 px-0"
							onClick={() => onChange(`${h}:${minute}`)}
						>
							{h}
						</Button>
					))}
				</div>
				<p className="mt-3 mb-2 text-xs font-medium text-muted-foreground">
					Minutes
				</p>
				<div className="grid grid-cols-4 gap-1">
					{minutes.map((m) => (
						<Button
							key={m}
							type="button"
							size="sm"
							variant={m === minute ? "default" : "ghost"}
							className="h-8 px-0"
							onClick={() => {
								onChange(`${hour}:${m}`);
								setOpen(false);
							}}
						>
							:{m}
						</Button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
};

const timezones = () => {
	const intl = Intl as unknown as {
		supportedValuesOf?: (key: string) => string[];
	};
	// Browsers leave UTC out of this list.
	const zones = intl.supportedValuesOf?.("timeZone") ?? [];
	return ["UTC", ...zones.filter((zone) => zone !== "UTC")];
};

/** Searchable list of IANA time zones. */
export const TimezonePicker = ({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) => {
	const [open, setOpen] = useState(false);
	const zones = useMemo(() => {
		const all = timezones();
		return all.includes(value) ? all : [value, ...all];
	}, [value]);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					role="combobox"
					aria-expanded={open}
					className="w-full justify-between font-normal"
				>
					<span className="flex items-center gap-2 truncate">
						<Globe className="size-4 opacity-50" />
						{value}
					</span>
					<ChevronDown className="size-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-72 p-0" align="start">
				<Command>
					<CommandInput placeholder="Search a city or region…" />
					<CommandList>
						<CommandEmpty>No time zone found.</CommandEmpty>
						{zones.map((zone) => (
							<CommandItem
								key={zone}
								value={zone}
								onSelect={() => {
									onChange(zone);
									setOpen(false);
								}}
							>
								<Check
									className={cn(
										"size-4",
										zone === value ? "opacity-100" : "opacity-0",
									)}
								/>
								{zone.replaceAll("_", " ")}
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
};

export interface Preset {
	value: number;
	label: string;
}

/** A number chosen among labelled presets; an unusual saved value stays listed. */
export const PresetSelect = ({
	value,
	onChange,
	presets,
	describe,
}: {
	value: number;
	onChange: (value: number) => void;
	presets: Preset[];
	describe: (value: number) => string;
}) => {
	const options = presets.some((p) => p.value === value)
		? presets
		: [...presets, { value, label: describe(value) }].sort(
				(a, b) => a.value - b.value,
			);
	return (
		<Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
			<SelectTrigger>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={String(option.value)}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
};

export const endTime = (startTime: string, durationMinutes: number) => {
	const [h = 0, m = 0] = startTime.split(":").map(Number);
	const end = (h * 60 + m + durationMinutes) % (24 * 60);
	const nextDay = h * 60 + m + durationMinutes >= 24 * 60;
	return `${pad(Math.floor(end / 60))}:${pad(end % 60)}${nextDay ? " (next day)" : ""}`;
};
