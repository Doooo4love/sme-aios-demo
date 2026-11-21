import { ProposalInspectorPanel } from "@/features/proposals/ProposalInspectorPanel";

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProposalInspectorPanel proposalId={decodeURIComponent(id)} mode="page" />;
}
