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

export interface PendingWorkSnapshot {
  pending_approvals: number;
  pending_approval_ids: string[];
  returned_proposals: number;
  open_submitted: number;
  meetings_today: number;
  unread_notices: number;
  open_exceptions?: number;
}

export interface SuggestedAction {
  id: string;
  label: string;
  command: string;
  kind: "turn" | "navigate" | "email";
  href?: string;
}

export interface EmailDraftResolvedContact {
  subject: string;
  display_name: string;
  email: string;
}

export interface EmailDraftPayload {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  resolved_contacts?: EmailDraftResolvedContact[];
  warnings?: string[];
}

export interface AssistantMessageResult {
  kind: "message";
  reply: string;
  mode: "chat" | "workflow_guidance" | "proactive_reminder" | "email_draft" | "public_search";
  pending_work: PendingWorkSnapshot | null;
  suggested_actions: SuggestedAction[];
  email_draft: EmailDraftPayload | null;
}

export type KnownSecurityEventCategory =
  | "SKILL_TAMPER_ATTEMPT"
  | "PROMPT_TAMPER_ATTEMPT"
  | "DESTRUCTIVE_ACTION_ATTEMPT"
  | "FILESYSTEM_ESCAPE_ATTEMPT"
  | "PROMPT_INJECTION_ATTEMPT"
  | "SECRET_EXFILTRATION_ATTEMPT"
  | "PRIVILEGE_ESCALATION_ATTEMPT"
  | "CROSS_SCOPE_ACCESS_ATTEMPT"
  | "UNAUTHORIZED_MODULE_QUERY"
  | "EMAIL_POLICY_VIOLATION"
  | "OFF_TOPIC_PERSONAL_CHAT"
  | "OFF_TOPIC_LOCAL_AUTOMATION";

export type SecurityEventCategory = KnownSecurityEventCategory | (string & {});

export interface PolicyRefusalResult {
  kind: "refusal";
  category: SecurityEventCategory;
  severity: "medium" | "high" | "critical";
  message: string;
  incident_id: string;
  allowed_modules: string[];
}

export type TurnResult =
  | WorkResult
  | WorkProposal
  | ApprovalPreview
  | Clarification
  | AssistantMessageResult
  | PolicyRefusalResult;

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

export interface ChatReadReceipt {
  subject: string;
  last_read_seq: number;
  read_at: number;
}

export interface ChatReadReceiptUpdateResponse extends ChatReadReceipt {
  room_id: string;
}

export interface ChatReadReceiptPage {
  items: ChatReadReceipt[];
}

export interface ChatMessagePage {
  items: ChatMessage[];
  next: number | null;
  read_receipts?: ChatReadReceipt[];
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
  | "proposal_needs_operator"
  | "email_received"
  | "security_alert";

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
  username?: string;
  email?: string;
  display_name?: string;
  department?: string;
}

export interface DemoPersonasResponse {
  enabled: boolean;
  password_login_enabled?: boolean;
  oidc_login_enabled: boolean;
  personas: DemoPersonaMeta[];
}

export type ContactAvailability = "online" | "busy" | "away" | "offline";

export interface CompanyContact {
  subject: string;
  tenant: string;
  display_name: string;
  default_display_name: string;
  email: string;
  department: string;
  job_title: string;
  role: Role | string;
  warehouses: string[];
  phone?: string;
  ext?: string;
  office?: string;
  availability?: ContactAvailability | (string & {});
  has_avatar: boolean;
  avatar_url: string | null;
  profile_version: number;
  direct_room_id: string | null;
  shared_room_count: number;
}

export interface CompanyContactsResponse {
  tenant: string;
  can_chat: boolean;
  total: number;
  items: CompanyContact[];
}

export type ExternalCalendarTarget = "google" | "icloud" | "outlook";

export interface McpConnectorStatusItem {
  connector: "internal" | "zoom" | "email" | ExternalCalendarTarget;
  connector_id: "internal" | "zoom" | "email" | ExternalCalendarTarget;
  label: string;
  category: "internal" | "meeting" | "calendar" | "email";
  configured: boolean;
  status: "connected" | "sandbox_ready";
  mode:
    | "live_internal"
    | "live_mcp"
    | "live_api"
    | "live_smtp"
    | "governed_outbox"
    | "sandbox_preview"
    | "ics_fallback";
  protocol: string;
  supports_sync: boolean;
  setup_env_keys: string[];
}

