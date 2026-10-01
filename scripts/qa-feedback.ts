import { buildSafeOutput, wrapUntrustedField } from "@local/cli-utils";
import { createHash } from "node:crypto";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 25;
const CUSTOM_PROPS_MAX_CHARS = 8_000;
const NESTED_MAX_DEPTH = 8;
const NESTED_KEY_MAX_CHARS = 200;

interface FeedbackPage {
  data?: unknown;
}

export interface QaFeedbackClient {
  listFeedback(options: {
    page?: number;
    perPage?: number;
    campaignId?: string;
    sort?: "asc" | "desc";
  }): Promise<FeedbackPage>;
}

export interface QaFeedbackOptions {
  since?: string;
  until?: string;
  campaignId?: string;
  sort?: "asc" | "desc";
  pageSize?: number;
  maxPages?: number;
}

type DateField = "created_date" | "createdDate" | "created_at";

interface SelectedDate {
  field: DateField;
  raw: unknown;
  timestamp: number | null;
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function selectFeedbackDate(record: Record<string, unknown>): SelectedDate | null {
  let field: DateField | null = null;
  if (hasOwn(record, "created_date")) field = "created_date";
  else if (hasOwn(record, "createdDate")) field = "createdDate";
  else if (hasOwn(record, "created_at")) field = "created_at";
  if (field === null) return null;

  const raw = record[field];
  const timestamp = parseIsoTimestamp(raw);
  return {
    field,
    raw,
    timestamp,
  };
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseIsoTimestamp(value: unknown, endOfDay = false): number | null {
  if (typeof value !== "string") return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    if (!validCalendarDate(Number(year), Number(month), Number(day))) return null;
    return Date.parse(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  }

  const dateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!dateTime) return null;
  const [, year, month, day, hour, minute, second = "0"] = dateTime;
  if (
    !validCalendarDate(Number(year), Number(month), Number(day))
    || Number(hour) > 23
    || Number(minute) > 59
    || Number(second) > 59
  ) return null;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseBoundary(value: string | undefined, name: "since" | "until"): number | null {
  if (value === undefined) return null;
  const timestamp = parseIsoTimestamp(value, name === "until");
  if (timestamp === null) {
    throw new Error(`${name} must be a valid ISO 8601 date or date-time with timezone`);
  }
  return timestamp;
}

function validResponseId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function boundedNestedValue(
  value: unknown,
  depth: number,
  state: {
    seen: WeakSet<object>;
    remainingNodes: number;
    maxItems: number;
    maxStringChars: number;
  },
): unknown {
  if (state.remainingNodes <= 0) return "[Node limit exceeded]";
  state.remainingNodes -= 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    return value.length <= state.maxStringChars
      ? value
      : `${value.slice(0, state.maxStringChars)} [TRUNCATED]`;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (state.seen.has(value)) return "[Circular]";
  if (depth >= NESTED_MAX_DEPTH) return "[Max depth exceeded]";

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, state.maxItems)
        .map((item) => boundedNestedValue(item, depth + 1, state));
      if (value.length > state.maxItems) {
        items.push(`[${value.length - state.maxItems} more items]`);
      }
      return items;
    }

    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (
      left === "ticket_id" ? -1 : right === "ticket_id" ? 1 : 0
    ));
    for (const [index, [key, item]] of entries.slice(0, state.maxItems).entries()) {
      const boundedKey = key.length <= NESTED_KEY_MAX_CHARS
        ? key
        : `${key.slice(0, NESTED_KEY_MAX_CHARS)}[TRUNCATED:${index}]`;
      result[boundedKey] = boundedNestedValue(item, depth + 1, state);
    }
    if (entries.length > state.maxItems) {
      result.__truncated_entries__ = entries.length - state.maxItems;
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}

