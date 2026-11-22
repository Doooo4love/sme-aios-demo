import { AppShell } from "@/components/shell/AppShell";
import { ProactiveAgentNotifier } from "@/components/shell/ProactiveAgentNotifier";

export default function AuthenticatedAppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <ProactiveAgentNotifier />
      <AppShell>{children}</AppShell>
    </>
  );
}
