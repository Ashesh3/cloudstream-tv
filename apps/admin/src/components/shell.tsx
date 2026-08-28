import type { ReactNode } from "react";
import {
  CloudIcon,
  LayoutDashboardIcon,
  MenuIcon,
  MonitorIcon,
  RefreshCwIcon,
  SettingsIcon,
  ShieldCheckIcon
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger
} from "@/components/ui/sidebar";

export type AdminSection = "requests" | "devices" | "sources" | "settings";

const sections = [
  { id: "requests" as const, label: "Requests", icon: LayoutDashboardIcon },
  { id: "devices" as const, label: "Devices", icon: MonitorIcon },
  { id: "sources" as const, label: "Sources", icon: CloudIcon },
  { id: "settings" as const, label: "Settings", icon: SettingsIcon }
];

export function Shell({ section, onSection, pendingCount, onRefresh, refreshing, contentMode = "standard", children }: {
  section: AdminSection;
  onSection(value: AdminSection): void;
  pendingCount: number;
  onRefresh(): void;
  refreshing: boolean;
  contentMode?: "standard" | "sources";
  children: ReactNode;
}) {
  return (
    <SidebarProvider defaultOpen>
        <Sidebar collapsible="icon" aria-label="Admin sidebar">
          <SidebarHeader className="border-b p-3">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" tooltip="Cloudframe household admin" className="pointer-events-none">
                  <span className="brand-cue" aria-hidden="true">
                    <span />
                  </span>
                  <span className="flex min-w-0 flex-col leading-none">
                    <strong className="truncate text-sm">Cloudframe</strong>
                    <span className="truncate text-xs text-muted-foreground">Screening ledger</span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <Navigation label="Admin sections" section={section} onSection={onSection} pendingCount={pendingCount} />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter className="border-t p-3">
            <div className="flex items-center gap-2 rounded-lg bg-sidebar-accent px-2 py-2 text-xs text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
              <ShieldCheckIcon className="size-4 shrink-0" />
              <span className="truncate group-data-[collapsible=icon]:hidden">Private household</span>
            </div>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-w-0 bg-background">
          <header className="admin-topbar sticky top-0 z-20 flex h-16 items-center gap-3 border-b px-4 md:px-6">
            <SidebarTrigger aria-label="Open admin menu" className="md:hidden">
              <MenuIcon />
            </SidebarTrigger>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">Private screening program</p>
              <p className="truncate text-xs text-muted-foreground">Source truth · television access</p>
            </div>
            {pendingCount > 0 && <Badge variant="secondary">{pendingCount} pending</Badge>}
            <Button variant="outline" size="sm" onClick={onRefresh} aria-busy={refreshing}>
              <RefreshCwIcon data-icon="inline-start" className={refreshing ? "animate-spin" : undefined} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </header>
          <main className="admin-main mx-auto w-full max-w-[1440px] p-4 pb-28 md:p-6 md:pb-8 lg:p-8" data-content-mode={contentMode}>{children}</main>
        </SidebarInset>
        <div className="mobile-ledger-nav fixed inset-x-0 bottom-0 z-30 border-t px-2 pb-[max(.5rem,env(safe-area-inset-bottom))] pt-2 md:hidden">
          <Navigation label="Mobile admin sections" section={section} onSection={onSection} pendingCount={pendingCount} mobile safeArea />
        </div>
    </SidebarProvider>
  );
}

function Navigation({ label, section, onSection, pendingCount, mobile = false, safeArea = false }: {
  label: string;
  section: AdminSection;
  onSection(value: AdminSection): void;
  pendingCount: number;
  mobile?: boolean;
  safeArea?: boolean;
}) {
  if (mobile) {
    return <nav aria-label={label} data-safe-area={safeArea ? "bottom" : undefined} className="grid grid-cols-4 gap-1">{sections.map(item => {
      const Icon = item.icon;
      return <Button key={item.id} type="button" variant={section === item.id ? "secondary" : "ghost"} className="relative h-14 flex-col gap-1 px-1 text-[11px]" aria-current={section === item.id ? "page" : undefined} onClick={() => onSection(item.id)}>
        <Icon />
        <span>{item.label}</span>
        {item.id === "requests" && pendingCount > 0 && <span className="absolute right-2 top-1.5 grid size-4 place-items-center rounded-full bg-destructive text-[9px] font-bold text-white">{pendingCount}</span>}
      </Button>;
    })}</nav>;
  }
  return <nav aria-label={label}><SidebarMenu>{sections.map(item => {
    const Icon = item.icon;
    return <SidebarMenuItem key={item.id}>
      <SidebarMenuButton type="button" tooltip={item.label} isActive={section === item.id} onClick={() => onSection(item.id)}>
        <Icon />
        <span>{item.label}</span>
      </SidebarMenuButton>
      {item.id === "requests" && pendingCount > 0 && <SidebarMenuBadge>{pendingCount}</SidebarMenuBadge>}
    </SidebarMenuItem>;
  })}</SidebarMenu></nav>;
}