export interface McpStatusResponse {
  tenant: string;
  ics_export_url: string;
  connectors: McpConnectorStatusItem[];
}

export interface ZoomBookingAttendee {
  subject: string;
  display_name: string;
  email: string;
  department: string;
}

export type NlMeetingWarningCode =
  | "DEFAULT_NEXT_HOUR"
  | "ROLLED_TO_TOMORROW"
  | "ADJUSTED_15_MIN"
  | "UNRESOLVED_MENTION";

export interface NlMeetingWarningItem {
  code: NlMeetingWarningCode;
  params?: Record<string, string>;
}

export interface ZoomBookingDraft {
  client_id: string;
  title: string;
  title_is_default?: boolean;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  timezone: string;
  room_id: string | null;
  create_zoom: boolean;
  notify_room: boolean;
  calendar_targets: ExternalCalendarTarget[];
  attendees: ZoomBookingAttendee[];
  unresolved_mentions: string[];
}

export interface ZoomBookingPreviewResponse {
  phase: "preview";
  draft: ZoomBookingDraft;
  warnings: string[];
  warning_items?: NlMeetingWarningItem[];
  zoom_configured: boolean;
  zoom_mode_preview: "live_mcp" | "live_api" | "sandbox_preview";
  connectors: McpConnectorStatusItem[];
}

export interface ExternalCalendarSyncResult {
  connector: ExternalCalendarTarget;
  label: string;
  status: "synced" | "unconfigured" | "error";
  external_event_id: string | null;
  message: string;
  message_code?: "SYNCED" | "UNCONFIGURED" | "MCP_ERROR" | "SYNC_FAILED";
  setup_env_keys?: string[];
}

export interface ZoomMeetingResult {
  requested: boolean;
  mode: "live_mcp" | "live_api" | "sandbox_preview" | "error_fallback" | "skipped";
  sync_mode: "live_mcp" | "live_api" | "sandbox_preview" | "error_fallback" | "skipped";
  status_label: string;
  status_code?:
    | "LIVE_MCP_JOIN"
    | "LIVE_MCP_CREATED"
    | "LIVE_API_JOIN"
    | "ERROR_FALLBACK"
    | "SANDBOX_PREVIEW"
    | "SKIPPED";
  join_url: string | null;
  meeting_id: string | null;
  passcode: string | null;
}

export interface BookedCalendarEvent extends CalendarEventDetail {
  room_id: string | null;
}

export interface ZoomBookingConfirmResponse {
  phase: "confirmed";
  mode: "live_mcp" | "live_api" | "sandbox_preview" | "error_fallback";
  sync_mode: "live_mcp" | "live_api" | "sandbox_preview" | "error_fallback";
  status_badge: string;
  event: BookedCalendarEvent;
  internal_event: BookedCalendarEvent;
  zoom: ZoomMeetingResult;
  zoom_meeting: ZoomMeetingResult;
  external_sync: ExternalCalendarSyncResult[];
  calendar_sync_results: ExternalCalendarSyncResult[];
  room_notified: boolean;
  ics_download_url: string;
}

