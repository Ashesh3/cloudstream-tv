import { type FormEvent, useRef, useState } from "react";
import type { ClaimInstallationBody } from "@cloudframe/shared";
import { Banner } from "@astryxdesign/core/Banner";
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

const SETUP_CODE = /^[A-Za-z0-9_-]{22}$/u;

export function FirstRun({ onClaim }: { onClaim(input: ClaimInstallationBody): Promise<void> }) {
  const [setupCode, setSetupCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    setError("");
    if (!SETUP_CODE.test(setupCode)) {
      setError("Enter the one-time setup code from the server log.");
      return;
    }
    if (passphrase.length < 16 || passphrase.length > 1024) {
      setError("Use an admin passphrase between 16 and 1024 characters.");
      return;
    }
    if (passphrase !== confirmation) {
      setError("The passphrases do not match.");
      return;
    }
    submitting.current = true;
    setPending(true);
    try {
      await onClaim({ setupCode, passphrase });
      setSetupCode("");
      setPassphrase("");
      setConfirmation("");
    } catch (cause) {
      setError(cause instanceof AdminApiError
        ? cause.message
        : "Cloudframe could not claim this installation. Try again.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return <Center minHeight="100dvh" padding={4}>
    <Card maxWidth="40rem" width="100%" padding={8} elevation="low">
      <VStack gap={6}>
        <VStack gap={2}>
          <HStack gap={2} align="center">
            <Icon icon="wrench" color="accent" />
            <Text type="label">Fresh household installation</Text>
          </HStack>
          <Heading level={1}>Claim this server</Heading>
          <Text as="p">This empty /data volume is the installation boundary. No cloud configuration was imported.</Text>
        </VStack>
        <Banner
          status="info"
          title="Back up the complete stopped data volume"
          description="A complete stopped /data volume is the durable backup unit. The mounted directory must remain writable by container UID and GID 10001."
          container="section"
        />
        <form onSubmit={submit}>
          <FormLayout defaultOptionality="required">
            <TextInput
              label="Setup code"
              description="Use the one-time code from the server log."
              value={setupCode}
              onChange={setSetupCode}
              hasAutoFocus
              isDisabled={pending}
              {...{ autoComplete: "one-time-code" }}
              width="100%"
            />
            <TextInput
              label="New admin passphrase"
              description="Use 16 to 1024 characters. This becomes the permanent household-admin credential."
              type="password"
              value={passphrase}
              onChange={setPassphrase}
              isDisabled={pending}
              {...{ autoComplete: "new-password" }}
              width="100%"
            />
            <TextInput
              label="Confirm admin passphrase"
              type="password"
              value={confirmation}
              onChange={setConfirmation}
              isDisabled={pending}
              {...{ autoComplete: "new-password" }}
              width="100%"
            />
            {error && <Banner status="error" title="Installation could not be claimed" description={error} container="section" />}
            <Button
              type="submit"
              label={pending ? "Claiming installation…" : "Claim installation"}
              variant="primary"
              isDisabled={pending || !setupCode || !passphrase || !confirmation}
              isLoading={pending}
              width="100%"
            />
          </FormLayout>
        </form>
        <Text type="supporting" as="p">This one-time ownership claim creates the household administrator.</Text>
      </VStack>
    </Card>
  </Center>;
}
