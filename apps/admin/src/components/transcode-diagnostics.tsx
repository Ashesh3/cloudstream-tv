import type { TranscodeDiagnosticResponse } from "@cloudframe/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Section } from "@astryxdesign/core/Section";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ActivityIcon } from "lucide-react";

export function TranscodeDiagnostics({ diagnostic, error = "" }: { diagnostic: TranscodeDiagnosticResponse | null; error?: string }) {
  return <Section role="region" aria-label="Transcoder status" dividers={["bottom"]}>
    <VStack gap={4}>
      <VStack gap={1}>
        <HStack gap={2} align="center"><Icon icon={ActivityIcon} color="accent" /><Heading level={2}>Transcoder status</Heading></HStack>
        <Text type="supporting">Live, secret-safe playback and cache health from this server.</Text>
      </VStack>
      {error ? <Banner status="warning" title="Transcoder status unavailable" description={error} container="section" /> : diagnostic ? <DiagnosticBody diagnostic={diagnostic} /> : <VStack gap={2} role="status" aria-label="Loading transcoder status"><Skeleton width="40%" height="var(--spacing-5)" radius={1} /><Skeleton height="var(--spacing-4)" radius={1} /></VStack>}
    </VStack>
  </Section>;
}

function DiagnosticBody({ diagnostic }: { diagnostic: TranscodeDiagnosticResponse }) {
  const active = diagnostic.active;
  return <VStack gap={4}>
    <HStack gap={2} align="center" wrap="wrap"><StatusDot variant={active ? "accent" : "success"} label={active ? "Transcoding" : "Ready"} isPulsing={active ? true : undefined} /><Text weight="semibold" wordBreak="break-word">{active ? active.itemName : "Transcoder ready"}</Text><Text type="supporting">{active ? activeDescription(diagnostic) : "No active playback."}</Text></HStack>
    {active?.stage === "encoding" && active.progressPercent !== null ? <ProgressBar value={active.progressPercent} label="Encoding progress" hasValueLabel /> : null}
    <MetadataList columns="multi" label={{ position: "top" }}>
      <MetadataListItem label="Queued windows">{diagnostic.queuedDemandedWindows}</MetadataListItem>
      <MetadataListItem label="Busy rejections">{diagnostic.busyRejections}</MetadataListItem>
      <MetadataListItem label="Cache"><VStack gap={1}><Text>{formatCache(diagnostic.cacheBytes, diagnostic.cacheMaxBytes)}</Text>{diagnostic.cacheMaxBytes > 0 && <ProgressBar value={Math.min(diagnostic.cacheBytes, diagnostic.cacheMaxBytes)} max={diagnostic.cacheMaxBytes} label="Transcode cache use" isLabelHidden data-testid="transcode-cache-progress" />}</VStack></MetadataListItem>
      <MetadataListItem label="Last error">{errorLabel(diagnostic.lastErrorCode)}</MetadataListItem>
    </MetadataList>
    {diagnostic.busyRejections > 0 && <Banner status="warning" title="Transcoder was busy" description={`${diagnostic.busyRejections} busy ${diagnostic.busyRejections === 1 ? "request was" : "requests were"} rejected. Another television currently owns the transcoder.`} container="section" />}
  </VStack>;
}

function activeDescription(value: TranscodeDiagnosticResponse): string {
  const active = value.active;
  if (!active) return "No active playback.";
  const provider = active.provider === "google" ? "Google Drive" : "OneDrive";
  const device = value.leaseDeviceName ?? "Approved television";
  if (active.stage === "probing") return `Probing from ${provider} for ${device}.`;
  const progress = active.progressPercent === null ? "Progress pending" : `${active.progressPercent}%`;
  const speed = active.speed ? ` at ${active.speed}` : "";
  return `${provider} · ${device} · Encoding window ${(active.windowIndex ?? 0) + 1} · ${progress}${speed}`;
}
function formatCache(used: number, maximum: number): string { return `${binary(used)} of ${binary(maximum)}`; }
function binary(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount >= 10 || Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}
function errorLabel(code: string | null): string {
  if (!code) return "None";
  const labels: Record<string, string> = {
    TRANSCODER_BUSY: "Another television currently owns the transcoder",
    TRANSCODER_CACHE_FULL: "The transcode cache cannot safely grow",
    TRANSCODER_SOURCE_UNAVAILABLE: "The source could not be read",
    TRANSCODER_WINDOW_TIMEOUT: "A transcode window timed out",
    TRANSCODER_SESSION_EXPIRED: "A playback session expired",
    TRANSCODER_UNSUPPORTED: "The media format is unsupported",
    TRANSCODER_FAILED: "The last transcode failed",
  };
  return labels[code] ?? "The last transcode failed";
}
