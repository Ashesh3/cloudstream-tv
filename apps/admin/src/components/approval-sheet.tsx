import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ApproveDeviceRequestBody, ControlRequestDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { AdminApiError } from "../api/client";
import { providerName } from "../lib/provider-name";

export function ApprovalSheet({ request, roots, sources, onApprove, onClose }: {
  request: ControlRequestDto;
  roots: ControlRootDto[];
  sources: ControlSourceDto[];
  onApprove(body: ApproveDeviceRequestBody): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState(request.requestedName);
  const [selected, setSelected] = useState<string[]>([]);
  const [nameError, setNameError] = useState("");
  const [rootError, setRootError] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const [isOpen, setIsOpen] = useState(true);
  const submitting = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const enabledRoots = roots.filter(root => root.enabled);

  useEffect(() => {
    if (isOpen) return;
    const timer = window.setTimeout(() => {
      onClose();
      window.setTimeout(() => {
        if (returnFocus.current?.isConnected) returnFocus.current.focus();
        else document.getElementById("astryx-app-shell-main")?.focus();
      }, 0);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isOpen, onClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    const nextNameError = name.trim() ? "" : "Enter a device name.";
    const nextRootError = selected.length ? "" : "Select at least one folder.";
    setNameError(nextNameError);
    setRootError(nextRootError);
    if (nextNameError || nextRootError) return;
    submitting.current = true;
    setPending(true);
    setFailure("");
    try {
      await onApprove({ name: name.trim(), rootIds: selected });
      setIsOpen(false);
    } catch (error) {
      setFailure(error instanceof AdminApiError ? error.message : "Approval failed. Try again.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  const close = () => {
    if (pending) return;
    setIsOpen(false);
  };

  return <Dialog isOpen={isOpen} onOpenChange={open => { if (!open) close(); }} width="42rem" maxHeight="92dvh" purpose="form" aria-label="Approve device">
    <form onSubmit={submit}>
      <Layout
        height="fill"
        defaultHasDividers
        header={<DialogHeader title="Approve device" subtitle="Confirm the device name and choose the folders this television can browse." onOpenChange={open => { if (!open) close(); }} />}
        content={<LayoutContent padding={4} isScrollable>
          <VStack gap={5}>
            <Text type="supporting" as="p">Requested {formatTime(request.createdAt)} · Expires {formatTime(request.expiresAt)}</Text>
            <FormLayout>
              <TextInput
                label="Device name"
                description="Use a name your household will recognize later."
                value={name}
                onChange={setName}
                hasAutoFocus
                isDisabled={pending}
                status={nameError ? { type: "error", message: nameError } : undefined}
                width="100%"
              />
              {enabledRoots.length ? <CheckboxList
                label="Folder access"
                description={`${enabledRoots.length} available ${enabledRoots.length === 1 ? "folder" : "folders"}. Select only what this television should see.`}
                value={selected}
                onChange={setSelected}
                isDisabled={pending}
                hasDividers
                status={rootError ? { type: "error", message: rootError } : undefined}
              >
                {enabledRoots.map(root => {
                  const source = sources.find(item => item.id === root.sourceId);
                  return <CheckboxListItem
                    key={root.id}
                    value={root.id}
                    label={root.displayName}
                    description={source ? `${providerName(source.provider)} · ${source.accountLabel}` : "Source unavailable"}
                    endContent={<Text type="supporting">Access begins immediately after approval.</Text>}
                  />;
                })}
              </CheckboxList> : <Banner status="warning" title="No enabled folders" description="Connect a source and add an enabled folder before approving a device." container="section" />}
              {failure && <Banner status="error" title="Approval failed" description={failure} container="section" />}
            </FormLayout>
          </VStack>
        </LayoutContent>}
        footer={<LayoutFooter padding={4}><HStack gap={2} justify="end" wrap="wrap"><Button type="button" label="Cancel" variant="secondary" isDisabled={pending} onClick={close} /><Button type="submit" label={pending ? "Approving…" : "Approve device"} variant="primary" isDisabled={pending || !enabledRoots.length} isLoading={pending} /></HStack></LayoutFooter>}
      />
    </form>
  </Dialog>;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "soon" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
