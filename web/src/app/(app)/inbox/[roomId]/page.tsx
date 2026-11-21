import { ChatRoomWorkspace } from "@/features/chat/ChatRoomWorkspace";
import { InboxShell } from "@/features/inbox/InboxShell";

type RoomPageProps = {
  params: Promise<{ roomId: string }>;
};

export default async function InboxRoomPage({ params }: RoomPageProps) {
  const { roomId } = await params;
  const decodedRoomId = decodeURIComponent(roomId);

  return (
    <InboxShell mode="thread" activeThread={decodedRoomId}>
      <ChatRoomWorkspace roomId={decodedRoomId} />
    </InboxShell>
  );
}
