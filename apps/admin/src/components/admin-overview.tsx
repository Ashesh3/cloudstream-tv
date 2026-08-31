import type { AdminSnapshotResponse } from "@cloudframe/shared";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

export function AdminOverview({ snapshot, compact = false }: { snapshot: AdminSnapshotResponse; compact?: boolean }) {
  const approvedDevices = snapshot.devices.filter(device => device.revokedAt === null);
  const connectedSources = snapshot.sources.filter(source => source.status === "healthy");
  const approvedRoots = snapshot.roots.filter(root => root.enabled);

  return <VStack gap={4} aria-label="Household overview">
    <Heading level={2}>Household overview</Heading>
    <Section padding={4} dividers={["top", "bottom"]} role="region" aria-label="Source health">
      <VStack gap={3}>
        <Heading level={2}>Source health</Heading>
        {snapshot.sources.length ? <List density="compact" hasDividers>
          {snapshot.sources.map(source => {
            const status = sourceStatus(source.status);
            return <ListItem
              key={source.id}
              label={source.accountLabel}
              description={source.provider === "google" ? "Google Drive" : "OneDrive"}
              endContent={<HStack gap={2} align="center"><StatusDot variant={status.variant} label={status.label} /><Text type="supporting">{status.label}</Text></HStack>}
            />;
          })}
        </List> : <Text type="supporting" as="p">No cloud source connected</Text>}
      </VStack>
    </Section>
    {!compact && <>
      <Section padding={4} variant="muted" role="region" aria-label="Attention">
        <VStack gap={2}>
          <Heading level={2}>{snapshot.pendingRequests.length ? `${snapshot.pendingRequests.length} ${snapshot.pendingRequests.length === 1 ? "television" : "televisions"} waiting` : "No device requests need review"}</Heading>
          <Text as="p">{snapshot.pendingRequests.length ? "Review each television and assign only the approved folders." : "Source health and household access remain visible above."}</Text>
        </VStack>
      </Section>
      <Grid columns={{ minWidth: 14 * 16, max: 3, repeat: "fit" }} gap={3} role="region" aria-label="Program figures">
        <Summary value={`${approvedDevices.length} approved`} label="televisions" />
        <Summary value={`${connectedSources.length} connected`} label="cloud sources" />
        <Summary value={`${approvedRoots.length} approved`} label="folders" />
      </Grid>
      <Text type="supporting" as="p" role="status">Local encrypted storage</Text>
    </>}
  </VStack>;
}

function Summary({ value, label }: { value: string; label: string }) {
  return <Card padding={4}>
    <VStack gap={1}>
      <Text type="large" weight="semibold" hasTabularNumbers>{value}</Text>
      <Text type="supporting">{label}</Text>
    </VStack>
  </Card>;
}

function sourceStatus(status: "healthy" | "reauth-required" | "disabled") {
  if (status === "healthy") return { label: "Connected", variant: "success" as const };
  if (status === "reauth-required") return { label: "Reauthorization required", variant: "warning" as const };
  return { label: "Disabled", variant: "neutral" as const };
}
