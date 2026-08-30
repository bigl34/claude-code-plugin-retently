/**
 * Retently NPS/CSAT/CES Feedback API Client
 *
 * Direct client for the Retently REST API v2.
 * Handles customers, feedback responses, campaigns, and score metrics.
 *
 * Key features:
 * - Customer management (create, list, delete)
 * - Feedback retrieval with date filtering
 * - NPS, CSAT, and CES score metrics
 * - Survey sending and response tagging
 * - Rate limit tracking
 */

import { loadServiceConfig, z } from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";
import { fetchWithRetry } from "@local/retry";

// ============================================================================
// Type Definitions
// ============================================================================

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
  properties?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
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

/**
 * Survey template. `surveyQuestions` is returned only by the detail endpoint,
 * not by the listing.
 *
 * Probed against the live account 2026-08-17: email sender/auth/reply routing
 * and hosted logo/image settings are NOT exposed here, so branding work still
 * needs the web UI.
 */
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

// ============================================================================
// Cache Setup
// ============================================================================

const cache = new PluginCache({
  namespace: "retently-feedback-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});

// ============================================================================
// Retently API Client
// ============================================================================

export class RetentlyClient {
  private baseUrl = 'https://app.retently.com/api/v2';
  private config: Config['retently'];
  private cacheDisabled: boolean = false;
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
  }

  // ============================================
  // CACHE CONTROL
  // ============================================

  /**
   * Disables caching for all subsequent requests.
   */
  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  /**
   * Re-enables caching after it was disabled.
   */
  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  /**
   * Returns cache statistics including hit/miss counts.
   */
  getCacheStats() {
    return cache.getStats();
  }

  /**
   * Clears all cached data.
   * @returns Number of cache entries cleared
   */
  clearCache(): number {
    return cache.clear();
  }

  /**
   * Invalidates a specific cache entry by key.
   */
  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }

  /**
   * Invalidates cache entries matching a pattern.
   * @param pattern - Regex pattern to match cache keys
   * @returns Number of entries invalidated
   */
  invalidateCachePattern(pattern: RegExp): number {
    return cache.invalidatePattern(pattern);
  }

  // ============================================
  // RATE LIMIT INFO
  // ============================================

  /**
   * Returns the rate limit information from the last API request.
   *
   * @returns Object with remaining, limit, and reset timestamp
   */
  getRateLimitInfo(): RateLimitInfo {
    return { ...this.lastRateLimitInfo };
  }

  // --------------------------------------------------------------------------
  // HTTP Request Handler
  // --------------------------------------------------------------------------

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

    // Build URL with query params
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
      const response = await fetchWithRetry(
        url.toString(),
        fetchOptions,
        { maxRetries: 3, timeoutMs: timeout },
        "Retently.request"
      );

      // Parse rate limit headers
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

      // fetchWithRetry already retries 429 with exponential backoff. If a 429
      // still reaches us here, it means retries were not exhausted (e.g. 429 is
      // not classified retryable due to config override). Keep the historical
      // detailed error in case that ever happens.
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
      // fetchWithRetry wraps timeout errors as "Operation failed after N attempts: ..."
      // so we match on the broader timeout-message family.
      if (error instanceof Error && /(timed out|timeout|abort)/i.test(error.message)) {
        throw new Error(`Request timeout after ${timeout}ms: ${endpoint}`);
      }
      throw error;
    }
  }

  // ============================================
  // CUSTOMER OPERATIONS
  // ============================================

  /**
   * Lists customers with optional filtering and pagination.
   *
   * @param options - Query options
   * @param options.page - Page number
   * @param options.perPage - Results per page
   * @param options.email - Filter by email address
   * @returns Paginated list of customers
   *
   * @cached TTL: 5 minutes
   */
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

        // Email filter if provided
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

  /**
   * Gets a specific customer by ID.
   *
   * @param customerId - Retently customer ID
   * @returns Customer object with details
   *
   * @cached TTL: 1 minute
   */
  async getCustomer(customerId: string): Promise<Customer> {
    const cacheKey = createCacheKey("customer", { id: customerId });

    return cache.getOrFetch(
      cacheKey,
      () => this.request<Customer>(`/customers/${pathSegment(customerId)}`),
      { ttl: TTL.MINUTE, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Creates customers in bulk.
   *
   * Deduplicates by email and processes in batches of 1000.
   *
   * @param customers - Array of customer objects to create
   * @returns Bulk result with success/error counts
   *
   * @invalidates customer/*
   */
  async createCustomers(customers: Array<Partial<Customer>>): Promise<BulkResult> {
    // Dedupe by email
    const seen = new Set<string>();
    const deduped = customers.filter(c => {
      if (!c.email) return false;
      if (seen.has(c.email.toLowerCase())) return false;
      seen.add(c.email.toLowerCase());
      return true;
    });

    const results: BulkResult['results'] = [];
    let successCount = 0;
    let errorCount = 0;

    // Chunk into batches of 1000
    const chunkSize = 1000;
    for (let i = 0; i < deduped.length; i += chunkSize) {
      const chunk = deduped.slice(i, i + chunkSize);

      try {
        await this.request('/customers', {
          method: 'POST',
          body: { customers: chunk },
        });

        // Mark all in chunk as success
        for (const customer of chunk) {
          results.push({ email: customer.email!, success: true });
          successCount++;
        }
      } catch (error) {
        // Mark all in chunk as failed
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

    // Invalidate customer caches after mutation
    cache.invalidatePattern(/^customer/);

    return {
      write_operation: true,
      action: 'create-customers',
      success_count: successCount,
      error_count: errorCount,
      results,
    };
  }

  /**
   * Deletes a customer by email.
   *
   * @param email - Customer email to delete
   * @returns Delete confirmation
   *
   * @invalidates customer/*
   */
  async deleteCustomer(email: string): Promise<{ write_operation: true; action: string; deleted: boolean }> {
    await this.request('/customers', {
      method: 'DELETE',
      body: { email },
    });

    // Invalidate customer caches after mutation
    cache.invalidatePattern(/^customer/);

    return {
      write_operation: true,
      action: 'delete-customer',
      deleted: true,
    };
  }

  // ============================================
  // FEEDBACK OPERATIONS
  // ============================================

  /**
   * Lists feedback responses with optional filtering.
   *
   * @param options - Query options
   * @param options.page - Page number
   * @param options.perPage - Results per page
   * @param options.campaignId - Filter by campaign
   * @param options.since - Filter responses created after this date (ISO format)
   * @param options.until - Filter responses created before this date
   * @param options.sort - Sort order: "asc" or "desc"
   * @returns Paginated list of feedback responses
   *
   * @cached TTL: 2 minutes (bypassed when using since filter for polling)
   */
  async listFeedback(options: {
    page?: number;
    perPage?: number;
    campaignId?: string;
    since?: string;  // ISO date
    until?: string;  // ISO date
    sort?: 'asc' | 'desc';
  } = {}): Promise<ListResponse<Feedback>> {
    // Bypass cache when using --since (for polling)
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

  /**
   * Gets a specific feedback response by ID.
   *
   * @param feedbackId - Retently feedback ID
   * @returns Feedback object with score, comment, and metadata
   *
   * @cached TTL: 1 minute
   */
  async getFeedback(feedbackId: string): Promise<Feedback> {
    const cacheKey = createCacheKey("feedback_detail", { id: feedbackId });

    return cache.getOrFetch(
      cacheKey,
      () => this.request<Feedback>(`/feedback/${pathSegment(feedbackId)}`),
      { ttl: TTL.MINUTE, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // SCORE OPERATIONS
  // ============================================

  /**
   * Gets the overall NPS (Net Promoter Score).
   *
   * Returns score from -100 to 100 with promoter/passive/detractor counts.
   *
   * @returns NPS score and breakdown
   *
   * @cached TTL: 1 hour
   */
  async getNpsScore(): Promise<ScoreResponse> {
    return cache.getOrFetch(
      "nps_score",
      () => this.request<ScoreResponse>('/nps/score'),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets the overall CSAT (Customer Satisfaction) score.
   *
   * @returns CSAT score (typically 0-100)
   *
   * @cached TTL: 1 hour
   */
  async getCsatScore(): Promise<ScoreResponse> {
    return cache.getOrFetch(
      "csat_score",
      () => this.request<ScoreResponse>('/csat/score'),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets the overall CES (Customer Effort Score).
   *
   * @returns CES score
   *
   * @cached TTL: 1 hour
   */
  async getCesScore(): Promise<ScoreResponse> {
    return cache.getOrFetch(
      "ces_score",
      () => this.request<ScoreResponse>('/ces/score'),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // CAMPAIGN OPERATIONS
  // ============================================

  /**
   * Lists available survey campaigns.
   *
   * @param options - Query options
   * @param options.limit - Max campaigns to return
   * @returns List of campaigns with ID, name, type, and status
   *
   * @cached TTL: 15 minutes
   */
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

  // ============================================
  // TEMPLATE OPERATIONS (read-only)
  // ============================================

  /**
   * Lists survey templates.
   *
   * Deliberately takes no pagination options. Probed against the live account
   * on 2026-08-17: `/templates` ignores `limit`, `page`, `pageSize` and
   * `per_page` alike and always returns the complete set, so offering a limit
   * would advertise filtering the provider does not perform.
   *
   * The listing nests its rows under `templates` rather than `data` — see
   * normalizeListResponse.
   */
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

  /**
   * Fetches a single survey template, including its `surveyQuestions`.
   *
   * Note the envelope differs from the listing: the detail endpoint returns
   * the template under `data`, not `templates`.
   */
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

  // ============================================
  // COMPANY OPERATIONS
  // ============================================

  /**
   * Lists companies with aggregated scores.
   *
   * @param options - Query options
   * @param options.page - Page number
   * @param options.perPage - Results per page
   * @returns List of companies with NPS/CSAT scores
   *
   * @cached TTL: 15 minutes
   */
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

  // ============================================
  // SURVEY OPERATIONS (WRITE)
  // ============================================

  /**
   * Queues a survey to be sent to a customer.
   *
   * @param data - Survey data
   * @param data.email - Customer email to survey
   * @param data.campaignId - Campaign ID to use
   * @param data.delayDays - Days to delay sending (optional)
   * @param data.properties - Custom properties to pass
   * @returns Confirmation that survey was queued
   */
  async sendSurvey(data: {
    email: string;
    campaignId: string;
    delayDays?: number;
    properties?: Record<string, unknown>;
  }): Promise<{ write_operation: true; action: string; queued: boolean }> {
    const body = {
      email: data.email,
      campaign_id: data.campaignId,
      delay: data.delayDays,
      properties: data.properties,
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

  // ============================================
  // TAG OPERATIONS (WRITE)
  // ============================================

  /**
   * Adds tags to a feedback response.
   *
   * @param feedbackId - Feedback ID to tag
   * @param tags - Array of tags to add
   * @returns Confirmation that tags were added
   *
   * @invalidates feedback_detail/{feedbackId}
   */
  async addFeedbackTags(
    feedbackId: string,
    tags: string[]
  ): Promise<{ write_operation: true; action: string; added: boolean }> {
    await this.request('/response/tags', {
      method: 'POST',
      body: {
        feedback_id: feedbackId,
        tags,
      },
    });

    // Tag changes affect both detail reads and cached list rows that include
    // tags, so refresh both surfaces immediately after the write.
    cache.invalidate(createCacheKey("feedback_detail", { id: feedbackId }));
    cache.invalidatePattern(/^feedback(?:\?|$)/);

    return {
      write_operation: true,
      action: 'add-tags',
      added: true,
    };
  }

  // ============================================
  // UTILITY
  // ============================================

  /**
   * Returns available CLI commands.
   *
   * @returns Array of command names
   */
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
