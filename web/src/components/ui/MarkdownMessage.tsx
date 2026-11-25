"use client";

import React, { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export type MarkdownMessageTone = "received" | "sent" | "surface";

export interface MarkdownMessageProps {
  content?: string;
  children?: string;
  tone?: MarkdownMessageTone;
  className?: string;
}

/**
 * Allows ONLY safe web/app link targets (`http://`, `https://`, `mailto:`, `#`, single `/`).
 * Strips `javascript:`, `data:`, `vbscript:`, protocol-relative `//`, and control-obfuscated schemes.
 */
export function safeUrlTransform(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";

  const normalized = trimmed.replace(
    /[\u0000-\u0020\u007F-\u009F\u200B-\u200D\uFEFF]/g,
    "",
  );
  const lowerNormalized = normalized.toLowerCase();

  if (
    lowerNormalized.startsWith("javascript:") ||
    lowerNormalized.startsWith("data:") ||
    lowerNormalized.startsWith("vbscript:")
  ) {
    return "";
  }

  const lowerTrimmed = trimmed.toLowerCase();
  if (
    lowerTrimmed.startsWith("http://") ||
    lowerTrimmed.startsWith("https://") ||
    lowerTrimmed.startsWith("mailto:")
  ) {
    return trimmed;
  }

  if (trimmed.startsWith("#")) {
    return trimmed;
  }

  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  return "";
}

interface TonePalette {
  rootText: string;
  link: string;
  inlineCode: string;
  preBlock: string;
  blockquote: string;
  tableWrap: string;
  tableHead: string;
  tableCellBorder: string;
  hr: string;
}

const TONE_PALETTES: Record<MarkdownMessageTone, TonePalette> = {
  sent: {
    rootText: "text-[var(--bubble-sent-ink)]",
    link: "text-[var(--bubble-sent-ink)] underline decoration-[var(--bubble-sent-ink)]/65 underline-offset-2 hover:decoration-[var(--bubble-sent-ink)]",
    inlineCode:
      "border-[var(--bubble-sent-ink)]/20 bg-[var(--bubble-sent-ink)]/12 text-[var(--bubble-sent-ink)]",
    preBlock:
      "border-[var(--bubble-sent-ink)]/20 bg-[var(--bubble-sent-ink)]/10 text-[var(--bubble-sent-ink)]",
    blockquote:
      "border-[var(--bubble-sent-ink)]/35 bg-[var(--bubble-sent-ink)]/10 text-[var(--bubble-sent-ink)]/90",
    tableWrap:
      "border-[var(--bubble-sent-ink)]/20 bg-[var(--bubble-sent-ink)]/8",
    tableHead:
      "bg-[var(--bubble-sent-ink)]/10 text-[var(--bubble-sent-ink)]",
    tableCellBorder: "border-[var(--bubble-sent-ink)]/15",
    hr: "border-[var(--bubble-sent-ink)]/20",
  },
  received: {
    rootText: "text-[var(--bubble-received-ink)]",
    link: "text-[var(--accent-ink)] underline decoration-[var(--accent-border)] underline-offset-2 hover:decoration-[var(--accent)]",
    inlineCode:
      "border-[var(--hairline)] bg-[var(--bg-surface)]/90 text-[var(--ink-primary)]",
    preBlock:
      "border-[var(--hairline)] bg-[var(--bg-surface)] text-[var(--ink-primary)]",
    blockquote:
      "border-[var(--accent-border)] bg-[var(--bg-surface)]/70 text-[var(--ink-secondary)]",
    tableWrap: "border-[var(--hairline)] bg-[var(--bg-surface)]",
    tableHead: "bg-[var(--bg-surface-tint)] text-[var(--ink-secondary)]",
    tableCellBorder: "border-[var(--hairline)]",
    hr: "border-[var(--hairline)]",
  },
  surface: {
    rootText: "text-[var(--ink-primary)]",
    link: "text-[var(--accent-ink)] underline decoration-[var(--accent-border)] underline-offset-2 hover:decoration-[var(--accent)]",
    inlineCode:
      "border-[var(--hairline)] bg-[var(--bg-surface-subtle)] text-[var(--ink-primary)]",
    preBlock:
      "border-[var(--hairline)] bg-[var(--bg-surface-tint)] text-[var(--ink-primary)]",
    blockquote:
      "border-[var(--accent-border)] bg-[var(--bg-surface-tint)] text-[var(--ink-secondary)]",
    tableWrap: "border-[var(--hairline)] bg-[var(--bg-surface)]",
    tableHead: "bg-[var(--bg-surface-tint)] text-[var(--ink-secondary)]",
    tableCellBorder: "border-[var(--hairline)]",
    hr: "border-[var(--hairline)]",
  },
};

export function MarkdownMessage({
  content,
  children,
  tone = "surface",
  className = "",
}: MarkdownMessageProps) {
  const source = content ?? children ?? "";
  const palette = TONE_PALETTES[tone];

  const components = useMemo<Components>(
    () => ({
      h1: ({ children: nodeChildren }) => (
        <h1 className="mt-3 mb-1.5 text-[16.5px] font-semibold tracking-[-0.015em] leading-snug">
          {nodeChildren}
        </h1>
      ),
      h2: ({ children: nodeChildren }) => (
        <h2 className="mt-2.5 mb-1 text-[15.5px] font-semibold tracking-[-0.015em] leading-snug">
          {nodeChildren}
        </h2>
      ),
      h3: ({ children: nodeChildren }) => (
        <h3 className="mt-2 mb-1 text-[14.5px] font-semibold leading-snug">
          {nodeChildren}
        </h3>
      ),
      h4: ({ children: nodeChildren }) => (
        <h4 className="mt-2 mb-1 text-[14px] font-semibold leading-snug">
          {nodeChildren}
        </h4>
      ),
      p: ({ children: nodeChildren }) => (
        <p className="my-1.5 leading-[1.52] break-words">{nodeChildren}</p>
      ),
      strong: ({ children: nodeChildren }) => (
        <strong className="font-semibold">{nodeChildren}</strong>
      ),
      em: ({ children: nodeChildren }) => (
        <em className="italic">{nodeChildren}</em>
      ),
      del: ({ children: nodeChildren }) => (
        <del className="line-through opacity-75">{nodeChildren}</del>
      ),
      ul: ({ children: nodeChildren }) => (
        <ul className="my-1.5 list-disc pl-5 space-y-1">{nodeChildren}</ul>
      ),
      ol: ({ children: nodeChildren }) => (
        <ol className="my-1.5 list-decimal pl-5 space-y-1">{nodeChildren}</ol>
      ),
      li: ({ children: nodeChildren }) => (
        <li className="leading-[1.52] [&>p]:my-0.5 [&>ul]:my-1 [&>ol]:my-1">
          {nodeChildren}
        </li>
      ),
      blockquote: ({ children: nodeChildren }) => (
        <blockquote
          className={[
            "my-2 border-l-2 py-1 pr-2.5 pl-3 rounded-r-xs text-[13.5px] [&>p]:my-0.5",
            palette.blockquote,
          ].join(" ")}
        >
          {nodeChildren}
        </blockquote>
      ),
      hr: () => (
        <hr className={["my-2.5 border-0 border-t", palette.hr].join(" ")} />
      ),
      a: ({ href, children: nodeChildren }) => {
        const safeHref = typeof href === "string" ? safeUrlTransform(href) : "";
        if (!safeHref) {
          return <span className="opacity-85">{nodeChildren}</span>;
        }
        return (
          <a
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className={[
              "break-words [overflow-wrap:anywhere] transition-colors",
              palette.link,
            ].join(" ")}
          >
            {nodeChildren}
          </a>
        );
      },
      code: ({ children: nodeChildren, className: codeClassName }) => (
        <code
          className={[
            "rounded-xs border px-1.5 py-[1px] font-mono-code text-[0.875em] break-words",
            palette.inlineCode,
            codeClassName ?? "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {nodeChildren}
        </code>
      ),
      pre: ({ children: nodeChildren }) => (
        <pre
          className={[
            "my-2 max-w-full overflow-x-auto rounded-tile border px-3 py-2.5 font-mono-code text-[12.5px] leading-[1.55] [&_code]:rounded-none [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit [&_code]:text-[1em] [&_code]:whitespace-pre [&_code]:break-normal [&_code]:[overflow-wrap:normal]",
            palette.preBlock,
          ].join(" ")}
        >
          {nodeChildren}
        </pre>
      ),
      table: ({ children: nodeChildren }) => (
        <div
          className={[
            "my-2 max-w-full overflow-x-auto rounded-tile border",
            palette.tableWrap,
          ].join(" ")}
        >
          <table className="w-full border-collapse text-left text-[12.5px] tabular-nums">
            {nodeChildren}
          </table>
        </div>
      ),
      thead: ({ children: nodeChildren }) => (
        <thead
          className={[
            palette.tableHead,
            "border-b",
            palette.tableCellBorder,
          ].join(" ")}
        >
          {nodeChildren}
        </thead>
      ),
      tbody: ({ children: nodeChildren }) => (
        <tbody className="[&>tr:first-child]:border-t-0">{nodeChildren}</tbody>
      ),
      tr: ({ children: nodeChildren }) => (
        <tr
          className={[
            "border-t [thead_&]:border-t-0",
            palette.tableCellBorder,
          ].join(" ")}
        >
          {nodeChildren}
        </tr>
      ),
      th: ({ children: nodeChildren, style }) => (
        <th
          style={style}
          className={[
            "px-2.5 py-1.5 text-[11px] font-semibold tracking-[0.02em] whitespace-nowrap border-r last:border-r-0",
            palette.tableCellBorder,
          ].join(" ")}
        >
          {nodeChildren}
        </th>
      ),
      td: ({ children: nodeChildren, style }) => (
        <td
          style={style}
          className={[
            "px-2.5 py-1.5 align-top border-r last:border-r-0",
            palette.tableCellBorder,
          ].join(" ")}
        >
          {nodeChildren}
        </td>
      ),
      input: ({ type, checked }) => {
        if (type !== "checkbox") return null;
        return (
          <input
            type="checkbox"
            checked={Boolean(checked)}
            readOnly
            aria-hidden="true"
            className="mr-1.5 align-middle accent-[var(--accent-solid)] pointer-events-none"
          />
        );
      },
      img: ({ src, alt }) => {
        const safeSrc = typeof src === "string" ? safeUrlTransform(src) : "";
        if (!safeSrc) return null;
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={safeSrc}
            alt={typeof alt === "string" ? alt : ""}
            loading="lazy"
            className="my-1.5 max-w-full rounded-tile border border-[var(--hairline)]"
          />
        );
      },
    }),
    [palette],
  );

  return (
    <div
      className={[
        "min-w-0 max-w-full text-[14.5px] leading-[1.52] break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        palette.rootText,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrlTransform}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
