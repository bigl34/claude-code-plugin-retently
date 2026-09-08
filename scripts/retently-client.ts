
import {
  getServiceModuleDir,
  loadServiceConfig,
  z,
} from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";
import {
  calculateBackoff,
  createTimeoutController,
  DEFAULT_RETRY_CONFIG,
  parseRetryAfterMs,
  withRetryThrow,
} from "./vendor/retry/index.js";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";


const RetentlyConfigSchema = z.object({
  retently: z.object({
    apiKey: z.string().min(1),
  }),
});

type Config = z.infer<typeof RetentlyConfigSchema>;

interface Customer {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  tags?: string[];
  properties?: RetentlyCustomerReadProperty[];
  unset_properties?: string[];
  unset_tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface RetentlyCustomerReadProperty {
  label: string;
  type: "text" | "date" | "integer" | "collection" | "boolean";
  value: unknown;
}

const RetentlyCustomerWritePropertySchema = z.discriminatedUnion("type", [
  z.object({
    label: z.string().trim().min(1),
    type: z.literal("string"),
    value: z.string(),
  }).strict(),
  z.object({
    label: z.string().trim().min(1),
    type: z.literal("date"),
    value: z.string().trim().min(1),
  }).strict(),
  z.object({
    label: z.string().trim().min(1),
    type: z.literal("integer"),
    value: z.number().int(),
  }).strict(),
  z.object({
    label: z.string().trim().min(1),
    type: z.literal("collection"),
    value: z.array(z.union([z.string(), z.number(), z.boolean()])),
  }).strict(),
  z.object({
    label: z.string().trim().min(1),
    type: z.literal("boolean"),
    value: z.boolean(),
  }).strict(),
]);

const RetentlyCustomerWritePropertiesSchema = z.array(RetentlyCustomerWritePropertySchema);

const RetentlyCustomerWriteSchema = z.object({
  email: z.string().trim().min(1),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  company: z.string().optional(),
  tags: z.array(z.string()).optional(),
  unset_properties: z.array(z.string()).optional(),
  unset_tags: z.array(z.string()).optional(),
  properties: RetentlyCustomerWritePropertiesSchema.optional(),
}).strict();

export type RetentlyCustomerWriteProperty = z.infer<typeof RetentlyCustomerWritePropertySchema>;
type RetentlyCustomerWrite = z.infer<typeof RetentlyCustomerWriteSchema>;

function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "properties"}: ${issue.message}`)
    .join("; ");
}

export function validateRetentlyCustomerWriteProperties(
  properties: unknown,
  context = "properties",
): RetentlyCustomerWriteProperty[] {
  const parsed = RetentlyCustomerWritePropertiesSchema.safeParse(properties);
  if (!parsed.success) {
    throw new Error(`Invalid Retently write ${context}: ${formatValidationIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function validateRetentlyCustomerWrites(customers: unknown): RetentlyCustomerWrite[] {
  if (!Array.isArray(customers)) {
    throw new Error("Retently customers must be an array");
  }

  return customers.map((entry, index) => {
    const parsed = RetentlyCustomerWriteSchema.safeParse(entry);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
          return `customer[${index}]${path}: ${issue.message}`;
        })
        .join("; ");
      throw new Error(`Invalid Retently write ${issues}`);
    }
    return parsed.data;
  });
}

interface Feedback {
  id: string;
  score: number;
  comment?: string;
  campaign_id: string;
  campaign_name?: string;
  customer_email: string;
  customer_name?: string;
  tags?: string[];
  topics?: Array<{ name: string; sentiment: string }>;
  created_at: string;
  updated_at?: string;
}

interface Campaign {
  id: string;
  name: string;
  type: string;
  status: string;
  created_at: string;
}

interface Template {
  id: string;
  name: string;
  channel: string;
  metric: string;
  surveyQuestions?: unknown[];
}

interface Company {
  id: string;
  domain?: string;
  name?: string;
  nps_score?: number;
  csat_score?: number;
  response_count?: number;
}

interface ScoreResponse {
  score: number;
  promoters?: number;
  passives?: number;
  detractors?: number;
  total_responses?: number;
}

interface ListMeta {
  total?: number;
  page?: number;
  per_page?: number;
  next_page?: number | null;
}

interface ListResponse<T> {
  data: T[];
  meta?: ListMeta;
}

type RawListResponse<T, TCollectionKey extends string> = {
  data?: T[] | (Record<string, unknown> & Partial<Record<TCollectionKey, T[]>>);
  meta?: ListMeta;
} & Partial<Record<TCollectionKey, T[]>>;

