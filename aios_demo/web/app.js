"use strict";

const $ = (id) => document.getElementById(id);
const names = {
  po: "Purchase order",
  buyer: "Buyer",
  delivery: "Delivery date",
  currency: "Currency",
  total: "Order total",
  "line.1.sku": "Line 1 · Item",
  "line.1.quantity": "Line 1 · Quantity",
  "line.1.unit": "Line 1 · Unit",
  "line.2.quantity": "Line 2 · Quantity",
};
const focusKeys = [
  "po", "buyer", "delivery", "line.1.sku", "line.1.quantity", "line.1.unit", "line.2.quantity", "total",
];
const stateLabels = {
  needs_review: "Needs review",
  ready_for_preview: "Ready to preview",
  preview_ready: "Preview saved",
  QUEUED: "Queued",
  SENDING: "Sending",
  VERIFYING: "Verifying",
  OUTCOME_UNKNOWN: "Outcome unknown",
  COMMITTED: "Verified in ERP",
  NEEDS_OPERATOR: "Operator needed",
};
const eventLabels = {
  APPROVED: "01 · Approval",
  OUTBOX_QUEUED: "02 · Queued",
  SENDING: "03 · ERP call",
  VERIFYING: "04 · Verify",
  OUTCOME_UNKNOWN: "04 · Response lost",
  RECHECK: "Read-back scheduled",
  COMMITTED: "05 · Read-back matched",
  NEEDS_OPERATOR: "Operator review",
};
let run;
let preview;
let overrides = {};
let activeField = "line.1.quantity";
let commandId;
const sampleButtons = [...document.querySelectorAll("[data-sample]")];

function el(tag, text, kind) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (kind) node.className = kind;
  return node;
}

function showError(message) {
  $("message").textContent = message || "";
  $("message").hidden = !message;
}

function badge(id, label, mode = "") {
  $(id).textContent = label;
  $(id).className = "tag" + (mode ? " " + mode : "");
}

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  };
  return readResponse(await fetch(path, options));
}

async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "The action could not be completed.");
  }
  return data;
}

function renderFields() {
  const table = el("table", undefined, "field-table");
  const header = el("tr");
  ["Field", "Local OCR", "Vision A", "Decision"].forEach((name) => header.append(el("th", name)));
  const head = el("thead");
  head.append(header);
  table.append(head);
  const body = el("tbody");
  const fieldNames = [...new Set([...focusKeys, ...Object.keys(run.fields).filter(
    (key) => !run.fields[key].confirmed
  )])].filter((key) => key in run.fields);

  for (const key of fieldNames) {
    const field = run.fields[key];
    const row = el("tr");
    row.className = [activeField === key ? "selected" : "", !field.confirmed ? "warning" : ""].join(" ");
    const title = el("td");
    const button = el("button", names[key] || key);
    button.type = "button";
    button.onclick = () => {
      activeField = key;
      renderFields();
    };
    title.append(button);
    const confirmation = field.confirmed ? (field.vision.length ? "Agrees" : "Accepted") :
      overrides[key] ? "Reviewed" : "Review";
    row.append(title, el("td", field.ocr?.value || "—", "mono"),
               el("td", field.vision[0]?.value || "—", "mono"),
               el("td", confirmation, field.confirmed || overrides[key] ? "match" : "conflict"));
    body.append(row);
  }
  table.append(body);
  $("fields").replaceChildren(table);
  const current = run.fields[activeField];
  if (current?.ocr?.bbox) {
    const [left, top, right, bottom] = current.ocr.bbox;
    const scale = [run.image_width, run.image_height];
    [$("bbox").style.left, $("bbox").style.top, $("bbox").style.width, $("bbox").style.height] =
      [left, top, right - left, bottom - top].map((number, index) => number * 100 / scale[index % 2] + "%");
    $("bbox").hidden = false;
    $("active-field").textContent = (names[activeField] || activeField) + " · " + current.ocr.value;
  } else {
    $("bbox").hidden = true;
    $("active-field").textContent = "No verified region";
  }
  const escalation = current?.vision[1];
  const fieldReason = current?.reason_code?.toLowerCase().replaceAll("_", " ");
  const meta = escalation ?
    escalation.reader + " read " + (escalation.value || "no value") +
      (overrides[activeField] ? ". Reviewed." : ". Review still required.") :
    fieldReason && !overrides[activeField] ? fieldReason :
      Object.keys(run.fields).length + " extracted fields · select a field to locate it in the source.";
  $("fields").append(el("div", meta, "field-meta"));
}

