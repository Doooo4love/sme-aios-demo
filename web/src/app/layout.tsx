import type { Metadata } from "next";
import { SessionProvider } from "@/lib/session-context";
import { WorkbenchProvider } from "@/lib/workbench-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "SME AIOS · 企业运营工作台",
  description: "基于同源企业身份、最小权限边界与可核验回执的企业 AI 运营工作台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <SessionProvider>
          <WorkbenchProvider>{children}</WorkbenchProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