interface RateLimitInfo {
  remaining: number | null;
  limit: number | null;
  reset: number | null;
}

const RETENTLY_REQUESTS_PER_MINUTE = 150;
const RETENTLY_RATE_LIMIT_WINDOW_MS = 60_000;
const RETENTLY_RETRY_AFTER_MAX_MS = 300_000;
const RATE_LIMIT_LOCK_TIMEOUT_SECONDS = 12;
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

interface RetentlyRateLimiterOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  statePath?: string;
  onSharedLockAcquired?: () => void;
}

interface RetentlyRateLimitState {
  recentRequests: number[];
  observedRemaining: number | null;
  observedResetAt: number | null;
  observedBlockUntil: number | null;
}

function parseRateLimitResetAt(value: string | null): number | null {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return null;

  const numericValue = Number(normalized);
  if (!Number.isSafeInteger(numericValue)) return null;

  const resetAt = numericValue >= EPOCH_MILLISECONDS_THRESHOLD
    ? numericValue
    : numericValue * 1000;
  return Number.isFinite(new Date(resetAt).getTime()) ? resetAt : null;
}

function parseRateLimitCount(value: string | null): number | null {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return null;

  const count = Number(normalized);
  return Number.isSafeInteger(count) ? count : null;
}

function parseRetryAfterResetAt(value: string | null, now: number): number | null {
  const normalized = value?.trim();
  if (!normalized) return null;

  const seconds = Number(normalized);
  if (Number.isFinite(seconds)) {
    return now + Math.max(0, seconds) * 1000;
  }

  const resetAt = Date.parse(normalized);
  return Number.isFinite(resetAt) ? resetAt : null;
}

function emptyRateLimitState(): RetentlyRateLimitState {
  return {
    recentRequests: [],
    observedRemaining: null,
    observedResetAt: null,
    observedBlockUntil: null,
  };
}

export class RetentlyRateLimiter {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly statePath?: string;
  private readonly onSharedLockAcquired?: () => void;
  private state = emptyRateLimitState();

  constructor(options: RetentlyRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep
      ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.statePath = options.statePath;
    this.onSharedLockAcquired = options.onSharedLockAcquired;
  }

  async acquire(): Promise<void> {
    while (true) {
      const now = this.now();
      const waitMilliseconds = await this.updateState((state) => {
        const currentState = this.normalizeState(state, now);
        const localWait = currentState.recentRequests.length >= RETENTLY_REQUESTS_PER_MINUTE
          ? currentState.recentRequests[0] + RETENTLY_RATE_LIMIT_WINDOW_MS - now
          : 0;
        const providerWait = currentState.observedRemaining === 0
          && currentState.observedBlockUntil !== null
          ? currentState.observedBlockUntil - now
          : 0;
        const wait = Math.max(localWait, providerWait);

        if (wait <= 0) {
          currentState.recentRequests = [...currentState.recentRequests, now];
          if (currentState.observedRemaining !== null) {
            currentState.observedRemaining = Math.max(0, currentState.observedRemaining - 1);
          }
        }

        return { state: currentState, result: wait };
      });

      if (waitMilliseconds <= 0) {
        return;
      }

      await this.sleep(Math.min(waitMilliseconds, RETENTLY_RATE_LIMIT_WINDOW_MS));
    }
  }

