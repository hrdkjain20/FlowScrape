import type { AiCleanupResult, AiStatus, CollectionCandidate, FieldDefinition, ScrapedRecord, SessionState, Settings } from "./types";

export type PanelToWorkerMessage =
  | { type: "PANEL_CONNECT" }
  | { type: "DETECT" }
  | { type: "START_CAPTURE"; candidateId: string; fields: FieldDefinition[] }
  | { type: "START_POINT_SELECT" }
  | { type: "START_FIELD_SELECT"; fieldId: string; candidateId: string; fields: FieldDefinition[] }
  | { type: "CANCEL_SELECT" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "STOP" }
  | { type: "UNDO" }
  | { type: "CLEAR" }
  | { type: "GET_RECORDS" }
  | { type: "UPDATE_FIELDS"; fields: FieldDefinition[] }
  | { type: "SETTINGS_UPDATE"; settings: Settings }
  | { type: "AI_SAVE_KEY"; key: string; persistent: boolean }
  | { type: "AI_DELETE_KEY" }
  | { type: "AI_TEST" }
  | { type: "AI_CLEAN"; instruction: string; fields: FieldDefinition[] }
  | { type: "AI_CANCEL" };

export type WorkerToContentMessage =
  | { type: "CONTENT_PING" }
  | { type: "CONTENT_DETECT" }
  | { type: "CONTENT_START"; candidate: CollectionCandidate; fields: FieldDefinition[]; maxRecords: number }
  | { type: "CONTENT_POINT_SELECT" }
  | { type: "CONTENT_FIELD_SELECT"; fieldId: string; candidate: CollectionCandidate }
  | { type: "CONTENT_CANCEL_SELECT" }
  | { type: "CONTENT_PAUSE" }
  | { type: "CONTENT_RESUME" }
  | { type: "CONTENT_STOP" }
  | { type: "CONTENT_UPDATE_FIELDS"; fields: FieldDefinition[] };

export type ContentToWorkerMessage =
  | { type: "CONTENT_READY"; page: SessionState["page"] }
  | { type: "DETECTION_RESULT"; candidates: CollectionCandidate[]; page: SessionState["page"] }
  | { type: "CAPTURE_BATCH"; records: ScrapedRecord[]; duplicateCount: number; incompleteCount: number }
  | { type: "POINT_SELECTED"; candidate: CollectionCandidate }
  | { type: "FIELD_SELECTED"; fieldId: string; selector: string; suggestedType: FieldDefinition["type"]; attribute?: string }
  | { type: "CONTENT_ERROR"; error: string };

export type WorkerToPanelMessage =
  | { type: "STATE"; state: SessionState | null }
  | { type: "RECORDS"; records: ScrapedRecord[] }
  | { type: "SETTINGS"; settings: Settings }
  | { type: "AI_STATUS"; status: AiStatus }
  | { type: "AI_CLEAN_RESULT"; result: AiCleanupResult }
  | { type: "NOTICE"; message: string };

export type RuntimeMessage = PanelToWorkerMessage | WorkerToContentMessage | ContentToWorkerMessage;

export const isRuntimeMessage = (value: unknown): value is RuntimeMessage => {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && type.length < 64;
};
