import { type FormEvent, useEffect, useState } from "react";
import type { AdminSnapshotResponse, ControlHouseholdDto, MediaOrder, UpdateAdminSettingsBody } from "@cloudframe/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Section } from "@astryxdesign/core/Section";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { CloudIcon, FolderOpenIcon, LogOutIcon, MonitorIcon, ShieldCheckIcon, TimerIcon } from "lucide-react";
import type { AdminApi } from "../api/client";
import { PageHeader } from "./requests";
import { TranscodeDiagnostics } from "./transcode-diagnostics";

export function Settings({ api, household, snapshot, onUnauthorized, onSave, onRotate, onLogout }: {
  api: AdminApi;
  household: ControlHouseholdDto;
  snapshot: AdminSnapshotResponse;
  onUnauthorized(): void;
  onSave(value: UpdateAdminSettingsBody): Promise<void>;
  onRotate(current: string, next: string): Promise<void>;
  onLogout(): Promise<void>;
}) {
  const [allowed, setAllowed] = useState(household.allowNewDeviceRequests);
  const [order, setOrder] = useState<MediaOrder>(household.defaultMediaOrder);
  const [seconds, setSeconds] = useState(household.defaultSlideshowSeconds.toString());
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [secondsError, setSecondsError] = useState("");
  const [diagnostic, setDiagnostic] = useState<Awaited<ReturnType<AdminApi["transcodeStatus"]>> | null>(null);
  const [diagnosticError, setDiagnosticError] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  useEffect(() => { setAllowed(household.allowNewDeviceRequests); setOrder(household.defaultMediaOrder); setSeconds(household.defaultSlideshowSeconds.toString()); setSecondsError(""); }, [household]);
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    const poll = () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      void api.transcodeStatus(requestController.signal).then(value => {
        if (!disposed && !requestController.signal.aborted) { setDiagnostic(value); setDiagnosticError(""); }
      }).catch(cause => {
        if (disposed || requestController.signal.aborted) return;
        if (isStatus(cause, 401)) { onUnauthorized(); return; }
        setDiagnosticError("Transcoder status is temporarily unavailable.");
      });
    };
    poll();
    const timer = window.setInterval(poll, 5_000);
    return () => { disposed = true; controller?.abort(); window.clearInterval(timer); };
  }, [api, onUnauthorized]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const slideshowSeconds = Number(seconds);
    if (!validSeconds(slideshowSeconds)) { setSecondsError("Slideshow seconds must be a whole number from 1 to 3600."); return; }
    setPending("defaults"); setError(""); setSecondsError("");
    try { await onSave({ allowNewDeviceRequests: allowed, defaultMediaOrder: order, defaultSlideshowSeconds: slideshowSeconds }); }
    catch (cause) { setError(safeFailure(cause, "Settings could not be saved.")); }
    finally { setPending(""); }
  };
  const rotate = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (current.length < 16 || next.length < 16) { setError("Both passphrases must be at least 16 characters."); return; }
    setPending("passphrase"); setError("");
    try { await onRotate(current, next); setCurrent(""); setNext(""); }
    catch (cause) { setError(safeFailure(cause, "Passphrase could not be changed.")); }
    finally { setPending(""); }
  };
  const counts = {
    devices: snapshot.devices.filter(device => device.revokedAt === null).length,
    sources: snapshot.sources.filter(source => source.status === "healthy").length,
    roots: snapshot.roots.filter(root => root.enabled).length,
    requests: snapshot.pendingRequests.length,
  };
  const mutationPending = pending !== "";
  const defaultsPending = pending === "defaults";
  const passphrasePending = pending === "passphrase";
  const logout = async () => {
    if (logoutPending || mutationPending) return;
    setLogoutPending(true); setError("");
    try { await onLogout(); }
    catch (cause) { setError(safeFailure(cause, "Sign out could not be completed.")); }
    finally { setLogoutPending(false); }
  };
  return <VStack as="section" gap={0}>
    <Section dividers={["bottom"]}><PageHeader context="Household" title="Settings" description="Set enrollment and playback defaults, review current service truth, and protect admin access." /></Section>
    {error && <Banner status="error" title="Settings action failed" description={error} container="section" />}
    <Section dividers={["bottom"]}>
      <form onSubmit={save}>
        <VStack gap={4}>
          <VStack gap={1}><Heading level={2}>Household defaults</Heading><Text type="supporting">Enrollment and playback choices inherited by televisions.</Text></VStack>
          <FormLayout direction="horizontal-labels">
            <CheckboxInput label="Allow new device requests" description="Unapproved televisions can request access for 30 minutes." value={allowed} onChange={setAllowed} isDisabled={mutationPending || logoutPending} width="100%" />
            <RadioList label="Default ordering" value={order} onChange={value => setOrder(value as MediaOrder)} orientation="horizontal" isDisabled={mutationPending || logoutPending}><RadioListItem value="captured-desc" label="Newest captured first" /><RadioListItem value="captured-asc" label="Oldest captured first" /><RadioListItem value="name-asc" label="Name A–Z" /></RadioList>
            <TextInput label="Default slideshow seconds" description="Enter a whole number from 1 to 3600." value={seconds} onChange={value => { setSeconds(value); setSecondsError(""); }} isDisabled={mutationPending || logoutPending} status={secondsError ? { type: "error", message: secondsError } : undefined} statusVariant="detached" />
          </FormLayout>
          <Button label={defaultsPending ? "Saving…" : "Save defaults"} type="submit" variant="primary" isLoading={defaultsPending} isDisabled={mutationPending || logoutPending} />
        </VStack>
      </form>
    </Section>
    <Section dividers={["bottom"]}>
      <VStack gap={4}>
        <VStack gap={1}><HStack gap={2} align="center"><Icon icon={ShieldCheckIcon} color="accent" /><Heading level={2}>Current household status</Heading></HStack><Text type="supporting">Browser-safe access truth from the active service.</Text></VStack>
        <MetadataList columns="multi" label={{ position: "top" }}>
          <MetadataListItem label="Approved devices" icon={<Icon icon={MonitorIcon} />}>{counts.devices}</MetadataListItem>
          <MetadataListItem label="Connected sources" icon={<Icon icon={CloudIcon} />}>{counts.sources}</MetadataListItem>
          <MetadataListItem label="Approved roots" icon={<Icon icon={FolderOpenIcon} />}>{counts.roots}</MetadataListItem>
          <MetadataListItem label="Pending requests" icon={<Icon icon={TimerIcon} />}>{counts.requests}</MetadataListItem>
        </MetadataList>
        <Banner status="info" title="Local encrypted storage" description={`Control state is encrypted and persisted on this server at revision ${snapshot.storage.revision}.`} container="section" data-storage-mode={snapshot.storage.mode} />
      </VStack>
    </Section>
    <TranscodeDiagnostics diagnostic={diagnostic} error={diagnosticError} />
    <Section dividers={["bottom"]}>
      <form onSubmit={rotate}>
        <VStack gap={4}>
          <VStack gap={1}><HStack gap={2} align="center"><Icon icon={ShieldCheckIcon} color="error" /><Heading level={2}>Change passphrase</Heading></HStack><Text type="supporting">Changing it signs out every admin session, including this one.</Text></VStack>
          <FormLayout direction="horizontal-labels">
            <TextInput label="Current passphrase" type="password" value={current} onChange={setCurrent} isDisabled={mutationPending || logoutPending} />
            <TextInput label="New passphrase" type="password" value={next} onChange={setNext} isDisabled={mutationPending || logoutPending} />
          </FormLayout>
          <Button label={passphrasePending ? "Changing…" : "Change passphrase"} type="submit" variant="destructive" isLoading={passphrasePending} isDisabled={mutationPending || logoutPending} />
        </VStack>
      </form>
    </Section>
    <Section>
      <VStack gap={3}><VStack gap={1}><Heading level={2}>Admin session</Heading><Text type="supporting">Sign out of this browser without affecting approved televisions.</Text></VStack><Button label="Sign out" variant="secondary" icon={<Icon icon={LogOutIcon} />} isLoading={logoutPending} isDisabled={logoutPending || mutationPending} onClick={() => void logout()} /></VStack>
    </Section>
  </VStack>;
}

function validSeconds(value: number): value is number { return Number.isFinite(value) && Number.isInteger(value) && value >= 1 && value <= 3600; }
function isStatus(value: unknown, status: number) { return Boolean(value && typeof value === "object" && "status" in value && (value as { status: unknown }).status === status); }
function safeFailure(cause: unknown, fallback: string) { return cause instanceof Error && cause.name === "AdminApiError" ? cause.message : fallback; }