function renderReview(unresolved) {
  badge("decision", "Human review", "warn");
  const form = el("form", undefined, "review-fields");
  const conflicts = [];
  for (const key of unresolved) {
    const field = run.fields[key];
    const label = el("label", names[key] || key);
    const input = el("input");
    input.name = key;
    input.required = true;
    input.maxLength = 40;
    input.placeholder = "Read source";
    label.append(input);
    if (field.reason_code === "ROW_AMOUNT_MISMATCH" && field.calculated_amount) {
      const currency = run.fields.currency.confirmed || run.fields.currency.ocr?.value || "";
      const detail = el("p",
        field.initial_reading + " × " + field.unit_price + " = " + field.calculated_amount +
          ". The source line total is " + [currency, field.printed_amount].filter(Boolean).join(" ") + ".",
        "conflict");
      detail.id = "review-detail-" + key;
      input.setAttribute("aria-describedby", detail.id);
      conflicts.push(detail);
    }
    form.append(label);
  }
  const button = el("button", "Validate reviewed fields", "secondary");
  button.type = "submit";
  form.append(button);
  form.onsubmit = async (event) => {
    event.preventDefault();
    showError();
    const edited = Object.fromEntries(new FormData(form));
    const submit = form.querySelector("button");
    setIntakeControls(true);
    submit.disabled = true;
    try {
      await buildPreview(edited);
      overrides = edited;
      $("review").hidden = true;
      renderFields();
      await refreshInbox();
    } catch (error) {
      showError(error.message);
    } finally {
      setIntakeControls(false);
      submit.disabled = false;
    }
  };
  $("review").replaceChildren(el("span", "Confirm the disputed value from the original", "box-head"),
    ...conflicts, form);
  $("review").hidden = false;
}

async function buildPreview(edited = {}) {
  preview = await api("/api/preview", {run_id: run.run_id, overrides: edited});
  renderPreview();
}

function renderPreview() {
  badge("decision", "Draft validated", "good");
  const payload = preview.payload;
  const container = el("div", undefined, "preview-layout");
  const details = el("div", undefined, "mapping");
  details.append(el("span", "Proposed ERP sales order · " + payload.legal_entity, "box-head"));
  for (const row of payload.items) {
    details.append(el("div", row.source_sku + "  ·  " + row.source_quantity + " " +
      row.source_uom + " → " + row.erp_quantity + " " + row.erp_uom));
  }
  details.append(el("strong", payload.currency + " " + payload.total));
  const controls = el("div");
  const approve = el("button", "Approve and queue", "action");
  approve.type = "button";
  approve.disabled = Boolean(commandId);
  if (commandId) approve.textContent = "Approved";
  const label = el("label", undefined, "checkbox");
  const simulate = el("input");
  simulate.type = "checkbox";
  simulate.checked = run.mode === "demo";
  simulate.disabled = Boolean(commandId);
  label.append(simulate, " Simulate a lost reply");
  approve.onclick = async () => {
    showError();
    approve.disabled = true;
    setIntakeControls(true);
    try {
      const response = await api("/api/approve", {
        run_id: run.run_id,
        digest: preview.digest,
        overrides,
        simulate_timeout: simulate.checked,
      });
      commandId = response.command_id;
      approve.textContent = "Approved";
      simulate.disabled = true;
      await refreshCommand();
      await refreshInbox();
    } catch (error) {
      showError(error.message);
      approve.disabled = Boolean(commandId);
    } finally {
      setIntakeControls(false);
    }
  };
  controls.append(approve, label);
  container.append(details, controls);
  $("preview").replaceChildren(container);
  $("preview").hidden = false;
}

async function refreshCommand() {
  const command = await api("/api/commands/" + commandId);
  const isDone = ["COMMITTED", "NEEDS_OPERATOR"].includes(command.status);
  const receiptChanged = command.status === "COMMITTED" && !command.verified_payload;
  $("tick").disabled = isDone;
  badge("command-state", receiptChanged ? "ERP receipt needs review" : stateLabels[command.status] || command.status,
        receiptChanged ? "warn" : command.status === "COMMITTED" ? "good" :
          ["OUTCOME_UNKNOWN", "NEEDS_OPERATOR"].includes(command.status) ? "warn" : "");
  $("ledger-context").textContent = receiptChanged ? "The current ERP draft could not be matched to the receipt." :
    command.status === "COMMITTED" ?
    command.erp_id + " · " + command.matching_erp_drafts + " matching ERP draft · approved payload verified" :
    "Command " + command.id.slice(0, 8) + " · exact snapshot approval";
  const nodes = command.events.map((record) => {
    const kind = "event" + (record.event === "OUTCOME_UNKNOWN" ? " unknown" : "") +
      (record.event === "COMMITTED" ? " done" : "");
    const item = el("div", undefined, kind);
    item.append(el("strong", eventLabels[record.event] || record.event), el("span", record.note));
    return item;
  });
  $("events").replaceChildren(...nodes);
}