  async observe(headers: Headers, exhausted = false): Promise<void> {
    const now = this.now();
    const remaining = parseRateLimitCount(headers.get("X-RateLimit-Remaining"));
    if (remaining === null && !exhausted) return;

    const reportedResetAt = parseRateLimitResetAt(headers.get("X-RateLimit-Reset"));
    const retryAfterResetAt = exhausted
      ? parseRetryAfterResetAt(headers.get("Retry-After"), now)
      : null;
    const explicitResetAt = reportedResetAt ?? retryAfterResetAt;
    const maxWait = exhausted ? RETENTLY_RETRY_AFTER_MAX_MS : RETENTLY_RATE_LIMIT_WINDOW_MS;

    await this.updateState((state) => {
      const currentState = this.normalizeState(state, now);
      const observedRemaining = Math.min(
        remaining ?? 0,
        RETENTLY_REQUESTS_PER_MINUTE,
      );
      const observationResetAt = explicitResetAt === null
        ? currentState.observedResetAt ?? now + (exhausted ? 0 : RETENTLY_RATE_LIMIT_WINDOW_MS)
        : explicitResetAt;
      const observationBlockUntil = explicitResetAt === null
        ? currentState.observedBlockUntil
          ?? now + (exhausted ? 0 : RETENTLY_RATE_LIMIT_WINDOW_MS)
        : Math.min(explicitResetAt, now + maxWait);

      if (observationResetAt <= now) {
        return { state: currentState, result: undefined };
      }
      if (
        currentState.observedResetAt !== null
        && observationResetAt < currentState.observedResetAt
      ) {
        return { state: currentState, result: undefined };
      }

      if (
        currentState.observedResetAt === null
        || observationResetAt > currentState.observedResetAt
      ) {
        currentState.observedRemaining = observedRemaining;
        currentState.observedResetAt = observationResetAt;
        currentState.observedBlockUntil = observationBlockUntil;
        return { state: currentState, result: undefined };
      }

      currentState.observedRemaining = Math.min(
        currentState.observedRemaining ?? observedRemaining,
        observedRemaining,
      );
      return { state: currentState, result: undefined };
    });
  }

  private normalizeState(state: RetentlyRateLimitState, now: number): RetentlyRateLimitState {
    const cutoff = now - RETENTLY_RATE_LIMIT_WINDOW_MS;
    const recentRequests = state.recentRequests
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > cutoff && timestamp <= now)
      .slice(-RETENTLY_REQUESTS_PER_MINUTE);
    const blockUntil = state.observedBlockUntil ?? state.observedResetAt;
    const providerWindowElapsed = blockUntil !== null && now >= blockUntil;

    return {
      recentRequests,
      observedRemaining: providerWindowElapsed ? null : state.observedRemaining,
      observedResetAt: providerWindowElapsed ? null : state.observedResetAt,
      observedBlockUntil: providerWindowElapsed ? null : blockUntil,
    };
  }

  private async updateState<T>(
    update: (state: RetentlyRateLimitState) => { state: RetentlyRateLimitState; result: T },
  ): Promise<T> {
    if (!this.statePath) {
      const updated = update(this.state);
      this.state = updated.state;
      return updated.result;
    }

    const lockDescriptor = this.acquireFileLock();
    try {
      this.onSharedLockAcquired?.();
      const updated = update(this.readSharedState());
      this.writeSharedState(updated.state);
      return updated.result;
    } finally {
      closeSync(lockDescriptor);
    }
  }

  private acquireFileLock(): number {
    const statePath = this.statePath!;
    const lockPath = `${statePath}.lock`;
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    const lockDescriptor = openSync(lockPath, "a", 0o600);
    try {
      const result = spawnSync(
        "flock",
        ["-x", "-w", String(RATE_LIMIT_LOCK_TIMEOUT_SECONDS), "3"],
        {
          encoding: "utf8",
          stdio: ["ignore", "ignore", "pipe", lockDescriptor],
          timeout: (RATE_LIMIT_LOCK_TIMEOUT_SECONDS + 1) * 1000,
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const detail = result.stderr.trim();
        throw new Error(
          `Retently rate-limit lock unavailable after ${RATE_LIMIT_LOCK_TIMEOUT_SECONDS}s`
          + (detail ? `: ${detail}` : ""),
        );
      }
      return lockDescriptor;
    } catch (error) {
      closeSync(lockDescriptor);
      throw error;
    }
  }

  private readSharedState(): RetentlyRateLimitState {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath!, "utf8")) as Partial<RetentlyRateLimitState>;
      return {
        recentRequests: Array.isArray(parsed.recentRequests) ? parsed.recentRequests : [],
        observedRemaining: typeof parsed.observedRemaining === "number"
          ? parsed.observedRemaining
          : null,
        observedResetAt: typeof parsed.observedResetAt === "number"
          ? parsed.observedResetAt
          : null,
        observedBlockUntil: typeof parsed.observedBlockUntil === "number"
          ? parsed.observedBlockUntil
          : null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
        return emptyRateLimitState();
      }
      throw error;
    }
  }

  private writeSharedState(state: RetentlyRateLimitState): void {
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      renameSync(temporaryPath, this.statePath!);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}

interface BulkResult {
  write_operation: true;
  action: string;
  success_count: number;
  error_count: number;
  results: Array<{
    email: string;
    success: boolean;
    error?: string;
  }>;
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function normalizeListResponse<T, TCollectionKey extends string>(
  response: RawListResponse<T, TCollectionKey>,
  collectionKey: TCollectionKey,
): ListResponse<T> {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error(`Invalid Retently list response: expected an object containing ${collectionKey}`);
  }

