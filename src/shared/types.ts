export type FieldType =
  | "text"
  | "number"
  | "price"
  | "date"
  | "url"
  | "image"
  | "email"
  | "phone"
  | "attribute"
  | "html";

export interface FieldDefinition {
  id: string;
  name: string;
  selector: string;
  /** Ordered fallbacks used when responsive/variant markup changes between records. */
  selectors?: string[];
  type: FieldType;
  attribute?: string;
  /** Optional safe RegExp source applied to the selected element's public text. */
  pattern?: string;
  patternFlags?: string;
  multiple: boolean;
  required: boolean;
  hidden?: boolean;
  explanation?: string;
  confidence?: number;
}

export type FieldValue = string | number | string[] | null;

export interface ScrapedRecord {
  id: string;
  values: Record<string, FieldValue>;
  originalValues?: Record<string, string | string[] | null>;
  sourceUrl: string;
  capturedAt: string;
  batchId: string;
  fingerprint: string;
}

export interface CollectionCandidate {
  id: string;
  name: string;
  itemSelector: string;
  containerSelector: string;
  itemCount: number;
  score: number;
  explanation: string;
  fields: FieldDefinition[];
  frame?: string;
}

export type CaptureStatus = "idle" | "detecting" | "ready" | "selecting" | "capturing" | "paused" | "stopped" | "error";

export interface PageInfo {
  url: string;
  title: string;
  hostname: string;
  inaccessibleFrames: number;
  limitations: string[];
}

export interface CaptureStats {
  total: number;
  duplicates: number;
  incomplete: number;
  batches: number;
}

export interface SessionState {
  id: string;
  tabId: number;
  status: CaptureStatus;
  page: PageInfo;
  candidates: CollectionCandidate[];
  selectedCandidateId?: string;
  fields: FieldDefinition[];
  stats: CaptureStats;
  createdAt: string;
  updatedAt: string;
  warning?: string;
  error?: string;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  maxRecords: number;
  blockedDomains: string[];
  includeMetadata: boolean;
  aiModel: "openai/gpt-oss-20b" | "openai/gpt-oss-120b";
  aiCachePlans: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  maxRecords: 50_000,
  blockedDomains: [],
  includeMetadata: false,
  aiModel: "openai/gpt-oss-20b",
  aiCachePlans: true
};

export type AiCleanupOperation = "copy" | "first_nonempty" | "concat" | "regex";

export interface AiPlanField {
  name: string;
  type: FieldType;
  sources: string[];
  operation: AiCleanupOperation;
  pattern: string;
  multiple: boolean;
  reason: string;
  confidence: number;
}

export interface AiCleanupPlan {
  recordType: string;
  fields: AiPlanField[];
  droppedSources: string[];
  deduplicateBy: string[];
  summary: string;
}

export interface AiStatus {
  configured: boolean;
  persistent: boolean;
  testing: boolean;
  cleaning: boolean;
  model: Settings["aiModel"];
  lastError?: string;
}

export interface AiCleanupResult {
  fields: FieldDefinition[];
  records: ScrapedRecord[];
  plan: AiCleanupPlan;
  originalCount: number;
  cleanedCount: number;
  cacheHit: boolean;
}

export const isRestrictedUrl = (url: string): boolean =>
  /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(url) || /^https?:\/\/chrome\.google\.com\/webstore/i.test(url);

export const isSensitiveSite = (hostname: string): boolean =>
  /(^|\.)(bank|banking|paypal|stripe|checkout|wallet|auth|login)\b/i.test(hostname);
