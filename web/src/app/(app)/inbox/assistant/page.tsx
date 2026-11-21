import { AssistantWorkspace } from "@/features/inbox/AssistantWorkspace";
import { InboxShell } from "@/features/inbox/InboxShell";

export default function InboxAssistantPage() {
  return (
    <InboxShell mode="thread" activeThread="assistant">
      <AssistantWorkspace />
    </InboxShell>
  );
}
