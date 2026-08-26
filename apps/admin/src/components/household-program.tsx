import type { AssignedRootDto, DeviceDto, SourceDto } from "@cloudframe/shared";
import { AlertTriangleIcon, MonitorIcon, Trash2Icon } from "lucide-react";
import { providerName } from "../design/ledger";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { IndexStatus } from "./index-status";

export function HouseholdProgram({ source, roots, devices, onRemove }: {
  source: SourceDto;
  roots: AssignedRootDto[];
  devices: DeviceDto[];
  onRemove(root: AssignedRootDto): void;
}) {
  const enabledRoots = roots.filter(root => root.enabled);
  return <aside className="household-program flex min-h-0 flex-col gap-4" aria-labelledby="household-program-title" data-workbench-region="program">
    <div>
      <h2 id="household-program-title" className="font-heading text-lg font-medium">Household program</h2>
      <p className="mt-1 text-sm text-muted-foreground">Selected folders appear on assigned televisions as indexing progresses.</p>
    </div>
    <IndexStatus state={source.indexState} />
    {!enabledRoots.length ? <div className="grid min-h-40 place-items-center rounded-xl border border-dashed p-5 text-center">
      <div><p className="font-medium">No folders in the household program</p><p className="mt-1 text-sm text-muted-foreground">Choose a provider folder to begin indexing only what this household uses.</p></div>
    </div> : <ul className="program-root-list min-h-0 space-y-3 overflow-y-auto" aria-label="Selected household folders">
      {enabledRoots.map(root => {
        const legacy = Boolean(source.providerRootId && root.providerNodeId === source.providerRootId);
        const assignedDevices = devices.filter(device => !device.revokedAt && device.assignedRootIds.includes(root.id));
        const displayName = legacy ? `Entire ${source.provider === "google" ? "My Drive" : "OneDrive"}` : root.displayName;
        return <li className="program-root rounded-xl border p-3" key={root.id} data-legacy-root={legacy || undefined}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><p className="truncate font-medium">{displayName}</p><p className="mt-1 text-xs text-muted-foreground">{providerName(source.provider)} · {source.accountLabel}</p></div>
            <Button size="icon-sm" variant="destructive" aria-label={`Review removal impact for ${displayName}`} onClick={() => onRemove(root)}><Trash2Icon /><span className="sr-only">Review removal impact</span></Button>
          </div>
          {legacy && <div className="mt-3 flex gap-2 rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive"><AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><div><p className="font-medium">Legacy whole-drive selection</p><p className="mt-1 text-destructive/80">This older selection can index the entire account. Choose narrower folders before removing it.</p></div></div>}
          <div className="mt-3 flex flex-wrap gap-1.5" aria-label={`Televisions assigned to ${displayName}`}>
            {assignedDevices.length ? assignedDevices.map(device => <Badge variant="outline" key={device.id}><MonitorIcon data-icon="inline-start" />{device.name}</Badge>) : <span className="text-xs text-muted-foreground">No televisions assigned</span>}
          </div>
        </li>;
      })}
    </ul>}
  </aside>;
}
