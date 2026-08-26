import { SourceWorkbench, type SourceWorkbenchProps } from "./source-workbench";

export type FolderPickerProps = SourceWorkbenchProps;

export function FolderPicker(props: FolderPickerProps) {
  return <SourceWorkbench {...props} />;
}