  if (Array.isArray(response.data)) {
    return { data: response.data, meta: response.meta };
  }

  if (response.data && typeof response.data === "object") {
    const nestedItems = response.data[collectionKey];
    if (nestedItems !== undefined) {
      if (!Array.isArray(nestedItems)) {
        throw new Error(`Invalid Retently list response: data.${collectionKey} must be an array`);
      }
      return { data: nestedItems as T[], meta: response.meta };
    }
  }

  const legacyItems = response[collectionKey];
  if (legacyItems !== undefined) {
    if (!Array.isArray(legacyItems)) {
      throw new Error(`Invalid Retently list response: ${collectionKey} must be an array`);
    }
    return { data: legacyItems as T[], meta: response.meta };
  }

  throw new Error(
    `Invalid Retently list response: expected data.${collectionKey}, ${collectionKey}, or data to be an array`,
  );
}


const cache = new PluginCache({
  namespace: "retently-feedback-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});


export class RetentlyClient {
  private baseUrl = 'https://app.retently.com/api/v2';
  private config: Config['retently'];
  private cacheDisabled: boolean = false;
  private rateLimiter: RetentlyRateLimiter;
  private lastRateLimitInfo: RateLimitInfo = {
    remaining: null,
    limit: null,
    reset: null,
  };

  constructor() {
    const configFile = loadServiceConfig("retently-feedback-manager", {
      schema: RetentlyConfigSchema,
    });
    this.config = configFile.retently;
    this.rateLimiter = new RetentlyRateLimiter({
      statePath: join(
        getServiceModuleDir("retently-feedback-manager"),
        "..",
        "..",
        "var",
        "retently-feedback-manager",
        "rate-limit.json",
      ),
    });
  }


  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  getCacheStats() {
    return cache.getStats();
  }

  clearCache(): number {
    return cache.clear();
  }

  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }

  invalidateCachePattern(pattern: RegExp): number {
    return cache.invalidatePattern(pattern);
  }


  getRateLimitInfo(): RateLimitInfo {
    return { ...this.lastRateLimitInfo };
  }


  private async request<T>(
    endpoint: string,
    options: {
      method?: string;
      params?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      timeout?: number;
    } = {}
  ): Promise<T> {
    const { method = 'GET', params = {}, body, timeout = 30000 } = options;

    const url = new URL(`${this.baseUrl}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    }

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'X-Api-Key': this.config.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };

    if (body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    try {
      const response = await this.fetchWithRateLimitAccounting(
        url.toString(),
        fetchOptions,
        timeout,
      );

      this.lastRateLimitInfo = {
        remaining: response.headers.get('X-RateLimit-Remaining')
          ? parseInt(response.headers.get('X-RateLimit-Remaining')!, 10)
          : null,
        limit: response.headers.get('X-RateLimit-Limit')
          ? parseInt(response.headers.get('X-RateLimit-Limit')!, 10)
          : null,
        reset: response.headers.get('X-RateLimit-Reset')
          ? parseInt(response.headers.get('X-RateLimit-Reset')!, 10)
          : null,
      };

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') || '60';
        throw new Error(
          `Rate limit exceeded. Retry after ${retryAfter} seconds. ` +
          `Remaining: ${this.lastRateLimitInfo.remaining}/${this.lastRateLimitInfo.limit}`
        );
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Retently API error (${response.status}): ${errorText}`);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      const responseText = await response.text();
      if (!responseText.trim()) {
        return undefined as T;
      }

      return JSON.parse(responseText) as T;
    } catch (error) {
      if (error instanceof Error && /(timed out|timeout|abort)/i.test(error.message)) {
        throw new Error(`Request timeout after ${timeout}ms: ${endpoint}`);
      }
      throw error;
    }
  }

  private async fetchWithRateLimitAccounting(
    url: string,
    options: RequestInit,
    timeout: number,
  ): Promise<Response> {
    const method = (options.method ?? "GET").toUpperCase();
    const operationKind = method === "GET" || method === "HEAD" ? "read" : "write";
    const backoffMaxDelayMs = DEFAULT_RETRY_CONFIG.maxDelayMs;

    return withRetryThrow(
      async () => {
        await this.getRateLimiter().acquire();
        const { controller, cleanup } = createTimeoutController(timeout);

        try {
          const response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });
          await this.getRateLimiter().observe(response.headers, response.status === 429);

          if (!response.ok && DEFAULT_RETRY_CONFIG.retryableErrors.includes(String(response.status))) {
            const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
            const retryError = error as Error & { status: number; retryAfterMs?: number };
            retryError.status = response.status;
            if (response.status === 429) {
              retryError.retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
            }
            throw retryError;
          }

          return response;
        } finally {
          cleanup();
        }
      },
      {
        maxRetries: 3,
        timeoutMs: timeout,
        operationKind,
        maxDelayMs: RETENTLY_RETRY_AFTER_MAX_MS,
        nextDelayMs: ({ attempt, error }) => {
          const retryAfterMs = (error as { retryAfterMs?: number } | null)?.retryAfterMs;
          if (typeof retryAfterMs === "number" && retryAfterMs >= 0) {
            return Math.min(retryAfterMs, RETENTLY_RETRY_AFTER_MAX_MS);
          }
          return calculateBackoff(attempt, {
            ...DEFAULT_RETRY_CONFIG,
            maxDelayMs: backoffMaxDelayMs,
          });
        },
      },
      "Retently.request",
    );
  }

  private getRateLimiter(): RetentlyRateLimiter {
    if (!this.rateLimiter) {
      this.rateLimiter = new RetentlyRateLimiter();
    }
    return this.rateLimiter;
  }


  async listCustomers(options: {
    page?: number;
    perPage?: number;
    email?: string;
  } = {}): Promise<ListResponse<Customer>> {
    const cacheKey = createCacheKey("customers", {
      page: options.page,
      perPage: options.perPage,
      email: options.email,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const params: Record<string, string | number | undefined> = {
          page: options.page,
          per_page: options.perPage,
        };

        if (options.email) {
          params.email = options.email;
        }

        const response = await this.request<RawListResponse<Customer, "subscribers">>(
          '/customers',
          { params },
        );
        return normalizeListResponse(response, "subscribers");
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getCustomer(customerId: string): Promise<Customer> {
    const cacheKey = createCacheKey("customer", { id: customerId });

    return cache.getOrFetch(
      cacheKey,
      () => this.request<Customer>(`/customers/${pathSegment(customerId)}`),
      { ttl: TTL.MINUTE, bypassCache: this.cacheDisabled }
    );
  }

  async createCustomers(customers: RetentlyCustomerWrite[]): Promise<BulkResult> {
    const validatedCustomers = validateRetentlyCustomerWrites(customers);

    const seen = new Set<string>();
    const deduped = validatedCustomers.filter(c => {
      if (!c.email) return false;
      if (seen.has(c.email.toLowerCase())) return false;
      seen.add(c.email.toLowerCase());
      return true;
    });

    const results: BulkResult['results'] = [];
    let successCount = 0;
    let errorCount = 0;

    const chunkSize = 1000;
    for (let i = 0; i < deduped.length; i += chunkSize) {
      const chunk = deduped.slice(i, i + chunkSize);

      try {
        await this.request('/customers', {
          method: 'POST',
          body: { subscribers: chunk },
        });

        for (const customer of chunk) {
          results.push({ email: customer.email!, success: true });
          successCount++;
        }
      } catch (error) {
        for (const customer of chunk) {
          results.push({
            email: customer.email!,
            success: false,
            error: (error as Error).message
          });
          errorCount++;
        }
      }
    }

    cache.invalidatePattern(/^customer/);

    return {
      write_operation: true,
      action: 'create-customers',
      success_count: successCount,
      error_count: errorCount,
      results,
    };
  }

  async deleteCustomer(email: string): Promise<{ write_operation: true; action: string; deleted: boolean }> {
    await this.request('/customers', {
      method: 'DELETE',
      body: { subscribers: [{ email }] },
    });

    cache.invalidatePattern(/^customer/);

    return {
      write_operation: true,
      action: 'delete-customer',
      deleted: true,
    };
  }


  async listFeedback(options: {
    page?: number;
    perPage?: number;
    campaignId?: string;
    since?: string;
    until?: string;
    sort?: 'asc' | 'desc';
  } = {}): Promise<ListResponse<Feedback>> {
    const bypassCache = this.cacheDisabled || !!options.since;

    const cacheKey = createCacheKey("feedback", {
      page: options.page,
      perPage: options.perPage,
      campaignId: options.campaignId,
      since: options.since,
      until: options.until,
      sort: options.sort,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const params: Record<string, string | number | undefined> = {
          page: options.page,
          per_page: options.perPage,
          campaign_id: options.campaignId,
          created_after: options.since,
          created_before: options.until,
          sort: options.sort,
        };

        const response = await this.request<RawListResponse<Feedback, "responses">>(
          '/feedback',
          { params },
        );
        return normalizeListResponse(response, "responses");
      },
      { ttl: TTL.MINUTE * 2, bypassCache }
    );
  }

  async getFeedback(feedbackId: string): Promise<Feedback> {
    const cacheKey = createCacheKey("feedback_detail", { id: feedbackId });

    return cache.getOrFetch(
      cacheKey,
      () => this.request<Feedback>(`/feedback/${pathSegment(feedbackId)}`),
      { ttl: TTL.MINUTE, bypassCache: this.cacheDisabled }
    );
  }


  async getNpsScore(): Promise<ScoreResponse> {
    return cache.getOrFetch(
      "nps_score",
      () => this.request<ScoreResponse>('/nps/score'),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  async getCsatScore(): Promise<ScoreResponse> {
    return cache.getOrFetch(
      "csat_score",
      () => this.request<ScoreResponse>('/csat/score'),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  async getCesScore(): Promise<ScoreResponse> {
    return cache.getOrFetch(
      "ces_score",
      () => this.request<ScoreResponse>('/ces/score'),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }


  async listCampaigns(options: {
    limit?: number;
  } = {}): Promise<ListResponse<Campaign>> {
    const cacheKey = createCacheKey("campaigns", { limit: options.limit });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const params: Record<string, number | undefined> = {
          per_page: options.limit,
        };

        return this.request<ListResponse<Campaign>>('/campaigns', { params });
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async listTemplates(): Promise<ListResponse<Template>> {
    const cacheKey = createCacheKey("templates", {});

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const response = await this.request<RawListResponse<Template, "templates">>(
          '/templates'
        );
        return normalizeListResponse(response, "templates");
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getTemplate(templateId: string): Promise<Template> {
    if (!templateId) {
      throw new Error("templateId is required");
    }

    const cacheKey = createCacheKey("template", { id: templateId });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const response = await this.request<{ data?: Template } & Partial<Template>>(
          `/templates/${pathSegment(templateId)}`
        );
        const template = response?.data ?? (response as Template);
        if (!template || typeof template !== "object" || !template.id) {
          throw new Error(`Invalid Retently template response for ${templateId}`);
        }
        return template;
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async listCompanies(options: {
    page?: number;
    perPage?: number;
  } = {}): Promise<ListResponse<Company>> {
    const cacheKey = createCacheKey("companies", {
      page: options.page,
      perPage: options.perPage,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const params: Record<string, number | undefined> = {
          page: options.page,
          per_page: options.perPage,
        };

        return this.request<ListResponse<Company>>('/companies', { params });
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async sendSurvey(data: {
    email: string;
    campaignId: string;
    delayDays?: number;
    properties?: RetentlyCustomerWriteProperty[];
  }): Promise<{ write_operation: true; action: string; queued: boolean }> {
    const properties = data.properties === undefined
      ? undefined
      : validateRetentlyCustomerWriteProperties(data.properties, "survey properties");
    const body = {
      campaign: data.campaignId,
      delay: data.delayDays,
      subscribers: [{
        email: data.email,
        properties,
      }],
    };

    await this.request('/survey', {
      method: 'POST',
      body,
    });

    return {
      write_operation: true,
      action: 'send-survey',
      queued: true,
    };
  }


  async addFeedbackTags(
    feedbackId: string,
    tags: string[]
  ): Promise<{ write_operation: true; action: string; added: boolean }> {
    await this.request('/response/tags', {
      method: 'POST',
      body: {
        id: feedbackId,
        tags,
        op: 'append',
      },
    });

    cache.invalidate(createCacheKey("feedback_detail", { id: feedbackId }));
    cache.invalidatePattern(/^feedback(?:\?|$)/);

    return {
      write_operation: true,
      action: 'add-tags',
      added: true,
    };
  }


  listTools(): string[] {
    return [
      'list-customers',
      'get-customer',
      'create-customers',
      'delete-customer',
      'list-feedback',
      'get-feedback',
      'get-nps-score',
      'get-csat-score',
      'get-ces-score',
      'list-campaigns',
      'list-companies',
      'send-survey',
      'add-tags',
      'api-status',
      'list-tools',
      'cache-stats',
      'cache-clear',
      'cache-invalidate',
    ];
  }
}
