import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ScrapedRecord, SessionState } from "../shared/types";

interface FlowScrapeDB extends DBSchema {
  records: {
    key: string;
    value: ScrapedRecord & { sessionId: string };
    indexes: { "by-session": string; "by-batch": [string, string] };
  };
  sessions: { key: string; value: SessionState };
}

let database: Promise<IDBPDatabase<FlowScrapeDB>> | undefined;

const db = () => {
  database ??= openDB<FlowScrapeDB>("flowscrape", 1, {
    upgrade(database) {
      const records = database.createObjectStore("records", { keyPath: "id" });
      records.createIndex("by-session", "sessionId");
      records.createIndex("by-batch", ["sessionId", "batchId"]);
      database.createObjectStore("sessions", { keyPath: "id" });
    }
  });
  return database;
};

export const sessionRepository = {
  async saveSession(session: SessionState) { await (await db()).put("sessions", session); },
  async getSession(id: string) { return (await db()).get("sessions", id); },
  async addRecords(sessionId: string, records: ScrapedRecord[]) {
    const transaction = (await db()).transaction("records", "readwrite");
    await Promise.all(records.map((record) => transaction.store.put({ ...record, sessionId })));
    await transaction.done;
  },
  async getRecords(sessionId: string) {
    const rows = await (await db()).getAllFromIndex("records", "by-session", sessionId);
    return rows.map((row) => {
      const record: Partial<typeof row> = { ...row };
      delete record.sessionId;
      return record as ScrapedRecord;
    });
  },
  async removeBatch(sessionId: string, batchId: string) {
    const database = await db();
    const keys = await database.getAllKeysFromIndex("records", "by-batch", IDBKeyRange.only([sessionId, batchId]));
    const transaction = database.transaction("records", "readwrite");
    await Promise.all(keys.map((key) => transaction.store.delete(key)));
    await transaction.done;
  },
  async clear(sessionId: string) {
    const database = await db();
    const keys = await database.getAllKeysFromIndex("records", "by-session", sessionId);
    const transaction = database.transaction(["records", "sessions"], "readwrite");
    await Promise.all(keys.map((key) => transaction.objectStore("records").delete(key)));
    await transaction.objectStore("sessions").delete(sessionId);
    await transaction.done;
  }
};
