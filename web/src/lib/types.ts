export type Role = "viewer" | "operator" | "manager" | "admin";

export type Grant =
  | "shipment.read"
  | "shipment.reschedule"
  | "order.read"
  | "order.work"
  | "finance.read"
  | "mail.read"
  | "decision.read"
  | "chat.use"
  | "operations.manage"
  | "workbench.access.manage"
  | "workbench.approve.orders"
  | "workbench.approve.shipments"
  | "assurance.purchase"
  | "assurance.incoming"
  | "assurance.contract"
  | "assurance.procurement"
  | "assurance.finance"
  | "assurance.quality"
  | "assurance.legal"
  | "assurance.audit";

export interface Actor {
  subject: string;
  tenant: string;
  role: Role;
  warehouses: string[];
  grants: Grant[];
}

export type ToolMode = "read" | "proposal";

export type ToolSource =
  | "synthetic"
  | "erp"
  | "finance"
  | "mail"
  | "decision"
  | "unconfigured"
  | "internal";

export type WorkbenchToolId =
  | "shipment.read"
  | "shipment.reschedule"
  | "order.draft.prepare"
  | "finance.invoice.read"
  | "mail.inbox.read"
  | "decision.warehouse.summary";

export interface ToolCapability {
  id: WorkbenchToolId | (string & {});
  mode: ToolMode;
  available: boolean;
  source: ToolSource | (string & {});
  warehouses: string[];
}

export interface Capabilities {
  tools: ToolCapability[];
  order_read_warehouses: string[];
  approval_warehouses: {
    "sales_order.create_draft": string[];
    "shipment.reschedule": string[];
  };
  chat_available: boolean;
}

export type ProposalState =
  | "PROPOSED"
  | "QUEUED"
  | "SENDING"
  | "VERIFYING"
  | "OUTCOME_UNKNOWN"
  | "CHECKING"
  | "VERIFIED"
  | "REJECTED"
  | "NEEDS_OPERATOR";

export const NON_TERMINAL_PROPOSAL_STATES: ReadonlySet<ProposalState> = new Set([
  "QUEUED",
  "SENDING",
  "VERIFYING",
  "CHECKING",
  "OUTCOME_UNKNOWN",
]);

export const TERMINAL_PROPOSAL_STATES: ReadonlySet<ProposalState> = new Set([
  "VERIFIED",
  "REJECTED",
  "NEEDS_OPERATOR",
]);

export type ProposalAction = "sales_order.create_draft" | "shipment.reschedule";

export interface SalesOrderLinePlan {
  sku: string;
  source_sku: string;
  source_quantity: number;
  source_uom: string;
  erp_quantity: number;
  erp_uom: string;
  line_total: string;
}

export interface SalesOrderPlanBefore {
  intake_id: string;
  source_sha256: string;
}

export interface SalesOrderPlanAfter {
  po: string;
  buyer: string;
  currency: string;
  legal_entity: string;
  delivery: string;
  total: string;
  items: SalesOrderLinePlan[];
}

export interface ShipmentView {
  shipment_id: string;
  warehouse: string;
  delivery_date: string;
  version: number;
  status: "OPEN" | "CLOSED" | (string & {});
}

export interface ShipmentReschedulePlanAfter {
  delivery_date: string;
}

