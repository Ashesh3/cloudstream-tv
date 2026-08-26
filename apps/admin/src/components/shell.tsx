import type { ReactNode } from "react";

export type AdminSection = "requests" | "devices" | "sources" | "settings";
const sections: Array<{ id: AdminSection; label: string; icon: string }> = [
  { id: "requests", label: "Requests", icon: "＋" },
  { id: "devices", label: "Devices", icon: "▣" },
  { id: "sources", label: "Sources", icon: "◈" },
  { id: "settings", label: "Settings", icon: "⚙" }
];

export function Shell({ section, onSection, pendingCount, children }: {
  section: AdminSection;
  onSection(value: AdminSection): void;
  pendingCount: number;
  children: ReactNode;
}) {
  return <div className="admin-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark small" aria-hidden="true"><span /><span /><span /></div><div><strong>Cloudframe</strong><small>Household admin</small></div></div>
      <Navigation label="Admin sections" section={section} onSection={onSection} pendingCount={pendingCount} />
      <p className="sidebar-foot">Private household library</p>
    </aside>
    <main className="admin-content">{children}</main>
    <div className="bottom-nav"><Navigation label="Mobile admin sections" section={section} onSection={onSection} pendingCount={pendingCount} /></div>
  </div>;
}

function Navigation({ label, section, onSection, pendingCount }: { label: string; section: AdminSection; onSection(value: AdminSection): void; pendingCount: number }) {
  return <nav aria-label={label}>{sections.map(item => <button key={item.id} className={section === item.id ? "active" : ""} aria-current={section === item.id ? "page" : undefined} onClick={() => onSection(item.id)}><span aria-hidden="true">{item.icon}</span><span>{item.label}</span>{item.id === "requests" && pendingCount > 0 && <b>{pendingCount}</b>}</button>)}</nav>;
}
