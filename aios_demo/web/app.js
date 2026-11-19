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
  QUEUED: "Queued",
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
  const response = await fetch(path, options);
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
    const confirmation = field.confirmed ? "Agrees" : overrides[key] ? "Reviewed" : "Review";
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
  const meta = escalation ?
    escalation.reader + " read " + (escalation.value || "no value") + ". Review still required." :
    Object.keys(run.fields).length + " extracted fields · select a field to locate it in the source.";
  $("fields").append(el("div", meta, "field-meta"));
}

function renderReview(unresolved) {
  badge("decision", "Human review", "warn");
  const form = el("form", undefined, "review-fields");
  for (const key of unresolved) {
    const label = el("label", names[key] || key);
    const input = el("input");
    input.name = key;
    input.required = true;
    input.maxLength = 40;
    input.placeholder = "Read source";
    label.append(input);
    form.append(label);
  }
  const button = el("button", "Validate reviewed fields", "secondary");
  button.type = "submit";
  form.append(button);
  form.onsubmit = async (event) => {
    event.preventDefault();
    showError();
    const edited = Object.fromEntries(new FormData(form));
    try {
      await buildPreview(edited);
      overrides = edited;
      $("review").hidden = true;
      renderFields();
    } catch (error) {
      showError(error.message);
    }
  };
  $("review").replaceChildren(el("span", "Confirm the disputed value from the original", "box-head"), form);
  $("review").hidden = false;
}

async function buildPreview(edited = {}) {
  preview = await api("/api/preview", {run_id: run.run_id, overrides: edited});
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
  const label = el("label", undefined, "checkbox");
  const simulate = el("input");
  simulate.type = "checkbox";
  simulate.checked = true;
  label.append(simulate, " Simulate a lost reply");
  approve.onclick = async () => {
    showError();
    approve.disabled = true;
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
    } catch (error) {
      showError(error.message);
      approve.disabled = false;
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
  $("tick").disabled = isDone;
  badge("command-state", stateLabels[command.status] || command.status,
        command.status === "COMMITTED" ? "good" :
          ["OUTCOME_UNKNOWN", "NEEDS_OPERATOR"].includes(command.status) ? "warn" : "");
  $("ledger-context").textContent = command.status === "COMMITTED" ?
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

async function load(sample) {
  showError();
  commandId = undefined;
  overrides = {};
  activeField = "line.1.quantity";
  $("tick").disabled = true;
  $("events").replaceChildren();
  $("fields").replaceChildren();
  $("review").hidden = true;
  $("preview").hidden = true;
  $("bbox").hidden = true;
  $("ledger-context").textContent = "Approval creates a durable outbox job.";
  badge("command-state", "Waiting for approval");
  badge("source-status", "Reading");
  badge("decision", "Reading");
  $("reader-mode").textContent = "Running local OCR…";
  $("source").src = "/sample/" + sample;
  const buttons = [...document.querySelectorAll("[data-sample]")];
  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.sample === sample));
    button.disabled = true;
  }
  try {
    run = await api("/api/intake", {sample});
    $("reader-mode").textContent = "Tesseract OCR + " + run.reader_mode;
    badge("source-status", "SHA-256 " + run.artifact_sha256.slice(0, 8));
    renderFields();
    const unresolved = Object.keys(run.fields).filter((key) => !run.fields[key].confirmed);
    if (!run.complete) {
      badge("decision", "Request a new source", "warn");
    } else if (unresolved.length) {
      renderReview(unresolved);
    } else {
      await buildPreview();
    }
  } catch (error) {
    badge("decision", "Blocked", "warn");
    showError(error.message);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

for (const button of document.querySelectorAll("[data-sample]")) {
  button.onclick = () => load(button.dataset.sample);
}
$("tick").onclick = async () => {
  $("tick").disabled = true;
  showError();
  try {
    await api("/api/worker/tick", {});
    await refreshCommand();
  } catch (error) {
    showError(error.message);
    $("tick").disabled = false;
  }
};
load("standard");
