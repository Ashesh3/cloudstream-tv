import type { ReactNode } from "react";
import type { ControlRequestDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
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
import { VStack } from "@astryxdesign/core/VStack";
import { CheckIcon, FolderOpenIcon, MonitorIcon, XIcon } from "lucide-react";

export function Requests({ requests, roots, sources, disabled, pendingId, onApprove, onDeny }: {
  requests: ControlRequestDto[];
  roots: ControlRootDto[];
  sources: ControlSourceDto[];
  disabled: boolean;
  pendingId: string | null;
  onApprove(request: ControlRequestDto): void;
  onDeny(request: ControlRequestDto): void;
}) {
  const sorted = [...requests]
    .filter(request => request.status === "pending")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const enabledRootCount = roots.filter(root => root.enabled).length;

  return <VStack as="section" gap={5} aria-labelledby="device-requests-title">
    <PageHeader context="Enrollment" title="Device requests" description="Review new televisions and choose exactly which cloud folders each device can browse." />
    {disabled && <Banner status="warning" title="New requests are paused" description="Turn enrollment back on in Settings when you are ready to add another television." container="section" />}
    {!sorted.length ? <Empty title="No pending requests" body="New televisions will appear here for 30 minutes after they request household access." icon={<Icon icon={MonitorIcon} />} /> : <List density="balanced" hasDividers>
      {sorted.map(request => <ListItem
        key={request.id}
        data-testid="request-row"
        startContent={<Icon icon={MonitorIcon} color="secondary" />}
        label={<HStack gap={2} align="center"><Text weight="semibold">{request.requestedName}</Text><StatusDot variant="warning" label="Pending request" /><Text type="supporting">Pending</Text></HStack>}
        description={<VStack gap={1}><Text type="supporting">Requested {relativeTime(request.createdAt)} · Expires {relativeTime(request.expiresAt)}</Text><Text type="supporting">{enabledRootCount} available folders across {sources.length} {sources.length === 1 ? "source" : "sources"}</Text></VStack>}
        endContent={<HStack gap={2} wrap="wrap">
          <Button label={`Deny ${request.requestedName}`} variant="secondary" icon={<Icon icon={XIcon} />} isDisabled={pendingId !== null} isLoading={pendingId === request.id} onClick={() => onDeny(request)}>Deny</Button>
          <Button label={`Approve ${request.requestedName}`} variant="primary" icon={<Icon icon={CheckIcon} />} isDisabled={pendingId !== null} onClick={() => onApprove(request)}>Review access</Button>
        </HStack>}
      />)}
    </List>}
  </VStack>;
}

export function PageHeader({ context, title, description, action }: { context: string; title: string; description: string; action?: ReactNode }) {
  return <Section padding={0} dividers={["bottom"]} data-context={context}>
    <HStack gap={4} justify="between" align="end" wrap="wrap">
      <VStack gap={2}>
        <Heading level={1} id={`${title.toLowerCase().replace(/\s/g, "-")}-title`}>{title}</Heading>
        <Text type="supporting" as="p">{description}</Text>
      </VStack>
      {action}
    </HStack>
  </Section>;
}

export function Empty({ title, body, icon = <Icon icon={FolderOpenIcon} /> }: { title: string; body: string; icon?: ReactNode }) {
  return <EmptyState title={title} description={body} icon={icon} headingLevel={2} />;
}

export function relativeTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "at an unknown time" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
