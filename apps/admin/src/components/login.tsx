import { type FormEvent, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { AdminApiError } from "../api/client";

export function Login({ onLogin }: { onLogin(passphrase: string): Promise<void> }) {
  const [passphrase, setPassphrase] = useState("");
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!passphrase || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      await onLogin(passphrase);
      setPassphrase("");
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Sign in failed.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return <Center minHeight="100dvh" padding={4}>
    <Card maxWidth="30rem" width="100%" padding={8} elevation="low">
      <VStack gap={6}>
        <VStack gap={2}>
          <HStack gap={2} align="center">
            <Icon icon="wrench" color="accent" />
            <Text type="label">Cloudframe household</Text>
          </HStack>
          <Heading level={1}>Household admin</Heading>
          <Text type="supporting" as="p">Approve televisions, assign cloud folders, and keep household access clear.</Text>
        </VStack>
        <form onSubmit={submit}>
          <FormLayout>
            <TextInput
              label="Admin passphrase"
              description="Your passphrase is used only for this sign-in and is never stored in this browser."
              type={visible ? "text" : "password"}
              value={passphrase}
              onChange={setPassphrase}
              hasAutoFocus
              isDisabled={pending}
              {...{ autoComplete: "current-password" }}
              status={error ? { type: "error", message: error } : undefined}
              width="100%"
            />
            <HStack gap={2} wrap="wrap" justify="between" align="center">
              <Button
                type="button"
                label={visible ? "Hide passphrase" : "Show passphrase"}
                variant="ghost"
                icon={<Icon icon="eyeSlash" />}
                isDisabled={pending}
                onClick={() => setVisible(value => !value)}
              />
              <Button
                type="submit"
                label={pending ? "Signing in…" : "Sign in"}
                variant="primary"
                isDisabled={pending || !passphrase}
                isLoading={pending}
              />
            </HStack>
          </FormLayout>
        </form>
        <Text type="supporting" as="p">Server-managed access for this household only.</Text>
      </VStack>
    </Card>
  </Center>;
}