function setIntakeControls(disabled) {
  for (const control of [...sampleButtons, $("document"), $("live-vision"),
    $("upload-submit"), $("recent-intakes")]) {
    control.disabled = disabled;
  }
}

async function refreshInbox() {
  const recent = await api("/api/intakes");
  const inbox = $("recent-intakes");
  inbox.replaceChildren(new Option("Open a saved intake", ""));
  for (const intake of recent) {
    const label = stateLabels[intake.status] || intake.status;
    inbox.add(new Option(intake.filename + " · " + label, intake.run_id));
  }
  inbox.value = run?.run_id || "";
}

async function loadIntake(fetchIntake, sample) {
  showError();
  run = undefined;
  preview = undefined;
  commandId = undefined;
  overrides = {};
  activeField = "line.1.quantity";
  $("tick").disabled = true;
  $("events").replaceChildren();
  $("fields").replaceChildren();
  $("review").hidden = true;
  $("preview").hidden = true;
  $("bbox").hidden = true;
  $("source").hidden = true;
  $("source-filename").textContent = "Page 1";
  $("ledger-context").textContent = "Approval creates a durable outbox job.";
  badge("command-state", "Waiting for approval");
  badge("source-status", "Reading");
  badge("decision", "Reading");
  $("reader-mode").textContent = "Loading intake…";
  for (const button of sampleButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.sample === sample));
  }
  setIntakeControls(true);
  try {
    run = await fetchIntake();
    const location = new URL(window.location.href);
    location.searchParams.set("intake", run.run_id);
    window.history.replaceState(null, "", location);
    $("source").src = run.source_url;
    $("source").hidden = false;
    $("source-filename").textContent = run.filename + " · Page 1";
    const calls = run.metrics.vision_calls;
    $("reader-mode").textContent = run.reader_mode + " · " + calls +
      (calls === 1 ? " vision read" : " vision reads");
    badge("source-status", "SHA-256 " + run.artifact_sha256.slice(0, 8));
    commandId = run.command_id;
    preview = run.preview;
    overrides = preview?.overrides || {};
    activeField = run.review_fields[0] || activeField;
    renderFields();
    if (preview) {
      renderPreview();
    } else if (!run.complete) {
      badge("decision", "Unsupported layout", "warn");
    } else if (run.review_fields.length) {
      renderReview(run.review_fields);
    } else {
      await buildPreview();
    }
    if (commandId) await refreshCommand();
    await refreshInbox();
  } catch (error) {
    badge("decision", "Blocked", "warn");
    showError(error.message);
    try {
      await refreshInbox();
    } catch {
      // Keep the original intake error visible.
    }
  } finally {
    setIntakeControls(false);
  }
}

function openSaved(id) {
  return loadIntake(() => api("/api/intakes/" + encodeURIComponent(id)));
}

for (const button of sampleButtons) {
  button.onclick = () => loadIntake(() => api("/api/intake", {sample: button.dataset.sample}),
                                  button.dataset.sample);
}
$("recent-intakes").onchange = (event) => {
  if (event.target.value) openSaved(event.target.value);
};
$("upload-form").onsubmit = async (event) => {
  event.preventDefault();
  const file = $("document").files[0];
  if (!file) return;
  const query = new URLSearchParams({
    filename: file.name,
    mode: $("live-vision").checked ? "vision-on-demand" : "ocr",
  });
  await loadIntake(async () => readResponse(await fetch("/api/intakes/upload?" + query, {
    method: "POST",
    headers: {"Content-Type": "application/octet-stream"},
    body: file,
  })));
  $("document").value = "";
};
$("tick").onclick = async () => {
  $("tick").disabled = true;
  setIntakeControls(true);
  showError();
  try {
    await api("/api/worker/tick", {});
    await refreshCommand();
    await refreshInbox();
  } catch (error) {
    showError(error.message);
    $("tick").disabled = false;
  } finally {
    setIntakeControls(false);
  }
};

const selected = new URLSearchParams(window.location.search).get("intake");
if (selected) {
  openSaved(selected);
} else {
  loadIntake(() => api("/api/intake", {sample: "standard"}), "standard");
}
