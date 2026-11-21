import { AssistantWorkspace } from "@/features/inbox/AssistantWorkspace";
import { InboxShell } from "@/features/inbox/InboxShell";

export default function InboxPage() {
  return (
    <InboxShell mode="list" activeThread="assistant">
      <AssistantWorkspace />
    </InboxShell>
  );
}
