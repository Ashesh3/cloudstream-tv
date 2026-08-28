import type { ControlDeviceDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
import { AlertTriangleIcon, MonitorIcon, Trash2Icon } from "lucide-react";
import { providerName } from "../design/ledger";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

export type ProgramRoot = ControlRootDto & { providerNodeId?: string };

export function HouseholdProgram({ source, roots, devices, onRemove }: {
  source: ControlSourceDto;
  roots: ProgramRoot[];
  devices: ControlDeviceDto[];
  onRemove(root: ProgramRoot): void;
}) {
  return <aside className="household-program flex min-h-0 flex-col gap-4" aria-labelledby="household-program-title" data-workbench-region="program">
    <div className="program-header">
      <h2 id="household-program-title" className="font-heading text-lg font-medium">Household program ledger</h2>
      <p className="mt-1 text-sm text-muted-foreground">Approved folders are available to assigned televisions immediately.</p>
    </div>
    {!roots.length ? <div className="program-empty grid min-h-40 place-items-center border border-dashed p-5 text-center">
      <div><p className="font-medium">No folders in the household program</p><p className="mt-1 text-sm text-muted-foreground">Choose a provider folder to make it available for television assignments.</p></div>
    </div> : <ul className="program-root-list min-h-0 space-y-3 overflow-y-auto" aria-label="Selected household folders">
      {roots.map(root => {
        const inactive = !root.enabled;
        const assignedDevices = devices.filter(device => device.revokedAt === null && device.assignedRootIds.includes(root.id));
        return <li className="program-root border p-3" key={root.id} data-legacy-root={inactive || undefined} data-root-status={inactive ? "inactive" : "approved"}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><p className="truncate font-medium">{root.displayName}</p><p className="mt-1 text-xs text-muted-foreground">{providerName(source.provider)} · {source.accountLabel}</p></div>
            <Button className="workbench-touch-target" size="icon-sm" variant="destructive" aria-label={`Review removal impact for ${root.displayName}`} onClick={() => onRemove(root)}><Trash2Icon /><span className="sr-only">Review removal impact</span></Button>
          </div>
          {inactive && <div className="mt-3 flex gap-2 bg-destructive/10 p-2.5 text-xs text-destructive"><AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><div><p className="font-medium">Inactive legacy selection</p><p className="mt-1 text-destructive/80">This migration record grants no television access and can be removed safely after review.</p></div></div>}
          <div className="mt-3 flex flex-wrap gap-1.5" aria-label={`Televisions assigned to ${root.displayName}`}>
            {assignedDevices.length ? assignedDevices.map(device => <Badge variant="outline" key={device.id}><MonitorIcon data-icon="inline-start" />{device.name}</Badge>) : <span className="text-xs text-muted-foreground">No televisions assigned</span>}
          </div>
        </li>;
      })}
    </ul>}
  </aside>;
}
