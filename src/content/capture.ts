import type { CollectionCandidate, FieldDefinition, ScrapedRecord } from "../shared/types";
import { debounce, makeId, requestIdle } from "../shared/utils";
import { extractRecord, isIncomplete } from "./extractor";
import { safeQueryAll } from "./dom";

interface BatchResult { records: ScrapedRecord[]; duplicateCount: number; incompleteCount: number }

export class CaptureController {
  private observer?: MutationObserver;
  private intersection?: IntersectionObserver;
  private container?: Element;
  private fields: FieldDefinition[] = [];
  private candidate?: CollectionCandidate;
  private seen = new Set<string>();
  private paused = false;
  private stopped = false;
  private total = 0;
  private retryCounts = new WeakMap<Element, number>();
  private pending = new Set<Element>();
  private pendingSnapshots: Array<{ record: ScrapedRecord; element: Element }> = [];
  private readonly schedule = debounce(() => requestIdle(() => this.flush()), 80);

  constructor(private readonly maxRecords: number, private readonly onBatch: (batch: BatchResult) => void) {}

  start(candidate: CollectionCandidate, fields: FieldDefinition[]): void {
    this.stop();
    this.stopped = false;
    this.paused = false;
    this.candidate = candidate;
    this.fields = fields;
    this.container = safeQueryAll(document, candidate.containerSelector)[0];
    if (!this.container) throw new Error("The selected collection is no longer present on this page.");
    this.items().forEach((element) => this.pending.add(element));
    // Establish the initial baseline before virtualized nodes can be recycled.
    // Remaining items beyond the bounded flush continue through idle batches.
    this.flush();
    this.observer = new MutationObserver((mutations) => {
      if (this.paused || this.stopped) return;
      const affected = new Set<Element>();
      const itemSelector = candidate.itemSelector.replace(":scope > ", "");
      for (const mutation of mutations) {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        const targetItem = target?.closest(itemSelector);
        if (targetItem && this.container?.contains(targetItem)) affected.add(targetItem);
        for (const node of Array.from(mutation.addedNodes)) {
          const element = node instanceof Element ? node : node.parentElement;
          if (!element) continue;
          const ownerItem = element.closest(itemSelector);
          if (ownerItem && this.container?.contains(ownerItem)) affected.add(ownerItem);
          if (element.matches(itemSelector)) affected.add(element);
          safeQueryAll(element, itemSelector).forEach((item) => affected.add(item));
        }
      }
      const snapshotId = makeId("snapshot");
      for (const element of Array.from(affected).slice(0, 300)) {
        if (this.pendingSnapshots.length >= 1_000) this.pendingSnapshots.shift();
        this.pendingSnapshots.push({ record: extractRecord(element, this.fields, snapshotId), element });
      }
      this.schedule();
    });
    this.observer.observe(this.container, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["src", "href", "data-id", "data-key"] });
    this.intersection = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) this.queue(this.items());
    }, { rootMargin: "600px" });
    this.items().forEach((item) => this.intersection?.observe(item));
    addEventListener("scroll", this.handleViewport, { passive: true });
    addEventListener("resize", this.handleViewport, { passive: true });
  }

  private items(): Element[] { return this.container && this.candidate ? safeQueryAll(this.container, this.candidate.itemSelector) : []; }
  private readonly handleViewport = debounce(() => { if (!this.paused) this.queue(this.items()); }, 150);
  private queue(elements: Element[]) { elements.forEach((element) => this.pending.add(element)); this.schedule(); }

  private flush(): void {
    if (this.paused || this.stopped || !this.fields.length) return;
    const batchId = makeId("batch");
    const records: ScrapedRecord[] = [];
    let duplicateCount = 0;
    let incompleteCount = 0;
    const snapshots = this.pendingSnapshots.splice(0, 300);
    const snapshottedElements = new Set(snapshots.map((snapshot) => snapshot.element));
    const elements = Array.from(this.pending).filter((element) => !snapshottedElements.has(element)).slice(0, Math.max(0, 300 - snapshots.length));
    elements.forEach((element) => this.pending.delete(element));
    const accept = (record: ScrapedRecord, element: Element) => {
      if (this.total >= this.maxRecords) return;
      record.batchId = batchId;
      if (isIncomplete(record, this.fields)) {
        incompleteCount += 1;
        const retries = this.retryCounts.get(element) ?? 0;
        if (retries < 3) {
          this.retryCounts.set(element, retries + 1);
          setTimeout(() => this.queue([element]), 300 * (retries + 1));
        }
      }
      if (this.seen.has(record.fingerprint)) { duplicateCount += 1; return; }
      this.seen.add(record.fingerprint);
      records.push(record);
      this.total += 1;
    };
    for (const snapshot of snapshots) {
      if (snapshot.element.isConnected) accept(snapshot.record, snapshot.element);
    }
    for (const element of elements) {
      if (!element.isConnected || this.total >= this.maxRecords) continue;
      accept(extractRecord(element, this.fields, batchId), element);
    }
    if (records.length || duplicateCount || incompleteCount) this.onBatch({ records, duplicateCount, incompleteCount });
    if (this.pending.size) this.schedule();
  }

  updateFields(fields: FieldDefinition[]) { this.fields = fields; this.queue(this.items()); }
  pause() { this.paused = true; }
  resume() { this.paused = false; this.queue(this.items()); }
  stop() {
    this.stopped = true;
    this.observer?.disconnect();
    this.intersection?.disconnect();
    this.observer = undefined;
    this.intersection = undefined;
    this.schedule.cancel();
    this.handleViewport.cancel();
    removeEventListener("scroll", this.handleViewport);
    removeEventListener("resize", this.handleViewport);
    this.pending.clear();
    this.pendingSnapshots = [];
    this.container = undefined;
  }
}
