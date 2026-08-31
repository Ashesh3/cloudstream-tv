export interface TvBreadcrumb { id: string; name: string; }

export function TvHeader({ title, breadcrumbs, onHome, onSources }: { title: string; breadcrumbs?: TvBreadcrumb[]; onHome: () => void; onSources: () => void; }) {
  const path = [...(breadcrumbs?.map(crumb => crumb.name) ?? []), ...(title !== "Home" ? [title] : [])];
  return <HStack as="header" className="tv-header cloudframe-tv-header" gap={6} align="center" justify="between"><button className="brand" type="button" onClick={onHome} aria-label="Cloudframe home" tabIndex={-1}>Cloudframe</button><VStack as="section" className="tv-location" gap={0.5} align="center"><strong>Household collections</strong><small>{path.length ? path.join(" / ") : "Home"}</small></VStack><button className="sources-action" type="button" onClick={onSources} tabIndex={-1} aria-label="Manage sources">Choose collection · Menu</button></HStack>;
}
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