export function serializeQaCustomProps(value: unknown): string {
  if (value === undefined) return "";
  const limits = [
    { maxItems: 100, maxStringChars: 2_000, remainingNodes: 500 },
    { maxItems: 25, maxStringChars: 500, remainingNodes: 200 },
    { maxItems: 10, maxStringChars: 250, remainingNodes: 100 },
    { maxItems: 5, maxStringChars: 200, remainingNodes: 50 },
    { maxItems: 1, maxStringChars: 100, remainingNodes: 10 },
  ];

  for (const limit of limits) {
    const serialized = JSON.stringify(boundedNestedValue(value, 0, {
      seen: new WeakSet<object>(),
      ...limit,
    }));
    if (serialized.length <= CUSTOM_PROPS_MAX_CHARS) return serialized;
  }
  return JSON.stringify({ __serialization_truncated__: true });
}

function pageFingerprint(records: unknown[]): string {
  return JSON.stringify(records.map((record, index) => {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      return {
        index,
        malformedHash: createHash("sha256")
          .update(serializeQaCustomProps(record))
          .digest("hex"),
      };
    }
    const feedbackRecord = record as Record<string, unknown>;
    const id = validResponseId(feedbackRecord.id);
    if (id !== null) return { index, id };
    return {
      index,
      anonymousHash: createHash("sha256").update(JSON.stringify(feedbackRecord)).digest("hex"),
    };
  }));
}

function wrapTags(value: unknown) {
  return Array.isArray(value)
    ? value.map((tag, index) => wrapUntrustedField(`tags[${index}]`, tag, { maxChars: 200 }))
    : [];
}

function wrapQaFeedback(record: Record<string, unknown>, selectedDate: SelectedDate, id: string | null) {
  const isSubmitted = record.isSubmitted === true
    ? true
    : record.isSubmitted === false
      ? false
      : null;

  return {
    metadata: {
      id,
      score: record.score,
      campaign_id: record.campaign_id ?? record.campaignId,
      created_date: selectedDate.raw,
      created_date_field: selectedDate.field,
      channel: record.channel,
      isSubmitted,
    },
    content: {
      comment: wrapUntrustedField("comment", record.comment, { maxChars: 8_000 }),
      customerName: wrapUntrustedField(
        "customer_name",
        record.customer_name ?? record.firstName ?? record.name,
        { maxChars: 200 },
      ),
      customerEmail: wrapUntrustedField(
        "customer_email",
        record.customer_email ?? record.email,
        { maxChars: 200 },
      ),
      tags: wrapTags(record.tags),
      metricsType: wrapUntrustedField("metricsType", record.metricsType, { maxChars: 100 }),
      customProps: wrapUntrustedField(
        "customProps",
        serializeQaCustomProps(record.customProps),
        { maxChars: CUSTOM_PROPS_MAX_CHARS },
      ),
    },
  };
}

