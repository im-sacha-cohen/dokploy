import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { AlignLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormMessage,
} from "@/components/ui/form";
import { api } from "@/utils/api";
import { formatYaml } from "@/utils/format-yaml";
import { validateAndFormatYAML } from "../../application/advanced/traefik/update-traefik-config";

interface Props {
	composeId: string;
}

const AddComposeFile = z.object({
	composeFile: z.string(),
});

type AddComposeFile = z.infer<typeof AddComposeFile>;

export const ComposeFileEditor = ({ composeId }: Props) => {
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canUpdate = permissions?.service.create ?? false;
	const utils = api.useUtils();
	const { data, refetch } = api.compose.one.useQuery(
		{
			composeId,
		},
		{ enabled: !!composeId },
	);

	const { mutateAsync, isPending } = api.compose.update.useMutation();
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

	const form = useForm<AddComposeFile>({
		defaultValues: {
			composeFile: "",
		},
		resolver: zodResolver(AddComposeFile),
	});

	const composeFile = form.watch("composeFile");

	useEffect(() => {
		if (data) {
			form.reset({
				composeFile: data.composeFile || "",
			});
		}
	}, [form, data]);

	useEffect(() => {
		if (data?.composeFile !== undefined) {
			setHasUnsavedChanges(composeFile !== data.composeFile);
		}
	}, [composeFile, data?.composeFile]);

	const onSubmit = async (data: AddComposeFile) => {
		const { valid, error } = validateAndFormatYAML(data.composeFile);
		if (!valid) {
			form.setError("composeFile", {
				type: "manual",
				message: error || "Invalid YAML",
			});
			return;
		}

		form.clearErrors("composeFile");
		await mutateAsync({
			composeId,
			composeFile: data.composeFile,
			composePath: "./docker-compose.yml",
			sourceType: "raw",
		})
			.then(async () => {
				toast.success("Compose config Updated");
				setHasUnsavedChanges(false);
				refetch();
				await utils.compose.getConvertedCompose.invalidate({
					composeId,
				});
			})
			.catch(() => {
				toast.error("Error updating the Compose config");
			});
	};

	const formatComposeFile = () => {
		const result = formatYaml(form.getValues("composeFile"));
		if (!result.ok) {
			const where = result.line ? `Line ${result.line}: ` : "";
			form.setError("composeFile", {
				type: "manual",
				message: `${where}${result.error}`,
			});
			toast.error("Cannot format: the YAML is invalid", {
				description: `${where}${result.error}`,
			});
			return;
		}
		form.clearErrors("composeFile");
		if (result.changed) {
			form.setValue("composeFile", result.formatted, { shouldDirty: true });
		}
		if (result.warnings.length > 0) {
			toast.warning(
				result.changed ? "Formatted, but check this" : "Check this",
				{ description: result.warnings.join("\n") },
			);
		} else {
			toast.success(result.changed ? "Formatted" : "Already formatted");
		}
	};

	// Ctrl/Cmd+S saves, Shift+Alt+F formats (same shortcut as VS Code).
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.code === "KeyS" && !isPending) {
				e.preventDefault();
				form.handleSubmit(onSubmit)();
			}
			if (e.shiftKey && e.altKey && e.code === "KeyF" && canUpdate) {
				e.preventDefault();
				formatComposeFile();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [form, onSubmit, isPending, canUpdate, formatComposeFile]);

	return (
		<>
			<div className="w-full flex flex-col gap-4 ">
				<div className="flex items-center justify-between">
					<div>
						<h3 className="text-lg font-medium">Compose File</h3>
						<p className="text-sm text-muted-foreground">
							Configure your Docker Compose file for this service.
							{hasUnsavedChanges && (
								<span className="text-yellow-500 ml-2">
									(You have unsaved changes)
								</span>
							)}
						</p>
					</div>
				</div>
				<Form {...form}>
					<form
						id="hook-form-save-compose-file"
						onSubmit={form.handleSubmit(onSubmit)}
						className="w-full relative space-y-4"
					>
						<FormField
							control={form.control}
							name="composeFile"
							render={({ field }) => (
								<FormItem className="overflow-auto">
									<FormControl className="">
										<div className="flex flex-col gap-4 w-full outline-hidden focus:outline-hidden overflow-auto">
											<CodeEditor
												// disabled
												language="yaml"
												value={field.value}
												className="font-mono"
												wrapperClassName="compose-file-editor"
												placeholder={`services:
  web:
    image: nginx
    ports:
      - "80:80"
`}
												onChange={(value) => {
													field.onChange(value);
												}}
											/>
										</div>
									</FormControl>
									<pre>
										<FormMessage />
									</pre>
								</FormItem>
							)}
						/>
					</form>
				</Form>
				<div className="flex justify-between flex-col lg:flex-row gap-2">
					<div className="w-full flex flex-col lg:flex-row gap-4 items-end" />
					{canUpdate && (
						<div className="flex flex-col lg:flex-row gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={formatComposeFile}
								className="lg:w-fit w-full"
								title="Re-indent with 2 spaces, comments kept (Shift+Alt+F)"
							>
								<AlignLeft className="size-4" />
								Format
							</Button>
							<Button
								type="submit"
								form="hook-form-save-compose-file"
								isLoading={isPending}
								className="lg:w-fit w-full"
							>
								Save
							</Button>
						</div>
					)}
				</div>
			</div>
		</>
	);
};
