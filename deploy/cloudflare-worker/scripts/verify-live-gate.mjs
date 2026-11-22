#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WORKER_ROOT, "..", "..");

const DEFAULT_PASS_FILE = path.join(WORKER_ROOT, ".reviewer-pass.local.json");
const DEFAULT_QR_ASSET = path.join(REPO_ROOT, "docs", "pitch", "assets", "qr_mvp_reviewer_pass.png");
const DEFAULT_PPTX = path.join(REPO_ROOT, "deliverables", "Theodic_Pitch_Deck.pptx");

function parseArgs(argv) {
  const opts = {
    passFile: DEFAULT_PASS_FILE,
    qrAsset: DEFAULT_QR_ASSET,
    pptx: DEFAULT_PPTX,
    baseUrl: process.env.AIOS_PUBLIC_BASE_URL || "",
    skipQr: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pass-file") {
      opts.passFile = path.resolve(argv[++i] || "");
    } else if (arg === "--qr-asset") {
      opts.qrAsset = path.resolve(argv[++i] || "");
    } else if (arg === "--pptx") {
      opts.pptx = path.resolve(argv[++i] || "");
    } else if (arg === "--base-url") {
      opts.baseUrl = argv[++i] || "";
    } else if (arg === "--skip-qr") {
      opts.skipQr = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/verify-live-gate.mjs [--pass-file <path>] [--qr-asset <path>] [--pptx <path>] [--base-url <url>] [--skip-qr]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function resolveUvBinary() {
  if (process.env.UV_BIN && existsSync(process.env.UV_BIN)) {
    return process.env.UV_BIN;
  }
  const localUv = "/Users/rexzheng/.local/bin/uv";
  if (existsSync(localUv)) {
    return localUv;
  }
  return "uv";
}

function verifyQrPayloads(qrAssetPath, pptxPath, expectedSha256) {
  if (!existsSync(qrAssetPath)) {
    throw new Error(`Missing QR asset image: ${qrAssetPath}`);
  }
  if (!existsSync(pptxPath)) {
    throw new Error(`Missing PPTX deck: ${pptxPath}`);
  }

  // Never print decoded payloads; only compute SHA-256 digests and equality booleans.
  const pyScript = `
import hashlib
import json
import posixpath
import sys
import xml.etree.ElementTree as ET
import zipfile
import cv2
import numpy as np

qr_asset_path, pptx_path, expected_sha256 = sys.argv[1], sys.argv[2], sys.argv[3]
detector = cv2.QRCodeDetector()

def decode_and_hash(img):
    if img is None:
        return {"decoded_ok": False, "sha256_12": None, "matches_expected": False}
    text, _, _ = detector.detectAndDecode(img)
    if not text:
        return {"decoded_ok": False, "sha256_12": None, "matches_expected": False}
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return {
        "decoded_ok": True,
        "sha256_12": digest[:12],
        "matches_expected": digest == expected_sha256,
    }

asset_img = cv2.imread(qr_asset_path)
asset_res = decode_and_hash(asset_img)

pptx_media_path = None
with zipfile.ZipFile(pptx_path, "r") as zf:
    s13_xml = ET.fromstring(zf.read("ppt/slides/slide13.xml"))
    rels_xml = ET.fromstring(zf.read("ppt/slides/_rels/slide13.xml.rels"))
    rel_map = {el.attrib["Id"]: el.attrib["Target"] for el in rels_xml}

    ns = {
        "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    }
    for pic in s13_xml.findall(".//p:pic", ns):
        cnv = pic.find("./p:nvPicPr/p:cNvPr", ns)
        if cnv is not None and cnv.attrib.get("name") == "s13_qr":
            blip = pic.find("./p:blipFill/a:blip", ns)
            if blip is not None:
                rid = blip.attrib.get(f"{{{ns['r']}}}embed")
                target = rel_map.get(rid or "")
                if target:
                    pptx_media_path = (
                        target.lstrip("/")
                        if target.startswith("/")
                        else posixpath.normpath(posixpath.join("ppt/slides", target))
                    )

    if not pptx_media_path:
        raise RuntimeError("Could not locate s13_qr image relationship in ppt/slides/slide13.xml")

    raw_bytes = zf.read(pptx_media_path)
    arr = np.frombuffer(raw_bytes, dtype=np.uint8)
    pptx_img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    pptx_res = decode_and_hash(pptx_img)
    pptx_res["media_path"] = pptx_media_path

print(json.dumps({"asset": asset_res, "pptx": pptx_res}))
`;

  const uvBin = resolveUvBinary();
  const stdout = execFileSync(
    uvBin,
    ["run", "--with", "opencv-python-headless", "python3", "-", qrAssetPath, pptxPath, expectedSha256],
    {
      input: pyScript,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const parsed = JSON.parse(stdout.trim());
  const expectedPrefix = expectedSha256.slice(0, 12);

  console.log(
    `[QR] asset=${path.relative(REPO_ROOT, qrAssetPath)} sha256[:12]=${parsed.asset.sha256_12 ?? "NONE"} match=${parsed.asset.matches_expected ? "PASS" : "FAIL"}`,
  );
  console.log(
    `[QR] pptx=${path.relative(REPO_ROOT, pptxPath)} (${parsed.pptx.media_path}) sha256[:12]=${parsed.pptx.sha256_12 ?? "NONE"} match=${parsed.pptx.matches_expected ? "PASS" : "FAIL"}`,
  );

  assert.equal(parsed.asset.decoded_ok, true, "Failed to decode QR image in docs/pitch/assets");
  assert.equal(
    parsed.asset.matches_expected,
    true,
    `QR asset payload sha256[:12]=${parsed.asset.sha256_12} does not match expected ${expectedPrefix}`,
  );
  assert.equal(parsed.pptx.decoded_ok, true, "Failed to decode embedded QR image in PPTX Slide 13");
  assert.equal(
    parsed.pptx.matches_expected,
    true,
    `PPTX embedded QR payload sha256[:12]=${parsed.pptx.sha256_12} does not match expected ${expectedPrefix}`,
  );
}

function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function extractCookiePair(res, cookieName) {
  for (const raw of getSetCookies(res)) {
    const semi = raw.indexOf(";");
    const pair = semi === -1 ? raw : raw.slice(0, semi);
    if (pair.startsWith(`${cookieName}=`)) {
      return { pair, raw };
    }
  }
  return null;
}

function assertAuthCookies(res, label) {
  const gateCookie = extractCookiePair(res, "__Host-aios_gate");
  const localeCookie = extractCookiePair(res, "aios_locale");
  assert.ok(gateCookie && gateCookie.pair.length > "__Host-aios_gate=".length, `${label}: missing __Host-aios_gate Set-Cookie`);
  assert.equal(localeCookie?.pair, "aios_locale=en", `${label}: missing aios_locale=en Set-Cookie`);
  return gateCookie.pair;
}

async function safeFetch(label, url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const causeCode =
      err && typeof err === "object" && "cause" in err && err.cause && typeof err.cause === "object" && "code" in err.cause
        ? String(err.cause.code)
        : err instanceof Error
          ? err.name
          : "FETCH_ERROR";
    throw new Error(`${label} network request failed (${causeCode})`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.passFile)) {
    throw new Error(`Reviewer pass file not found: ${opts.passFile}`);
  }

  const passData = JSON.parse(readFileSync(opts.passFile, "utf8"));
  for (const key of ["public_base_url", "reviewer_fragment_url", "reviewer_signed_url", "reviewer_passcode"]) {
    assert.ok(
      typeof passData[key] === "string" && passData[key].trim().length > 0,
      `Missing required field "${key}" in pass file`,
    );
  }

  const baseUrl = (opts.baseUrl || passData.public_base_url).replace(/\/+$/, "");
  const fragmentUrlObj = new URL(passData.reviewer_fragment_url);
  const qrPasscode = fragmentUrlObj.hash.slice(1);
  assert.ok(qrPasscode.length > 0, "reviewer_fragment_url missing fragment passcode");
  assert.equal(
    qrPasscode,
    passData.reviewer_passcode,
    "reviewer_fragment_url fragment does not align with reviewer_passcode",
  );

  const expectedSha256 = createHash("sha256").update(passData.reviewer_fragment_url, "utf8").digest("hex");

  if (!opts.skipQr) {
    verifyQrPayloads(opts.qrAsset, opts.pptx, expectedSha256);
  }

  // (1) GET /robots.txt -> 200 + Disallow: / + x-robots-tag
  const robotsRes = await safeFetch("(1) GET /robots.txt", `${baseUrl}/robots.txt`, {
    redirect: "manual",
  });
  assert.equal(robotsRes.status, 200, "(1) GET /robots.txt expected 200");
  const robotsBody = await robotsRes.text();
  assert.ok(robotsBody.includes("Disallow: /"), "(1) /robots.txt missing Disallow: /");
  assert.ok(
    (robotsRes.headers.get("x-robots-tag") ?? "").includes("noindex"),
    "(1) /robots.txt missing x-robots-tag noindex",
  );
  console.log("[1/8] GET /robots.txt -> 200 (Disallow: /, x-robots-tag) PASS");

  // (2) GET /login (Accept: text/html, no cookie) -> 401
  const unauthLoginRes = await safeFetch("(2) GET /login", `${baseUrl}/login`, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(unauthLoginRes.status, 401, `(2) GET /login unauthenticated expected 401, got ${unauthLoginRes.status}`);
  console.log("[2/8] GET /login (no cookie) -> 401 PASS");

  // (3) POST /__gate/verify with decoded QR passcode AND lowercase variant
  let gateCookiePair = null;
  for (const [variantLabel, passcodeVariant] of [
    ["exact", qrPasscode],
    ["lowercase", qrPasscode.toLowerCase()],
  ]) {
    const verifyRes = await safeFetch(`(3) POST /__gate/verify (${variantLabel})`, `${baseUrl}/__gate/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ passcode: passcodeVariant }),
      redirect: "manual",
    });
    assert.equal(
      verifyRes.status,
      200,
      `(3) POST /__gate/verify (${variantLabel}) expected 200, got ${verifyRes.status}`,
    );
    const verifyJson = await verifyRes.json();
    assert.deepEqual(verifyJson, { ok: true, redirect: "/login", scope: "judge" });
    gateCookiePair = assertAuthCookies(verifyRes, `(3) POST /__gate/verify (${variantLabel})`);
  }
  console.log("[3/8] POST /__gate/verify (QR passcode + lowercase variant) -> 200 scope=judge + cookies PASS");

  // (4) GET /review WITH __Host-aios_gate cookie -> 303 -> /login
  const reviewAuthedRes = await safeFetch("(4) GET /review (authed)", `${baseUrl}/review`, {
    headers: { cookie: gateCookiePair },
    redirect: "manual",
  });
  assert.equal(
    reviewAuthedRes.status,
    303,
    `(4) GET /review with gate cookie expected 303, got ${reviewAuthedRes.status}`,
  );
  assert.equal(
    reviewAuthedRes.headers.get("location"),
    `${baseUrl}/login`,
    "(4) GET /review expected Location -> /login",
  );
  console.log("[4/8] GET /review (with gate cookie) -> 303 /login PASS");

  // (5) GET /api/auth/demo-personas WITH cookie -> 200
  const personasRes = await safeFetch("(5) GET /api/auth/demo-personas", `${baseUrl}/api/auth/demo-personas`, {
    headers: { cookie: gateCookiePair, accept: "application/json" },
    redirect: "manual",
  });
  assert.equal(
    personasRes.status,
    200,
    `(5) GET /api/auth/demo-personas expected 200, got ${personasRes.status}`,
  );
  console.log("[5/8] GET /api/auth/demo-personas (with gate cookie) -> 200 PASS");

  // (6) POST /v1/admin/pause WITH cookie -> 403 JUDGE_SANDBOX_PROTECTED
  const adminPauseRes = await safeFetch("(6) POST /v1/admin/pause", `${baseUrl}/v1/admin/pause`, {
    method: "POST",
    headers: {
      cookie: gateCookiePair,
      "content-type": "application/json",
    },
    body: "{}",
    redirect: "manual",
  });
  assert.equal(
    adminPauseRes.status,
    403,
    `(6) POST /v1/admin/pause expected 403, got ${adminPauseRes.status}`,
  );
  const adminPauseJson = await adminPauseRes.json();
  assert.equal(adminPauseJson?.detail?.code, "JUDGE_SANDBOX_PROTECTED");
  console.log("[6/8] POST /v1/admin/pause (with gate cookie) -> 403 JUDGE_SANDBOX_PROTECTED PASS");

  // (7) GET reviewer_signed_url -> 303 -> /login
  const signedObj = new URL(passData.reviewer_signed_url);
  const targetSignedUrl = `${baseUrl}${signedObj.pathname}${signedObj.search}`;
  const signedRes = await safeFetch("(7) GET reviewer_signed_url", targetSignedUrl, {
    redirect: "manual",
  });
  assert.equal(signedRes.status, 303, `(7) GET reviewer_signed_url expected 303, got ${signedRes.status}`);
  assert.equal(
    signedRes.headers.get("location"),
    `${baseUrl}/login`,
    "(7) GET reviewer_signed_url expected Location -> /login",
  );
  assertAuthCookies(signedRes, "(7) GET reviewer_signed_url");
  console.log("[7/8] GET reviewer_signed_url -> 303 /login + cookies PASS");

  // (8) POST /__gate/logout -> 200
  const logoutRes = await safeFetch("(8) POST /__gate/logout", `${baseUrl}/__gate/logout`, {
    method: "POST",
    headers: { cookie: gateCookiePair },
    redirect: "manual",
  });
  assert.equal(logoutRes.status, 200, `(8) POST /__gate/logout expected 200, got ${logoutRes.status}`);
  const logoutJson = await logoutRes.json();
  assert.equal(logoutJson?.ok, true);
  const clearedCookie = extractCookiePair(logoutRes, "__Host-aios_gate");
  assert.ok(
    clearedCookie && clearedCookie.raw.includes("Max-Age=0"),
    "(8) POST /__gate/logout did not clear __Host-aios_gate with Max-Age=0",
  );
  console.log("[8/8] POST /__gate/logout -> 200 PASS");
  console.log("LIVE_GATE_VERIFICATION: ALL CHECKS PASSED");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`LIVE_GATE_VERIFICATION FAILED: ${msg}`);
  process.exit(1);
});