export async function listFeedbackForQa(
  client: QaFeedbackClient,
  options: QaFeedbackOptions = {},
) {
  const sinceTimestamp = parseBoundary(options.since, "since");
  const untilTimestamp = parseBoundary(options.until, "until");
  if (sinceTimestamp !== null && untilTimestamp !== null && sinceTimestamp > untilTimestamp) {
    throw new Error("since must be earlier than or equal to until");
  }

  const pageSize = boundedInteger(options.pageSize, DEFAULT_PAGE_SIZE, 100, "pageSize");
  const maxPages = boundedInteger(options.maxPages, DEFAULT_MAX_PAGES, 100, "maxPages");
  const seenPageFingerprints = new Set<string>();
  const seenIds = new Set<string>();
  const feedback: ReturnType<typeof wrapQaFeedback>[] = [];
  const missingDateRecords: Array<{ page: number; index: number; id: string | null }> = [];
  const invalidDateRecords: Array<{
    page: number;
    index: number;
    id: string | null;
    field: DateField;
    value: ReturnType<typeof wrapUntrustedField>;
  }> = [];
  const missingIdRecords: Array<{ page: number; index: number }> = [];
  const invalidIdRecords: Array<{ page: number; index: number }> = [];
  const malformedRecords: Array<{
    page: number;
    index: number;
    value: ReturnType<typeof wrapUntrustedField>;
  }> = [];
  let pagesFetched = 0;
  let duplicatesOmitted = 0;
  let outsideDateRange = 0;
  let terminalReason: "empty_page" | "malformed_page" | "repeated_page" | "page_cap" = "page_cap";
  let complete = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await client.listFeedback({
      page,
      perPage: pageSize,
      campaignId: options.campaignId,
      sort: options.sort,
    });
    pagesFetched += 1;
    const pageData = Array.isArray(result?.data) ? result.data : [];

    if (pageData.length === 0) {
      terminalReason = "empty_page";
      complete = malformedRecords.length === 0;
      break;
    }

    const fingerprint = pageFingerprint(pageData);
    if (seenPageFingerprints.has(fingerprint)) {
      terminalReason = "repeated_page";
      complete = false;
      break;
    }
    seenPageFingerprints.add(fingerprint);

    const records: Array<{ index: number; record: Record<string, unknown> }> = [];
    for (const [index, record] of pageData.entries()) {
      if (record !== null && typeof record === "object" && !Array.isArray(record)) {
        records.push({ index, record });
        continue;
      }
      malformedRecords.push({
        page,
        index,
        value: wrapUntrustedField(
          "malformed_feedback_record",
          serializeQaCustomProps(record),
          { maxChars: 500 },
        ),
      });
    }

    if (records.length === 0) {
      terminalReason = "malformed_page";
      complete = false;
      break;
    }

    for (const { index, record } of records) {
      const id = validResponseId(record.id);
      if (id !== null) {
        if (seenIds.has(id)) {
          duplicatesOmitted += 1;
          continue;
        }
        seenIds.add(id);
      } else if (record.id === undefined || record.id === null || record.id === "") {
        missingIdRecords.push({ page, index });
      } else {
        invalidIdRecords.push({ page, index });
      }

      const selectedDate = selectFeedbackDate(record);
      if (selectedDate === null) {
        missingDateRecords.push({ page, index, id });
        continue;
      }
      if (selectedDate.timestamp === null) {
        invalidDateRecords.push({
          page,
          index,
          id,
          field: selectedDate.field,
          value: wrapUntrustedField(selectedDate.field, selectedDate.raw, { maxChars: 500 }),
        });
        continue;
      }
      if (
        (sinceTimestamp !== null && selectedDate.timestamp < sinceTimestamp)
        || (untilTimestamp !== null && selectedDate.timestamp > untilTimestamp)
      ) {
        outsideDateRange += 1;
        continue;
      }

      feedback.push(wrapQaFeedback(record, selectedDate, id));
    }
  }

  const completedCount = feedback.filter((entry) => entry.metadata.isSubmitted === true).length;
  const explicitlyIncompleteCount = feedback.filter((entry) => entry.metadata.isSubmitted === false).length;

  return buildSafeOutput(
    {
      command: "list-feedback-qa",
      count: feedback.length,
      completed_count: completedCount,
      explicitly_incomplete_count: explicitlyIncompleteCount,
      submission_state_unknown_count: feedback.length - completedCount - explicitlyIncompleteCount,
      pages_fetched: pagesFetched,
      page_size: pageSize,
      max_pages: maxPages,
      duplicates_omitted: duplicatesOmitted,
      missing_id_count: missingIdRecords.length,
      invalid_id_count: invalidIdRecords.length,
      missing_date_count: missingDateRecords.length,
      invalid_date_count: invalidDateRecords.length,
      malformed_record_count: malformedRecords.length,
      outside_date_range_count: outsideDateRange,
      terminal: {
        reason: terminalReason,
        complete,
      },
      filters: {
        since: options.since ?? null,
        until: options.until ?? null,
        campaign_id: options.campaignId ?? null,
      },
    },
    {
      feedback,
      diagnostics: {
        missingIds: missingIdRecords,
        invalidIds: invalidIdRecords,
        missingDates: missingDateRecords,
        invalidDates: invalidDateRecords,
        malformedRecords,
      },
    },
  );
}
