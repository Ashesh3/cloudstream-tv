import type { ReactNode } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutHeader, LayoutPanel } from "@astryxdesign/core/Layout";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { CloudIcon, LayoutDashboardIcon, MonitorIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";

export type AdminSection = "requests" | "devices" | "sources" | "settings";

const sections = [
  { id: "requests" as const, label: "Requests", icon: LayoutDashboardIcon },
  { id: "devices" as const, label: "Devices", icon: MonitorIcon },
  { id: "sources" as const, label: "Sources", icon: CloudIcon },
  { id: "settings" as const, label: "Settings", icon: SettingsIcon },
];

export function Shell({ section, onSection, pendingCount, onRefresh, refreshing, contentMode = "standard", children, end, endTestId }: {
  section: AdminSection;
  onSection(value: AdminSection): void;
  pendingCount: number;
  onRefresh(): void;
  refreshing: boolean;
  contentMode?: "standard" | "sources";
  children: ReactNode;
  end?: ReactNode;
  endTestId?: string;
}) {
  const navigation = <SideNav
    header={<SideNavHeading heading="Cloudframe" subheading="Household admin" icon={<Icon icon="wrench" color="accent" />} />}
    footer={<Text type="supporting">Private household</Text>}
  >
    <SideNavSection title="Household" isHeaderHidden>
      {sections.map(item => <SideNavItem
        key={item.id}
        label={item.label}
        icon={item.icon}
        isSelected={section === item.id}
        onClick={() => onSection(item.id)}
        endContent={item.id === "requests" && pendingCount > 0 ? <Badge label={pendingCount} variant="error" aria-hidden="true" /> : undefined}
      />)}
    </SideNavSection>
  </SideNav>;

  const top = <LayoutHeader hasDivider padding={4}>
    <HStack gap={3} align="center" justify="between" wrap="wrap">
      <Text type="label">Household control</Text>
      <HStack gap={2} align="center" wrap="wrap">
        {pendingCount > 0 && <Badge label={`${pendingCount} pending`} variant="neutral" />}
        <Button
          label="Refresh"
          variant="secondary"
          size="sm"
          icon={<Icon icon={RefreshCwIcon} />}
          isLoading={refreshing}
          isInterruptible
          onClick={onRefresh}
          aria-busy={refreshing}
        />
      </HStack>
    </HStack>
  </LayoutHeader>;

  return <AppShell sideNav={navigation} mobileNav={{ breakpoint: "md" }} contentPadding={0} height="auto" variant="section">
    <Layout
      height="auto"
      header={top}
      contentWidth={contentMode === "sources" ? undefined : "90rem"}
      padding={4}
      content={<LayoutContent isScrollable={false} padding={0} data-testid={end ? "source-workbench-layout" : undefined}>{children}</LayoutContent>}
      end={end ? <LayoutPanel width="24rem" hasDivider isScrollable={false} label="Household folders" role="complementary" data-testid={endTestId}>{end}</LayoutPanel> : undefined}
    />
  </AppShell>;
}