export interface CalendarSyncResponse {
  tenant: string;
  event_id: string | null;
  sync_mode: "live_mcp" | "sandbox_ready" | "partial";
  results: ExternalCalendarSyncResult[];
  ics_download_url: string;
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

export type UiLocale = "zh-CN" | "zh-HK" | "en";

export type UiTheme = "light" | "dark";

export interface DrawerObjectSelection {
  kind: DrawerObjectKind;
  id: string;
  warehouse?: string;
  title?: string;
  meta?: Record<string, unknown>;
}

export type SlashSkillCategory =
  | "workflow"
  | "communication"
  | "governance"
  | "navigation";

export interface SlashSkillItem {
  command: string;
  title: string;
  title_en: string;
  description: string;
  description_en: string;
  category: SlashSkillCategory;
  usage: string;
  requires_args: boolean;
  allowed: boolean;
  required_module: string | null;
  keywords: string[];
}

export interface SlashSkillsResponse {
  items: SlashSkillItem[];
}

export interface WorkAlertItem {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  reference: string | null;
  href: string;
  severity: "info" | "medium" | "high" | "critical";
  created_at: number;
}

export interface WorkPulseResponse {
  pending_approvals: number;
  returned_proposals: number;
  open_submitted: number;
  meetings_today: number;
  unread_notices: number;
  open_security_alerts?: number;
  latest_alerts: WorkAlertItem[];
  as_of: number;
}

export type PromptScopeKey =
  | "general"
  | "orders"
  | "dispatch"
  | "invoice-review"
  | "warehouse-insights"
  | "approvals"
  | "mail-outbox"
  | "calendar-meetings";

export interface PromptPolicyEntry {
  scope_key: PromptScopeKey;
  title: string;
  title_zh: string;
  title_hk: string;
  title_en: string;
  description: string;
  status: "sealed";
  managed_by: "theodic_core_team" | (string & {});
  policy_digest: string;
  rule_count: number;
}

export interface PromptPoliciesResponse {
  sealed: boolean;
  managed_by: "theodic_core_team" | (string & {});
  items: PromptPolicyEntry[];
}

export interface PromptSimulateResponse {
  role: string;
  active_scopes: PromptScopeKey[];
  denied_scopes: PromptScopeKey[];
  sealed: boolean;
  managed_by: "theodic_core_team" | (string & {});
}

export type SecurityEventStatus = "open" | "acknowledged" | "resolved";

export type SecurityEventSeverity = "info" | "medium" | "high" | "critical";

export interface SecurityEventItem {
  id: string;
  subject: string;
  role: string;
  category: SecurityEventCategory;
  severity: SecurityEventSeverity;
  module: string | null;
  action_attempted: string | null;
  decision: "blocked" | "denied" | "flagged" | "escalated";
  summary: string;
  input_sha256: string;
  metadata: Record<string, unknown>;
  status: SecurityEventStatus;
  resolved_by: string | null;
  resolved_at: number | null;
  resolution_note: string | null;
  created_at: number;
}

export interface SecurityEventPage {
  items: SecurityEventItem[];
  next: HistoryCursor | null;
}

export interface SecurityEventsSummary {
  total_open: number;
  by_severity: Record<SecurityEventSeverity, number>;
  by_category: Record<string, number>;
  last_24h_total: number;
}

export type EmailTransportMode = "live_mcp" | "live_smtp" | "governed_outbox";

export type EmailDeliveryStatus =
  | "sent"
  | "queued_governed"
  | "delivered_internal";

export interface EmailOutboxReceipt {
  id: string;
  client_id: string;
  recipients: string[];
  cc: string[];
  subject_line: string;
  body_preview: string;
  transport_mode: EmailTransportMode;
  message_id: string;
  delivery_status: EmailDeliveryStatus;
  created_at: number;
}

export interface EmailOutboxPage {
  items: EmailOutboxReceipt[];
}

export interface EmailParseResponse {
  phase: "preview";
  draft: EmailDraftPayload;
  transport_mode_preview: EmailTransportMode;
  email_configured: boolean;
}

export interface EmailSendResponse {
  phase: "sent";
  receipt: EmailOutboxReceipt;
  transport_mode: EmailTransportMode;
  message_id: string;
  delivery_status: EmailDeliveryStatus;
  accepted: string[];
  rejected: string[];
  warnings: string[];
}

export type EnterpriseChannelId =
  | "whatsapp"
  | "wecom"
  | "feishu"
  | "dingtalk"
  | "slack"
  | "teams"
  | "telegram"
  | "line";

export type ChannelTransportMode =
  | "connected_mcp"
  | "connected_api"
  | "ready_to_bind"
  | "governed_relay";

export interface EnterpriseChannelItem {
  channel_id: EnterpriseChannelId | (string & {});
  name: string;
  name_zh: string;
  name_hk: string;
  region: string;
  protocol: string;
  signature_scheme: string;
  transport_mode: ChannelTransportMode | (string & {});
  configured: boolean;
  webhook_path: string;
  capabilities: string[];
  setup_env_keys: string[];
}

export interface ChannelsCatalogResponse {
  items: EnterpriseChannelItem[];
}

export interface ChannelBindingItem {
  channel_id: EnterpriseChannelId | (string & {});
  subject: string;
  external_user_id: string;
  display_handle: string;
  verified: boolean;
  updated_at: number;
}

export interface ChannelBindingsResponse {
  items: ChannelBindingItem[];
}

export interface UpsertChannelBindingRequest {
  external_user_id: string;
  display_handle: string;
  subject?: string;
  verified?: boolean;
}

export interface ChannelOutboundReceipt {
  id: string;
  client_id: string;
  channel_id: EnterpriseChannelId | (string & {});
  sender_subject?: string;
  target_handle: string;
  body_preview: string;
  body_sha256?: string;
  transport_mode: ChannelTransportMode | (string & {});
  delivery_status: string;
  external_message_id: string;
  created_at: number;
}

export interface ChannelOutboundPage {
  items: ChannelOutboundReceipt[];
}

export interface SendChannelOutboundRequest {
  channel_id: EnterpriseChannelId | (string & {});
  target_handle: string;
  text: string;
  client_id?: string;
}

export interface OffTopicPolicy {
  tenant: string;
  daily_remind_threshold: number;
  daily_escalate_threshold: number;
  seven_day_escalate_threshold: number;
  daily_local_auto_escalate_threshold: number;
  app_allowlist: string[];
  routing_rules: Record<string, string[]>;
  updated_by: string | null;
  updated_at: number | null;
}

export interface OffTopicPolicyUpdatePayload {
  daily_remind_threshold?: number;
  daily_escalate_threshold?: number;
  seven_day_escalate_threshold?: number;
  daily_local_auto_escalate_threshold?: number;
  app_allowlist?: string[];
  routing_rules?: Record<string, string[]>;
}

export type LlmRoutingTier = "T0" | "T1" | "T2" | "T3";

export interface LlmTelemetryBucketMetrics {
  calls: number;
  estimated_usd?: number;
  prompt_tokens?: number;
  cache_hit_tokens?: number;
  reasoning_tokens?: number;
  completion_tokens?: number;
  avg_latency_ms?: number;
  cache_hit_ratio?: number;
}

export type LlmTelemetryBreakdownValue = number | LlmTelemetryBucketMetrics;

export interface LlmTelemetrySummary {
  window_hours: number;
  total_calls: number;
  cache_hit_ratio: number;
  total_prompt_tokens: number;
  total_cache_hit_tokens: number;
  total_reasoning_tokens: number;
  total_completion_tokens: number;
  total_estimated_usd: number;
  avg_latency_ms: number;
  p50_latency_ms?: number;
  p95_latency_ms?: number;
  error_rate?: number;
  failover_count?: number;
  estimated_cache_savings_usd?: number;
  by_tier: Record<LlmRoutingTier, number>;
  by_provider: Record<string, LlmTelemetryBreakdownValue>;
  by_subject: Record<string, LlmTelemetryBreakdownValue>;
}

export interface ProviderCircuitSnapshot {
  provider: string;
  state: "closed" | "open" | "half_open";
  failures: number;
  retry_in_seconds: number;
}

export interface L1CacheSnapshot {
  hits: number;
  misses: number;
  hit_ratio: number;
  entries: number;
  max_entries: number;
  estimated_usd_saved: number;
  tokens_saved: number;
}

export interface SystemHealthSnapshot {
  status: "ok" | "degraded";
  db_engine_mode: string;
  storage_ok: boolean;
  provider_circuits: ProviderCircuitSnapshot[];
  l1_cache: L1CacheSnapshot;
  fallback_configured: boolean;
  active_sse_subscribers: number;
  rate_limit_rejections: number;
  otel_genai_enabled: boolean;
  uptime_seconds: number;
}

export type QuotaScopeType = "tenant" | "role" | "subject" | (string & {});

export interface QuotaPolicyItem {
  scope_type: QuotaScopeType;
  scope_key: string;
  daily_usd_limit: number | null;
  daily_token_limit: number | null;
  updated_by: string | null;
  updated_at: number | null;
}

export interface QuotaPoliciesResponse {
  items: QuotaPolicyItem[];
}

export interface QuotaPolicyUpdatePayload {
  scope_type: QuotaScopeType;
  scope_key: string;
  daily_usd_limit?: number | null;
  daily_token_limit?: number | null;
}

export interface UserMemoryPendingItem {
  id: string;
  fact_text: string;
  section_hint: string;
  source_kind: string;
  created_at: number;
}

export interface UserMemoryState {
  filename: "MEMORY.md";
  content: string;
  version: number;
  token_count: number;
  max_tokens: number;
  max_chars: number;
  updated_by: string | null;
  updated_at: number | null;
  last_tidy_at: number | null;
  has_previous: boolean;
  pending_staged_count: number;
  pending_staged_items: UserMemoryPendingItem[];
}

export interface UserMemoryUpdatePayload {
  version: number;
  content: string;
}

export interface UserMemoryTidyResponse {
  memory: UserMemoryState;
  merged_count: number;
  used_llm: boolean;
  removed_duplicates: number;
}

export interface UserMemoryForgetResponse {
  memory: UserMemoryState;
  removed_lines: number;
}
