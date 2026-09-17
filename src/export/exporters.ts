import type { FieldDefinition, ScrapedRecord } from "../shared/types";

const serialized = (value: ScrapedRecord["values"][string]): string => value === null ? "" : Array.isArray(value) ? value.join(" | ") : String(value);
const csvSafe = (value: string): string => {
  const neutralized = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${neutralized.replace(/"/g, '""')}"`;
};

export const toCsv = (records: ScrapedRecord[], fields: FieldDefinition[], includeMetadata = false): string => {
  const visible = fields.filter((field) => !field.hidden);
  const headers = [...visible.map((field) => field.name), ...(includeMetadata ? ["Source URL", "Captured At", "Batch ID", "Fingerprint"] : [])];
  const rows = records.map((record) => [
    ...visible.map((field) => serialized(record.values[field.id])),
    ...(includeMetadata ? [record.sourceUrl, record.capturedAt, record.batchId, record.fingerprint] : [])
  ]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvSafe).join(",")).join("\r\n")}`;
};

const objectRecord = (record: ScrapedRecord, fields: FieldDefinition[], includeMetadata: boolean) => {
  const data = Object.fromEntries(fields.filter((field) => !field.hidden).map((field) => [field.name, record.values[field.id]]));
  return includeMetadata ? { ...data, _metadata: { sourceUrl: record.sourceUrl, capturedAt: record.capturedAt, batchId: record.batchId, fingerprint: record.fingerprint } } : data;
};

export const toJson = (records: ScrapedRecord[], fields: FieldDefinition[], includeMetadata = false): string =>
  JSON.stringify(records.map((record) => objectRecord(record, fields, includeMetadata)), null, 2);

export const toJsonLines = (records: ScrapedRecord[], fields: FieldDefinition[], includeMetadata = false): string =>
  records.map((record) => JSON.stringify(objectRecord(record, fields, includeMetadata))).join("\n");

export const downloadText = (contents: string, filename: string, mimeType: string): void => {
  const url = URL.createObjectURL(new Blob([contents], { type: `${mimeType};charset=utf-8` }));
  chrome.downloads.download({ url, filename, saveAs: true }, () => setTimeout(() => URL.revokeObjectURL(url), 60_000));
};