export interface Plan {
  tenant: string;
  warehouse: string;
  action: ProposalAction;
  target: string;
  expected_version: number | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface Receipt {
  tenant: string;
  operation_id: string;
  plan_digest: string;
  target: string;
  remote_id: string;
}

export interface AuditEvent {
  subject: string;
  event: string;
  at: number;
}

export interface ProposalReview {
  assigned_to: string | null;
  decided_by: string | null;
  decision: "returned" | "rejected" | null;
  reason: string | null;
}

export interface Proposal {
  tenant: string;
  id: string;
  warehouse: string;
  requester: string;
  approver: string | null;
  digest: string;
  plan: Plan;
  state: ProposalState;
  epoch: number;
  checks: number;
  due: number;
  expires: number;
  receipt: Receipt | null;
  events: AuditEvent[];
  review: ProposalReview | null;
}

export interface InvoiceView {
  invoice_id: string;
  warehouse: string;
  currency: string;
  amount: string;
  state: "OPEN" | "PAID" | "VOID" | (string & {});
}

export interface MailMessageHeader {
  id: string;
  sender: string;
  subject: string;
}

export interface MailInboxView {
  messages: MailMessageHeader[];
}

export interface WarehouseDecisionSummary {
  warehouse: string;
  open_shipments: number;
  as_of: string;
}

export interface WorkResult {
  kind: "result";
  tool: WorkbenchToolId | (string & {});
  source: ToolSource | (string & {});
  data:
    | ShipmentView
    | InvoiceView
    | MailInboxView
    | WarehouseDecisionSummary
    | Record<string, unknown>;
}

export interface WorkProposal {
  kind: "proposal";
  tool: WorkbenchToolId | (string & {});
  proposal: Proposal;
}

export interface ApprovalPreview {
  kind: "approval_preview";
  proposal: Proposal;
}

export interface Clarification {
  kind: "clarification";
  question: string;
}

export type TurnResult =
  | WorkResult
  | WorkProposal
  | ApprovalPreview
  | Clarification;

export type WorkbenchToolCall =
  | { tool: "shipment.read"; warehouse: string; shipment_id: string }
  | {
      tool: "shipment.reschedule";
      warehouse: string;
      shipment_id: string;
      delivery_date: string;
    }
  | { tool: "order.draft.prepare"; warehouse: string; intake_id: string }
  | { tool: "finance.invoice.read"; warehouse: string; invoice_id: string }
  | { tool: "mail.inbox.read"; limit?: number }
  | { tool: "decision.warehouse.summary"; warehouse: string };

export interface HistoryListItem {
  id: string;
  started_at: number;
}

export interface HistoryCursor {
  before_at: number;
  before_id: string;
}

export interface HistoryPage {
  items: HistoryListItem[];
  next: HistoryCursor | null;
}

export type TaskLane = "assigned" | "submitted";

export interface DueCursor {
  after_due: number;
  after_id: string;
}

export interface TaskItem {
  id: string;
  warehouse: string;
  state: ProposalState;
  expires: number;
  due: number;
  action: ProposalAction;
  decision?: "returned" | "rejected" | null;
  assigned_to?: string | null;
}

export interface TaskPage {
  items: TaskItem[];
  next: DueCursor | null;
}

export interface ApprovalItem {
  id: string;
  warehouse: string;
  state: "PROPOSED";
  expires: number;
  due: number;
  action: ProposalAction;
}

export interface ApprovalPage {
  items: ApprovalItem[];
  next: DueCursor | null;
}

export interface BatchApprovalResultItem {
  proposal_id: string;
  status: number;
  detail?: unknown;
}

export interface BatchApprovalResponse {
  items: BatchApprovalResultItem[];
}

export interface OcrFieldReading {
  value: string | null;
  source?: string;
  bbox?: [number, number, number, number] | null;
  score?: number | null;
}

export interface OcrFieldEvidence {
  ocr: OcrFieldReading | null;
  vision: Array<{ value: string | null; source?: string; confidence?: number }>;
  confirmed: string | null;
  reason_code: string | null;
}

export interface OcrEvidence {
  kind?: "image";
  schema_version: number;
  mode: "ocr" | "vision-on-demand" | (string & {});
  reader_mode: string;
  artifact_sha256: string;
  image_width: number;
  image_height: number;
  rows: number;
  complete: boolean;
  status: "ready_for_preview" | "needs_review" | (string & {});
  review_fields: string[];
  metrics: { vision_calls: number };
  fields: Record<string, OcrFieldEvidence>;
}

export interface PurchaseOrderLine {
  sku: string;
  unit: string;
  quantity: number;
  unit_price: string;
  amount: string;
}

export interface PurchaseOrder {
  po: string;
  buyer: string;
  currency: string;
  delivery: string;
  total: string;
  lines: PurchaseOrderLine[];
}

export interface StructuredIntakeEvidence {
  kind: "structured";
  order: PurchaseOrder;
  artifact_sha256: string;
}

export interface ImageIntakeUploadResponse {
  intake_id: string;
  warehouse: string;
  evidence: OcrEvidence;
}

export interface StructuredIntakeResponse {
  intake_id: string;
  warehouse: string;
}

export interface IntakeDetail {
  warehouse: string;
  evidence: StructuredIntakeEvidence | (OcrEvidence & { kind: "image" });
}

export interface BatchIntakePreparedItem {
  position: number;
  status: "prepared";
  intake_id: string;
  proposal_id: string;
  digest: string;
  state: ProposalState;
}

export interface BatchIntakeReviewItem {
  position: number;
  status: "review";
  code:
    | "INVALID_ORDER"
    | "CONFLICTING_ORDER_REVISIONS"
    | "CURRENCY_OR_WAREHOUSE_UNSUPPORTED"
    | "ORDER_LIMIT_EXCEEDED"
    | "MAPPING_MISSING"
    | "LINE_AMOUNT_MISMATCH"
    | "ORDER_TOTAL_MISMATCH"
    | "POLICY_DENIED"
    | (string & {});
  intake_id?: string;
  fields?: Array<{ field: string; code: string }>;
}

export type BatchIntakeItem = BatchIntakePreparedItem | BatchIntakeReviewItem;

export interface BatchIntakeResponse {
  items: BatchIntakeItem[];
}

export type ActionResponse =
  | { status: "clarify"; question: string }
  | { status: "read"; shipment: ShipmentView }
  | ({ status: "proposed" } & Proposal);

export type ModuleAccessId =
  | "orders"
  | "dispatch"
  | "invoice-review"
  | "warehouse-insights"
  | "approvals";

export interface ModuleCatalogEntry {
  grants: Grant[];
  roles: Role[] | null;
}

export interface ModuleAccessCatalog {
  modules: Record<string, ModuleCatalogEntry>;
  warehouses: string[];
}

export interface ModuleAssignment {
  version: number;
  grants: Grant[];
  warehouses: string[];
  expires_at?: number | null;
}

export interface EmployeeModulesResponse {
  assignments: Record<string, ModuleAssignment>;
}

export interface EmployeeDirectoryPage {
  items: string[];
  next: string | null;
}

export interface Profile {
  display_name: string | null;
  version: number;
  has_avatar: boolean;
}

export type AgentProfile = Profile;

export interface ChatRoom {
  id: string;
  title: string;
  owner: string;
}

export interface ChatRoomPage {
  items: ChatRoom[];
  next: string | null;
}

export interface ChatMemberPage {
  items: string[];
  next: string | null;
}

export interface ChatMessage {
  seq: number;
  author: string;
  text: string;
  created_at: number;
}

export interface ChatMessagePage {
  items: ChatMessage[];
  next: number | null;
}

export interface CalendarEvent {
  id: string;
  organizer: string;
  title: string;
  starts_at: number;
  ends_at: number;
  revision: number;
  cancelled: boolean;
  source: "internal";
}

export interface CalendarEventDetail extends CalendarEvent {
  attendees: string[];
}

export interface CalendarCursor {
  after_start: number;
  after_id: string;
}

export interface CalendarEventPage {
  items: CalendarEvent[];
  next: CalendarCursor | null;
}

export type NoticeKind =
  | "meeting_created"
  | "meeting_changed"
  | "meeting_cancelled"
  | "proposal_assigned"
  | "proposal_returned"
  | "proposal_rejected"
  | "proposal_approved"
  | "proposal_verified"
  | "proposal_needs_operator";

export interface NoticeSummary {
  id: string;
  created_at: number;
  read_at: number | null;
}

export interface NoticePage {
  items: NoticeSummary[];
  next: HistoryCursor | null;
}

export interface NoticeDetail {
  kind: NoticeKind;
  reference: string;
  created_at: number;
  read_at: number | null;
}

export interface BriefResponse {
  start: string;
  end: string;
  meetings: number;
  pending_approvals: number;
  pending_approvals_capped: boolean;
  submitted_current_states: Record<string, number>;
  as_of: number;
}

export interface OperationsSummary {
  proposals_by_state: Record<string, number>;
  writes_paused: boolean;
}

export interface ExceptionItem {
  proposal_id: string;
  warehouse: string;
  state: "NEEDS_OPERATOR" | "OUTCOME_UNKNOWN";
  due: number;
  checks: number;
  last_event: string | null;
}

export interface ExceptionPage {
  items: ExceptionItem[];
  next: DueCursor | null;
}

export type AssuranceKind = "purchase" | "incoming_quality" | "contract";

export type AssuranceTrack = "procurement" | "finance" | "quality" | "legal";

export type AssuranceState = "PENDING" | "HELD" | "APPROVED" | "REJECTED";

export interface AssuranceCaseSummary {
  id: string;
  kind: AssuranceKind;
  site: string;
  revision: string;
  submitted_at: number | null;
}

export interface AssuranceCasePage {
  items: AssuranceCaseSummary[];
  next: string | null;
}

export interface AssuranceCaseDetail {
  id: string;
  kind: AssuranceKind;
  site: string;
  revision: string;
  policy: string;
  fields: Record<string, string | number | boolean>;
}

export interface AssuranceTrackDecision {
  actor: string;
  action: "approve" | "reject";
}

export interface AssuranceReview {
  id: string;
  case_id: string;
  site: string;
  requester: string;
  state: AssuranceState;
  snapshot: string;
  kind: AssuranceKind;
  revision: string;
  policy: string;
  tracks: AssuranceTrack[];
  rule_findings: string[];
  model_findings: string[];
  run_id: string;
  decisions: Partial<Record<AssuranceTrack, AssuranceTrackDecision>>;
  stale: boolean;
  expires_at: number | null;
  expired: boolean;
}

export interface AssuranceReviewPage {
  items: AssuranceReview[];
  next: string | null;
}

export interface AssuranceCheckpoint {
  type: string;
  tenant: string;
  seq: number;
  hash: string;
  key_id: string;
  signature: string;
}

export type DemoPersonaId =
  | "operator"
  | "manager"
  | "finance"
  | "access-admin"
  | "admin"
  | "other-manager"
  | "island-manager"
  | "viewer"
  | "quality"
  | "legal"
  | "executive";

export interface DemoPersonaMeta {
  subject: DemoPersonaId;
  tenant: string;
  role: Role;
  warehouses: string[];
  label: string;
  summary: string;
  group: "core" | "specialist" | "isolation";
}

export interface DemoPersonasResponse {
  enabled: boolean;
  oidc_login_enabled: boolean;
  personas: DemoPersonaMeta[];
}

export interface FieldValidationError {
  loc: Array<string | number>;
  msg: string;
  type?: string;
}

export interface NormalizedApiError {
  status: number;
  code: string;
  message: string;
  requestId: string | null;
  retryAfter: number | null;
  fieldErrors: FieldValidationError[];
  nextStep: string | null;
  viewProposalId: string | null;
  allowedActions: string[];
  warehouses: string[];
  runId: string | null;
}

export type DrawerTab = "assigned" | "submitted" | "current";

export type DrawerObjectKind =
  | "proposal"
  | "intake"
  | "invoice"
  | "shipment"
  | "assurance"
  | "summary"
  | "brief"
  | "calendar"
  | "room-members"
  | "meeting-draft";

export interface DrawerObjectSelection {
  kind: DrawerObjectKind;
  id: string;
  warehouse?: string;
  title?: string;
  meta?: Record<string, unknown>;
}
