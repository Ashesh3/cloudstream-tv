import type { ControlDeviceDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { AlertTriangleIcon, FolderOpenIcon, MonitorIcon, Trash2Icon } from "lucide-react";
import { providerName } from "../lib/provider-name";

export type ProgramRoot = ControlRootDto & { providerNodeId?: string };

export function HouseholdProgram({ source, roots, devices, onRemove }: {
  source: ControlSourceDto;
  roots: ProgramRoot[];
  devices: ControlDeviceDto[];
  onRemove(root: ProgramRoot): void;
}) {
  return <VStack as="aside" height="100%" gap={0} aria-labelledby="household-program-title" data-workbench-region="program">
    <Section padding={4} variant="muted" dividers={["bottom"]}>
      <VStack gap={2}>
        <Heading id="household-program-title" level={2}>Household folders</Heading>
        <Text type="supporting" as="p">Approved folders are available to assigned televisions immediately.</Text>
      </VStack>
    </Section>
    <Section padding={0} variant="transparent">
      {!roots.length ? <EmptyState
        title="No folders in the household program"
        description="Choose a provider folder to make it available for television assignments."
        icon={<Icon icon={FolderOpenIcon} size="lg" />}
        headingLevel={3}
        isCompact
      /> : <List density="spacious" hasDividers aria-label="Selected household folders">
        {roots.map(root => {
          const inactive = !root.enabled;
          const assignedDevices = devices.filter(device => device.revokedAt === null && device.assignedRootIds.includes(root.id));
          return <ListItem
            key={root.id}
            data-legacy-root={inactive || undefined}
            data-root-status={inactive ? "inactive" : "approved"}
            startContent={<StatusDot variant={inactive ? "warning" : "success"} label={inactive ? "Inactive legacy selection" : "Approved folder"} />}
            label={<HStack gap={2} align="center" wrap="wrap"><Text weight="semibold">{root.displayName}</Text>{inactive && <Token label="Legacy record" size="sm" color="gray" />}</HStack>}
            description={<VStack gap={3}>
              <Text type="supporting">{providerName(source.provider)} · {source.accountLabel}</Text>
              {inactive && <Banner status="warning" title="Inactive legacy selection" description="This migration record grants no television access and can be removed safely after review." icon={<Icon icon={AlertTriangleIcon} />} container="section" />}
              <HStack gap={2} wrap="wrap" aria-label={`Televisions assigned to ${root.displayName}`}>
                {assignedDevices.length ? assignedDevices.map(device => <Token key={device.id} label={device.name} size="sm" color="blue" icon={<Icon icon={MonitorIcon} size="xsm" />} />) : <Text type="supporting">No televisions assigned</Text>}
              </HStack>
            </VStack>}
            endContent={<Button label={`Review removal impact for ${root.displayName}`} variant="destructive" size="lg" icon={<Icon icon={Trash2Icon} />} isIconOnly onClick={() => onRemove(root)} />}
          />;
        })}
      </List>}
    </Section>
  </VStack>;
}
