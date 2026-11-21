"use strict";

const $ = (id) => document.getElementById(id);
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
const e = escapeHTML;
const money = (value) => Number(value).toLocaleString("en-HK", { maximumFractionDigits: 2 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stepNames = ["Read & locate", "Review & rules", "Approved"];
const samples = [
  [
    "standard",
    "Sample A",
    "Printed PO",
    "Straight through",
    "A clean printed order. Passes every rule and converts cases to pieces automatically.",
  ],
  [
    "review",
    "Sample B",
    "Handwritten quantity",
    "Conflict check",
    "The initial quantity fails the line-total check. Compare the handwritten figure with the crop and confirm it.",
  ],
  [
    "shorthand",
    "Sample C",
    "WhatsApp forward",
    "New buyer alias",
    "Uses an unregistered buyer code (LEMON-CTN). Pick the matching SKU and save it for next time.",
  ],
];
const labels = {
  po: "PO number",
  buyer: "Buyer",
  delivery: "Delivery date",
  currency: "Currency",
  total: "Order total",
  sku: "Buyer code",
  quantity: "Quantity",
  unit: "Unit",
  unit_price: "Case price",
  amount: "Line total",
};
function fieldName(key) {
  const parts = key.split(".");
  return parts.length === 3 ? `Line ${parts[1]} · ${labels[parts[2]] || parts[2]}` : labels[key] || key;
}
function fresh(mode) {
  return {
    mode,
    step: 0,
    run: null,
    active: "",
    overrides: {},
    mappings: {},
    remember: false,
    preview: null,
    command: null,
    busy: false,
    pending: false,
    revision: 0,
    feedback: "",
    tone: "",
    guide: mode === "tour",
    inspected: false,
    guideTarget: null,
  };
}
let state = fresh("welcome");

function message(text = "") {
  $("message").textContent = text;
  $("message").hidden = !text;
}
function friendly(detail) {
  const rules = [
    [/Incomplete table/, "Could not read the full product table. Upload a clearer image showing all columns."],
    [/Resolve (\S+) before approval/, (_, key) => `Check ${fieldName(key)} first.`],
    [/does not match an approved SKU|Select a suggested SKU/, "This buyer code or pack size is not in the catalogue."],
    [/Buyer and currency/, "This buyer or currency is not in the demo profile, so it stays in review."],
    [/Line totals/, "Line amounts do not add up to the order total. Blocked by rule."],
    [/different command/, "This PO number already has a different approved draft. Review both versions."],
    [/Local OCR is unavailable/, "Local OCR is unavailable. Check the OCR setup and try again."],
    [/Use a readable|8 MB|eight megapixels/, "Upload a PNG or JPEG image under 8 MB and 8 megapixels."],
    [/VISION|Live vision/, "Live vision is not configured. Running with local OCR only."],
  ];
  for (const [pattern, translation] of rules) {
    const match = String(detail).match(pattern);
    if (match) return typeof translation === "function" ? translation(...match) : translation;
  }
  return "The action could not be completed. Check your entries and try again.";
}
async function request(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error("Could not reach the local service. Try again in a moment.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(friendly(data.detail));
    error.detail = typeof data.detail === "string" ? data.detail : "";
    throw error;
  }
  return response.json();
}
const post = (path, body = {}) =>
  request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
function heading(kicker, title, sub) {
  return `<header class="page-head"><div class="eyebrow">${e(kicker)}</div><h1>${e(title)}</h1><p>${e(sub)}</p></header>`;
}
function action(id, label, disabled = false) {
  return `<div class="actions"><button type="button" class="primary" id="${id}" ${disabled ? "disabled" : ""}>${e(label)}</button></div>`;
}
function shell() {
  $("stepper").innerHTML = stepNames
    .map(
      (label, i) =>
        `<div class="step ${state.step === i + 1 ? "active" : state.step > i + 1 ? "done" : ""}" ${state.step === i + 1 ? 'aria-current="step"' : ""}><span class="num">${state.step > i + 1 ? "✓" : "0" + (i + 1)}</span><span class="step-label">${label}</span></div>`,
    )
    .join("");
  $("audit").hidden = !state.run || state.step === 3;
  $("audit-data").textContent = state.run
    ? JSON.stringify(
        {
          local_ocr: Object.values(state.run.fields).find((field) => field.ocr)?.ocr.source,
          reader: state.run.reader_mode,
          metrics: state.command?.metrics || state.run.metrics,
          sha256: state.run.artifact_sha256,
          run_id: state.run.run_id,
          preview_digest: state.preview?.digest,
          events: state.command?.events || [],
        },
        null,
        2,
      )
    : "No order loaded yet.";
  ["tour-start", "mode-open", "reset-memory"].forEach((id) => ($(id).disabled = state.busy || state.pending));
}
function showStart(mode) {
  closeCoach();
  state = fresh(mode);
  message();
  if ($("welcome").open) $("welcome").close();
  render();
  window.scrollTo(0, 0);
}
function renderStart() {
  if (state.mode === "explore") {
    $("screen").innerHTML =
      heading("EXPLORE MODE", "Upload a purchase order", "Test the intake flow with a non-sensitive PO image.") +
      `<form class="panel upload" id="upload-form"><h2>Choose an order image</h2><p>This prototype is not yet tuned to your buyer layouts. Unfamiliar formats or unclear handwriting pause for clerk review instead of guessing.</p><label for="file">Order image · PNG or JPEG, up to 8 MB</label><input id="file" type="file" accept="image/png,image/jpeg" required><label class="check"><input type="checkbox" id="vision"> Use configured vision model for disputed fields</label><div class="actions"><button class="primary" ${state.busy ? "disabled" : ""}>${state.busy ? "Reading order…" : "Read order →"}</button></div></form>
      <details class="panel recent-panel"><summary>Open a recent order</summary><div id="recent-list"></div></details>`;
    $("upload-form").onsubmit = (event) => {
      event.preventDefault();
      const file = $("file").files[0];
      if (!file || file.size > 8000000) return message("Choose a PNG or JPEG image under 8 MB.");
      const mode = $("vision").checked ? "vision-on-demand" : "ocr";
      loadRun(() =>
        request(`/api/intakes/upload?mode=${mode}&filename=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        }),
      );
    };
    document.querySelector(".recent-panel").ontoggle = async (event) => {
      if (!event.target.open) return;
      const list = $("recent-list");
      try {
        const runs = await request("/api/intakes");
        list.innerHTML = runs.length
          ? runs
              .map(
                (run) =>
                  `<button class="field" data-run="${e(run.run_id)}"><span>${e(run.filename)}</span><small>${e(new Date(run.created_at * 1000).toLocaleString("en-GB"))}</small></button>`,
              )
              .join("")
          : "No saved orders yet";
      } catch (error) {
        list.textContent = error.message;
      }
    };
  } else {
    $("screen").innerHTML =
      heading("TOUR MODE", "Choose an order to start", "Three orders from the same buyer, each showing a different part of the workflow.") +
      `<div class="picker" id="picker">${samples
        .map(
          ([key, letter, title, badge, copy]) =>
            `<button class="sample" data-sample="${key}" ${state.busy ? "disabled" : ""}><img src="/sample/${key}" alt="${e(title)} preview"><div class="sample-copy"><span class="badge">${letter} · ${badge}</span><h2>${title}</h2><p>${copy}</p><span class="sample-link">Open order →</span></div></button>`,
        )
        .join("")}</div>`;
  }
}
async function loadRun(getEvidence, restore = false) {
  if (state.busy) return;
  state.busy = true;
  shell();
  closeCoach();
  message("Reading source document and locating fields…");
  $("screen").setAttribute("aria-busy", "true");
  try {
    const run = await getEvidence();
    state.run = run;
    state.active = run.review_fields[0] || "po";
    state.step = 1;
    if (restore && run.preview) {
      state.preview = run.preview;
      state.overrides = { ...run.preview.overrides };
      state.mappings = { ...run.preview.mappings };
      state.step = 2;
    }
    if (restore && run.command_id) {
      state.command = await getCommand(run.command_id);
      if (verified(state.command)) state.step = 3;
    }
    message();
    window.scrollTo(0, 0);
  } catch (error) {
    message(error.message);
  } finally {
    state.busy = false;
    $("screen").removeAttribute("aria-busy");
    render();
  }
}
function fieldButtons(keys) {
  return keys.map((key) => {
    const field = state.run.fields[key];
    return `<button type="button" class="field ${key === state.active ? "selected" : ""}" data-field="${e(key)}" aria-pressed="${key === state.active}">
      <span>${e(labels[key.split(".").pop()] || key)}</span><strong>${e(field.confirmed ?? field.initial_reading ?? field.ocr?.value ?? "Not located")}</strong></button>`;
  }).join("");
}
function renderRead() {
  const run = state.run;
  const header = ["po", "buyer", "delivery", "currency", "total"];
  const rows = Array.from({ length: run.rows }, (_, i) => {
    const keys = ["sku", "quantity", "unit", "unit_price", "amount"].map((name) => `line.${i + 1}.${name}`);
    return `<section class="item-group"><h4>Line ${i + 1}</h4><div class="item-fields">${fieldButtons(keys)}</div></section>`;
  });
  $("screen").innerHTML =
    heading("01 / 03", "Read & locate", "Select a field to see its position on the original order.") +
    `<div class="source-grid"><article class="panel"><div class="panel-head"><h2>Source document</h2><span class="badge">Page 1</span></div>
    <div class="paper"><img src="${e(run.source_url)}" width="${run.image_width}" height="${run.image_height}" alt="Purchase order source"><div id="bbox" class="bbox"></div></div>
    <p id="active-caption"></p></article><article class="panel" id="field-panel"><div class="panel-head"><h2>Extracted fields</h2><span class="badge ${!run.complete || run.review_fields.length ? "warn" : "ok"}">${!run.complete ? "Incomplete table" : run.review_fields.length ? "Needs review" : "All clear"}</span></div>
    <section class="field-group"><h3>Order header</h3><div class="header-fields">${fieldButtons(header)}</div></section><section class="field-group"><h3>Line items</h3>${rows.length ? rows.join("") : '<p class="feedback bad">No line items extracted from this image.</p>'}</section></article></div>` +
    action("to-review", "Continue to review →");
  locate(state.active);
}
function locate(key) {
  state.active = key;
  const obs = state.run.fields[key]?.ocr;
  const box = $("bbox");
  box.hidden = !obs;
  if (obs) {
    const [x, y, right, bottom] = obs.bbox,
      w = state.run.image_width,
      h = state.run.image_height;
    Object.assign(box.style, {
      left: (100 * x) / w + "%",
      top: (100 * y) / h + "%",
      width: (100 * (right - x)) / w + "%",
      height: (100 * (bottom - y)) / h + "%",
    });
  }
  $("active-caption").textContent = obs
    ? `${fieldName(key)} · ${state.run.fields[key].initial_reading ? `Initial reading ${state.run.fields[key].initial_reading} · Local OCR ${obs.value}` : obs.value}`
    : `${fieldName(key)} · No verified region`;
  document.querySelectorAll("[data-field]").forEach((button) => {
    const active = button.dataset.field === key;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
}
function draftTable(payload, title = "Proposed ERP draft") {
  return `<div class="panel draft"><div class="panel-head"><h2>${e(title)}</h2><span class="badge ok">${e(payload.po)}</span></div><div class="table-scroll"><table class="summary-table"><thead><tr><th>Buyer code</th><th>ERP SKU</th><th>Ordered</th><th>ERP qty</th><th>Line total</th></tr></thead><tbody>${payload.items
    .map(
      (item) =>
        `<tr><td>${e(item.source_sku)}</td><td>${e(item.sku)}</td><td>${e(item.source_quantity)} cases</td><td><strong>${e(item.erp_quantity)} pcs</strong></td><td>HK$ ${money(item.line_total)}</td></tr>`,
    )
    .join("")}</tbody></table></div><p>Draft total <strong>HK$ ${money(payload.total)}</strong></p></div>`;
}
function issueHTML(key) {
  const field = state.run.fields[key],
    value = state.overrides[key] ?? "",
    attr = e(key);
  if (field.candidates) {
    return `<article class="panel issue"><span class="badge warn">New alias</span><h2>Which SKU is ${e(field.source_value)}?</h2><p>Buyer ${e(state.run.fields.buyer.confirmed)} has not used this code before. Pick the matching product and pack size.</p>
      <div class="candidates" id="candidates">${field.candidates.map((item) => `<button class="candidate ${state.mappings[key] === item.erp_sku ? "selected" : ""}" data-map="${attr}" data-sku="${e(item.erp_sku)}" aria-pressed="${state.mappings[key] === item.erp_sku}"><strong>${e(item.erp_sku)}</strong><span>${e(item.name)}</span><small>${item.units_per_case} pcs / case</small></button>`).join("")}</div></article>`;
  }
  const readings = field.vision.map((item) => item.value).filter(Boolean);
  // Saved runs can predate the explicit arithmetic verdict. Use their recorded
  // readings and confirmed amounts to present the same clerk decision.
  const row = key.slice(0, key.lastIndexOf(".") + 1);
  const price = state.run.fields[row + "unit_price"]?.confirmed;
  const printed = field.printed_amount ?? state.run.fields[row + "amount"]?.confirmed;
  const initial = field.initial_reading ?? readings[0] ?? field.ocr?.value;
  const calculated = field.calculated_amount ?? Number(initial) * Number(price);
  const checkQuantity = key.endsWith(".quantity") && price != null && printed != null;
  const matchesTotal = (quantity) => Math.round(Number(quantity) * Number(price) * 100) === Math.round(Number(printed) * 100);
  const mismatch = field.reason_code === "ROW_AMOUNT_MISMATCH" && field.initial_reading ||
    (checkQuantity && /^\d+$/.test(initial) && !matchesTotal(initial));
  const choices = [...new Set([...readings, field.ocr?.value].filter(Boolean))]
    .filter((choice) => !checkQuantity || matchesTotal(choice));
  if (mismatch) return `<article class="panel issue amount-issue" data-issue="${attr}">
    <div class="panel-head"><h2>${e(fieldName(key))}</h2><button type="button" class="secondary compact edit-quantity" data-edit="${attr}" hidden>Edit quantity</button><span class="badge">Blocked by rule</span></div>
    <div class="conflict-body"><canvas class="crop" data-crop="${attr}" aria-label="Handwritten quantity on source order"></canvas>
    <div><p class="conflict-detail">Initial reading (${e(initial)}) failed the line-total check (HK$ ${money(calculated)} vs HK$ ${money(printed)}). Check the crop and confirm the right quantity.</p>
    <div class="review-inputs">${choices.map((choice) => `<button class="secondary" data-choice="${e(choice)}" data-key="${attr}">Confirm ${e(choice)}</button>`).join("")}
    <label>Quantity <input data-input="${attr}" value="${e(value)}" inputmode="numeric" maxlength="4" placeholder="Enter quantity"></label></div></div></div></article>`;
  const detail = readings.length
    ? `Local OCR read ${field.ocr?.value ?? "nothing"}; the ${state.run.reader_mode === "scripted vision" ? "sample vision reader" : "vision model"} read ${readings[0]}. Check the crop and confirm the right value.`
    : "Check the source crop and enter the confirmed value. Rules will verify the arithmetic.";
  return `<article class="panel issue"><div class="panel-head"><h2>${e(fieldName(key))}</h2><span class="badge warn">Needs review</span></div>
    ${field.ocr ? `<canvas class="crop" data-crop="${attr}" aria-label="Source crop for ${e(fieldName(key))}"></canvas>` : ""}<p>${e(detail)}</p>
    <div class="review-inputs"><label>${e(fieldName(key))} <input data-input="${attr}" maxlength="40" value="${e(value)}" placeholder="Enter value" autocomplete="off"></label>
    ${choices.map((choice) => `<button class="secondary" data-choice="${e(choice)}" data-key="${attr}">Confirm ${e(choice)}</button>`).join("")}</div></article>`;
}
function renderReview() {
  const run = state.run,
    aliases = run.review_fields.filter((key) => run.fields[key].candidates);
  $("screen").innerHTML =
    heading(
      "02 / 03",
      "Review & rules",
      run.review_fields.length
        ? "Check the flagged values against the source before approving."
        : "All fields passed. Review the converted ERP draft below.",
    ) +
    `<div class="pipeline" id="pipeline"><div class="pipe"><small>Fields</small><strong id="passed-count"></strong></div><div class="pipe"><small>Conflicts</small><strong id="conflict-count"></strong></div><div class="pipe"><small>Buyer aliases</small><strong id="alias-count"></strong></div></div>
    ${!run.complete ? '<div class="feedback bad">Could not locate the full product table. Upload a clearer image showing every line.</div>' : run.review_fields.map(issueHTML).join("")}
    ${aliases.length ? `<label class="check"><input id="remember" type="checkbox" ${state.remember ? "checked" : ""}>Save this mapping for future orders from this buyer</label>` : ""}
    <div id="feedback" role="status" aria-live="polite"></div><div id="draft"></div>` +
    action("to-write", "Approve & write to ERP →", !state.preview || state.pending);
  document.querySelectorAll("[data-crop]").forEach((canvas) => drawCrop(canvas, run));
  updateReview();
}
function drawCrop(canvas, run) {
  const image = new Image();
  image.onload = () => {
    const [left, top, right, bottom] = run.fields[canvas.dataset.crop].ocr.bbox;
    const h = bottom - top,
      pad = Math.max(8, h * 0.65);
    const x = Math.max(0, left - pad * 2),
      y = Math.max(0, top - pad);
    const width = Math.min(image.width - x, right - left + pad * 4),
      height = Math.min(image.height - y, h + pad * 2);
    canvas.width = Math.ceil(width * 2);
    canvas.height = Math.ceil(height * 2);
    canvas.getContext("2d").drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
  };
  image.src = run.source_url;
}
function updateReview() {
  const status = $("feedback");
  if (!status) return;
  status.className = "feedback " + state.tone;
  status.hidden = !state.feedback;
  status.textContent = state.feedback;
  $("draft").innerHTML = state.preview ? draftTable(state.preview.payload) : "";
  document.querySelector(".page-head p").textContent = state.preview ? "Check the converted quantities and line totals before approval." : state.run.review_fields.length ? "Check the flagged values against the source before approving." : "Preparing the ERP draft.";
  $("to-write").disabled = !state.preview || state.pending;
  const unresolved = state.run.review_fields.length;
  const aliases = state.run.review_fields.filter((key) => state.run.fields[key].candidates).length;
  const conflicts = state.preview ? 0 : unresolved - aliases;
  const remembered = Object.values(state.run.fields).filter((field) => field.mapping).length;
  $("alias-count").textContent = remembered ? `${remembered} matched from memory` :
    state.preview && aliases ? `${aliases} mapped` : `${aliases} to map`;
  $("passed-count").textContent = `${Object.keys(state.run.fields).length - (state.preview ? 0 : unresolved)} passed`;
  $("conflict-count").textContent = `${conflicts} conflict${conflicts === 1 ? "" : "s"}`;
  for (const card of document.querySelectorAll(".amount-issue")) {
    card.classList.toggle("resolved", Boolean(state.preview));
    card.classList.toggle("editing", state.editing === card.dataset.issue);
    card.querySelector("[data-edit]").hidden = !state.preview || state.editing === card.dataset.issue;
    card.querySelector(".badge").textContent = state.preview ? "Confirmed" : "Blocked by rule";
    card.querySelector(".conflict-detail").hidden = Boolean(state.preview);
  }
  document.querySelectorAll("[data-map]").forEach((button) => {
    const selected = state.mappings[button.dataset.map] === button.dataset.sku;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}
function reviewBody() {
  return { run_id: state.run.run_id, overrides: { ...state.overrides }, mappings: { ...state.mappings } };
}
let validating = false;
async function validate() {
  const s = state;
  s.revision++;
  s.preview = null;
  s.feedback = "";
  s.tone = "";
  if (s.step !== 2 || !s.run.complete) return;
  if (validating) {
    updateReview();
    return;
  }
  validating = true;
  s.pending = true;
  shell();
  updateReview();
  try {
    for (;;) {
      const revision = s.revision;
      const ready = s.run.review_fields.every((key) =>
        s.run.fields[key].candidates ? s.mappings[key] : s.overrides[key]?.trim(),
      );
      if (!ready) break;
      try {
        const result = await post("/api/preview?feedback=true", { ...reviewBody(), remember: s.remember });
        if (result.blocked) {
          const error = new Error(friendly(result.detail));
          error.detail = result.detail;
          throw error;
        }
        if (s !== state || s.step !== 2) break;
        if (revision !== s.revision) continue;
        s.preview = result;
        const quantityKey = s.run.review_fields.find((key) => key.endsWith(".quantity"));
        const item = result.payload.items[quantityKey ? Number(quantityKey.split(".")[1]) - 1 : 0];
        const conversion = `${item.source_quantity} cases → ${item.erp_quantity} pieces (HK$ ${money(item.line_total)})`;
        s.feedback =
          s.remember && Object.keys(s.mappings).length
            ? "Saved to this buyer's catalogue. Future orders using this code will match automatically."
            : conversion;
        s.tone = "good";
      } catch (error) {
        if (revision !== s.revision) continue;
        const mismatch = error.detail?.match(/Line (\d+) quantity × price/);
        if (mismatch) {
          const prefix = `line.${mismatch[1]}.`;
          const value = (key) => s.overrides[prefix + key] ?? s.run.fields[prefix + key].confirmed;
          const quantity = value("quantity"),
            price = value("unit_price");
          s.feedback = `${quantity} × HK$ ${money(price)} = HK$ ${money(quantity * price)}, which does not match the line total of HK$ ${money(value("amount"))}. Blocked by rule.`;
        } else {
          s.feedback = error.message;
        }
        s.tone = "bad";
      }
      if (revision === s.revision) break;
    }
  } finally {
    validating = false;
    s.pending = false;
    if (s === state) {
      shell();
      updateReview();
      guide();
    }
  }
}

const getCommand = (id) =>
  request(`/api/commands/${encodeURIComponent(id)}?run_id=${encodeURIComponent(state.run.run_id)}`);
function verified(command) {
  return command?.status === "COMMITTED" && command.matching_erp_drafts === 1 && command.verified_payload;
}
async function dispatch() {
  if (!state.preview || state.pending || state.busy) return;
  state.busy = true;
  message();
  closeCoach();
  shell();
  $("to-write").disabled = true;
  $("to-write").textContent = "Writing & verifying…";
  $("screen").inert = true;
  try {
    const { command_id } = await post("/api/approve", {
      ...reviewBody(), digest: state.preview.digest, simulate_timeout: true,
    });
    for (let attempt = 0; attempt <= 24; attempt++) {
      state.command = await getCommand(command_id);
      if (verified(state.command)) {
        state.guide = false;
        move(3);
        return;
      }
      if (state.command.status === "NEEDS_OPERATOR")
        throw new Error("ERP record differs from the approved draft. Moved to manual review.");
      if (attempt === 24) break;
      const tick = await post("/api/worker/tick");
      if (!tick.worked) await sleep(120);
    }
    throw new Error("Still waiting for ERP confirmation. Try again in a moment.");
  } catch (error) {
    message(error.message);
  } finally {
    state.busy = false;
    $("screen").inert = false;
    shell();
    if (state.step === 2) renderReview();
  }
}
function renderApproved() {
  $("screen").innerHTML = heading("03 / 03 · Approved",
    `${state.command.erp_id} verified in ERP · 0 duplicates`,
    "Even if the ERP reply is lost, read-back confirms one matching draft.") +
    draftTable(state.command.verified_payload, "Verified ERP draft") +
    action("restart", "Try another order →");
}
function render() {
  closeCoach();
  shell();
  if (state.step === 0) renderStart();
  else if (state.step === 1) renderRead();
  else if (state.step === 2) renderReview();
  else renderApproved();
  guide();
}
function move(step) {
  state.step = step;
  state.guideTarget = null;
  message();
  window.scrollTo(0, 0);
  render();
}
function closeCoach() {
  const coach = $("coach");
  coach.hidden = true;
  if (coach.parentElement !== document.body) document.body.append(coach);
  coach.classList.remove("docked");
  const dock = $("tour-dock");
  if (dock.firstElementChild) $("screen").append(dock.firstElementChild);
  dock.hidden = true;
  document.body.classList.remove("reading-tour");
  $("spotlight").setAttribute("hidden", "");
  if (state) state.guideTarget = null;
}
function instruction() {
  switch (state.step) {
    case 0:
      return ["#picker", "Choose an order", "Pick one of the three sample orders. Choose Sample B to see a quantity conflict and rule check."];
    case 1:
      return [".source-grid", "Explore the source",
        state.inspected ? "Select more fields, or click Continue to review →." : "Click any field to locate its value on the original order."];
    default:
      return null;
  }
}
function positionCoach() {
  const target = state.guideTarget;
  if (!target || !target.isConnected || $("coach").hidden) return;
  const r = target.getBoundingClientRect(),
    margin = 8,
    coach = $("coach");
  const headerBottom = Math.max(0, document.querySelector(".topbar").getBoundingClientRect().bottom);
  const visible = coach.classList.contains("docked") || (r.bottom > headerBottom && r.top < innerHeight);
  coach.style.visibility = visible ? "" : "hidden";
  $("spotlight").style.visibility = visible ? "" : "hidden";
  if (!visible) return;
  const hole = $("spot-hole");
  for (const [key, value] of Object.entries({
    x: r.left - 5,
    y: r.top - 5,
    width: r.width + 10,
    height: r.height + 10,
    rx: 12,
  }))
    hole.setAttribute(key, value);
  const context = $("spot-context");
  const extra = state.step === 1 ? $("tour-dock") : null;
  const second = extra?.getBoundingClientRect();
  context.setAttribute("width", second ? second.width + 8 : 0);
  if (second) {
    context.setAttribute("x", second.left - 4);
    context.setAttribute("y", second.top - 4);
    context.setAttribute("height", second.height + 8);
  }
  if (coach.classList.contains("docked")) return;
  const w = coach.offsetWidth,
    h = coach.offsetHeight;
  const clamp = (n, low, high) => Math.max(low, Math.min(n, high));
  const top = clamp(r.top, margin, innerHeight - h - margin),
    left = clamp(r.left, margin, innerWidth - w - margin);
  const positions = [
    [r.right + 14, top],
    [r.left - 14 - w, top],
    [left, r.bottom + 12],
    [left, r.top - 12 - h],
  ];
  const fits = ([x, y]) =>
    x >= margin && y >= margin && x + w <= innerWidth - margin && y + h <= innerHeight - margin;
  const best = positions.find(fits) || [
      margin,
      r.top + r.height / 2 > innerHeight / 2 ? margin : innerHeight - h - margin,
    ];
  coach.style.left = best[0] + "px";
  coach.style.top = best[1] + "px";
}
function guide(scroll = true) {
  if (!state.guide || $("welcome").open || state.busy || state.step >= 2) return closeCoach();
  const [selector, title, copy] = instruction();
  const target = document.querySelector(selector);
  if (!target) return closeCoach();
  const changed = target !== state.guideTarget;
  state.guideTarget = target;
  $("coach-index").textContent = state.step ? "Step 01 of 03" : "Tour";
  $("coach-title").textContent = title;
  $("coach-text").textContent = copy;
  $("coach-close").textContent = "Exit tour";
  $("coach").classList.toggle("docked", state.step === 1);
  if (state.step === 1) {
    const dock = $("tour-dock");
    if (dock.hidden) {
      const actions = $("to-review").parentElement;
      actions.prepend($("coach"));
      dock.append(actions);
      dock.hidden = false;
      document.body.classList.add("reading-tour");
    }
    $("to-review").classList.toggle("suggested", state.inspected);
  }
  $("coach").hidden = false;
  $("spotlight").removeAttribute("hidden");
  if (scroll && changed && !state.busy) {
    const r = target.getBoundingClientRect();
    if (r.bottom < 70 || r.top > innerHeight - 60) target.scrollIntoView({ block: "center" });
  }
  positionCoach();
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  const data = button.dataset;
  if (button.id === "coach-close") {
    state.guide = false;
    closeCoach();
    return;
  }
  if (state.busy) return;
  if (data.sample) {
    loadRun(() => post("/api/intake", { sample: data.sample }));
    return;
  }
  if (data.run) {
    loadRun(() => request("/api/intakes/" + encodeURIComponent(data.run)), true);
    return;
  }
  if (data.field) {
    locate(data.field);
    state.inspected = true;
    if (matchMedia("(max-width: 680px)").matches)
      document.querySelector(".paper").scrollIntoView({ block: "center" });
    guide(false);
    return;
  }
  if (data.map) {
    state.mappings[data.map] = data.sku;
    validate();
    return;
  }
  if (data.edit) {
    state.editing = data.edit;
    updateReview();
    const input = document.querySelector(`[data-input="${CSS.escape(data.edit)}"]`);
    input.focus();
    input.select();
    return;
  }
  if (data.choice) {
    state.editing = null;
    state.overrides[data.key] = data.choice;
    const input = document.querySelector(`[data-input="${CSS.escape(data.key)}"]`);
    input.value = data.choice;
    validate();
    return;
  }
  switch (button.id) {
    case "start-tour":
    case "tour-start":
      showStart("tour");
      break;
    case "restart":
      showStart(state.mode);
      break;
    case "start-explore":
      showStart("explore");
      break;
    case "mode-open":
      closeCoach();
      $("welcome").showModal();
      break;
    case "reset-memory":
      (async () => {
        try {
          state.pending = true;
          shell();
          const result = await post("/api/demo/reset");
          message(`Cleared ${result.cleared} saved buyer alias(es). Next order will re-run matching.`);
        } catch (error) {
          message(error.message);
        } finally {
          state.pending = false;
          shell();
        }
      })();
      break;
    case "to-review":
      move(2);
      validate();
      break;
    case "to-write":
      dispatch();
      break;
  }
});
document.addEventListener("input", (event) => {
  if (event.target.dataset.input) {
    state.overrides[event.target.dataset.input] = event.target.value.trim();
    validate();
  }
});
document.addEventListener("change", (event) => {
  if (event.target.id === "remember") {
    state.remember = event.target.checked;
    validate();
  }
});
window.addEventListener("resize", positionCoach);
window.addEventListener("scroll", positionCoach, { passive: true, capture: true });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("coach").hidden) {
    state.guide = false;
    closeCoach();
  }
});
$("welcome").addEventListener("cancel", (event) => {
  if (state.mode === "welcome") event.preventDefault();
});
$("welcome").addEventListener("close", () => guide(false));
render();
$("welcome").showModal();
