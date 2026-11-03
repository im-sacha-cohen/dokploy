import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { api } from "@/utils/api";

/**
 * Delete confirmation for a domain whose DNS record Dokploy created: offers to
 * delete the record too, only while it still points to this server.
 */
export const DeleteDomainWithDns = ({
	domainId,
	host,
	onDeleted,
	children,
}: {
	domainId: string;
	host: string;
	onDeleted: () => void;
	children: React.ReactNode;
}) => {
	const [open, setOpen] = useState(false);
	const [deleteRecord, setDeleteRecord] = useState(true);
	const { data: record, isLoading } = api.domainDns.recordForDomain.useQuery(
		{ domainId },
		{ enabled: open },
	);
	const remove = api.domainDns.deleteDomain.useMutation();
	useEffect(() => {
		if (record) setDeleteRecord(record.canDelete);
	}, [record]);

	const confirm = async () => {
		try {
			const result = await remove.mutateAsync({
				domainId,
				deleteRecord: !!record?.canDelete && deleteRecord,
			});
			toast.success(
				result.recordDeleted
					? `Domain and DNS record ${record?.name} deleted`
					: "Domain deleted successfully",
			);
			if ("recordError" in result && result.recordError) {
				toast.error(`The DNS record was not deleted: ${result.recordError}`);
			}
			onDeleted();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Error deleting domain",
			);
		}
	};

	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete Domain</AlertDialogTitle>
					<AlertDialogDescription>
						Are you sure you want to delete {host}?
					</AlertDialogDescription>
				</AlertDialogHeader>
				{isLoading ? (
					<p className="text-sm text-muted-foreground">
						Checking the DNS record…
					</p>
				) : record?.canDelete ? (
					<div className="flex items-start gap-2">
						<Checkbox
							id="delete-dns-record"
							checked={deleteRecord}
							onCheckedChange={(checked) => setDeleteRecord(checked === true)}
						/>
						<Label htmlFor="delete-dns-record" className="leading-snug">
							Also delete the DNS record {record.name} at {record.providerName}
						</Label>
					</div>
				) : record ? (
					<p className="text-sm text-muted-foreground">
						The DNS record {record.name} is kept
						{record.reason ? `: ${record.reason.toLowerCase()}` : "."}
					</p>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={isLoading || remove.isPending}
						onClick={(event) => {
							event.preventDefault();
							void confirm().then(() => setOpen(false));
						}}
					>
						Confirm
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
};
