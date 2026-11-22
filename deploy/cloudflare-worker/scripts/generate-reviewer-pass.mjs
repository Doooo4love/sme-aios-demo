#!/usr/bin/env node
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PUBLIC_BASE_URL = "https://aios-demo.hk-demo.workers.dev";
const DEFAULT_EXPIRES_AT = "2027-03-31T23:59:59Z";
const PASSCODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT_PATH = path.join(WORKER_ROOT, ".reviewer-pass.local.json");

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.AIOS_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL,
    expiresAt: process.env.AIOS_REVIEWER_EXPIRES_AT || DEFAULT_EXPIRES_AT,
    outPath: DEFAULT_OUT_PATH,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") {
      opts.baseUrl = argv[++i] || "";
    } else if (arg === "--expires-at") {
      opts.expiresAt = argv[++i] || "";
    } else if (arg === "--out") {
      opts.outPath = path.resolve(argv[++i] || DEFAULT_OUT_PATH);
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/generate-reviewer-pass.mjs [--base-url <url>] [--expires-at <iso>] [--out <path>] [--force]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function randomCodeGroup(length) {
  const bytes = randomBytes(length * 2);
  let out = "";
  let idx = 0;
  while (out.length < length) {
    if (idx >= bytes.length) {
      const extra = randomBytes(length);
      for (const b of extra) {
        if (b < 256 - (256 % PASSCODE_ALPHABET.length) && out.length < length) {
          out += PASSCODE_ALPHABET[b % PASSCODE_ALPHABET.length];
        }
      }
      continue;
    }
    const byte = bytes[idx++];
    if (byte < 256 - (256 % PASSCODE_ALPHABET.length)) {
      out += PASSCODE_ALPHABET[byte % PASSCODE_ALPHABET.length];
    }
  }
  return out;
}

function signCapabilityToken(gateSecret, expUnix, scope) {
  const payload = `aios-review-pass-v1:${expUnix}.${scope}`;
  const sigHex = createHmac("sha256", gateSecret)
    .update(payload, "utf8")
    .digest("hex");
  return `${expUnix}.${scope}.${sigHex}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const normalizedBaseUrl = opts.baseUrl.replace(/\/+$/, "");
  let parsedBase;
  try {
    parsedBase = new URL(normalizedBaseUrl);
  } catch {
    console.error("Invalid --base-url provided.");
    process.exit(2);
  }
  if (parsedBase.protocol !== "https:") {
    console.error("--base-url must use https://");
    process.exit(2);
  }

  const expiresMs = Date.parse(opts.expiresAt);
  if (!Number.isFinite(expiresMs)) {
    console.error("Invalid --expires-at ISO timestamp.");
    process.exit(2);
  }
  const expiresUnix = Math.floor(expiresMs / 1000);

  if (existsSync(opts.outPath) && !opts.force) {
    console.log(
      `Reviewer pass file already exists at ${opts.outPath}; keeping existing credentials (pass --force to rotate).`,
    );
    return;
  }

  const gateSecret = randomBytes(32).toString("hex");
  const reviewerPasscode = `THEODIC-DEMO-${randomCodeGroup(5)}-${randomCodeGroup(5)}`;
  const teamPasscode = `THEODIC-TEAM-${randomCodeGroup(5)}-${randomCodeGroup(5)}`;
  const reviewerSignedToken = signCapabilityToken(gateSecret, expiresUnix, "judge");
  const teamSignedToken = signCapabilityToken(gateSecret, expiresUnix, "team");

  const payload = {
    public_base_url: normalizedBaseUrl,
    login_url: `${normalizedBaseUrl}/login`,
    logout_url: `${normalizedBaseUrl}/review/logout`,
    reviewer_passcode: reviewerPasscode,
    team_passcode: teamPasscode,
    reviewer_fragment_url: `${normalizedBaseUrl}/review#${reviewerPasscode}`,
    reviewer_signed_url: `${normalizedBaseUrl}/review?pass=${reviewerSignedToken}`,
    team_signed_url: `${normalizedBaseUrl}/review?pass=${teamSignedToken}`,
    expires_at: new Date(expiresMs).toISOString().replace(".000Z", "Z"),
    expires_unix: expiresUnix,
    gate_secret: gateSecret,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    notes:
      "Gitignored local reviewer gate credentials. Do not commit or paste raw secrets into public logs or messages.",
  };

  mkdirSync(path.dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(opts.outPath, 0o600);

  console.log(
    `Generated gitignored reviewer pass metadata at ${opts.outPath} (expires: ${payload.expires_at}). Secrets were not printed to stdout.`,
  );
}

main();
