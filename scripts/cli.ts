#!/usr/bin/env npx tsx
/**
 * Retently Feedback Manager CLI
 *
 * Zod-validated CLI for Retently NPS/CSAT feedback operations.
 */

import { z, createCommand, runCli, cacheCommands, cliTypes, wrapUntrustedField, buildSafeOutput } from "@local/cli-utils";
import { RetentlyClient } from "./retently-client.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_TAG_LENGTH = 200;

function wrapFeedbackTags(tags: unknown): ReturnType<typeof wrapUntrustedField>[] {
  if (!Array.isArray(tags)) return [];
  return tags.map((tag) => wrapUntrustedField("tag", tag, { maxChars: 200 }));
}

function normalizeTag(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Tags must be strings");
  }
  const tag = value.trim();
  if (!tag) {
    throw new Error("Tags must not be empty");
  }
  if (tag.length > MAX_TAG_LENGTH) {
    throw new Error(`Tags must be ${MAX_TAG_LENGTH} characters or fewer`);
  }
  return tag;
}

export function parseFeedbackTags(tagsStr: string): string[] {
  const input = tagsStr.trim();
  let tags: string[];
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Tags must be a JSON array of strings");
    }
    tags = parsed.map(normalizeTag);
  } catch (err) {
    if (/^[\[{"]/.test(input)) {
      throw new Error(`Invalid JSON tags: ${(err as Error).message}`);
    }
    tags = input.split(",").map(normalizeTag);
  }
  if (tags.length === 0) {
    throw new Error("At least one tag is required");
  }
  return tags;
}

// Define commands with Zod schemas
export const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: RetentlyClient) => ({
      tools: client.listTools(),
      read_operations: [
        "list-customers", "get-customer",
        "list-feedback", "get-feedback",
        "get-nps-score", "get-csat-score", "get-ces-score",
        "list-campaigns", "list-companies",
        "list-templates", "get-template",
        "api-status", "list-tools",
        "cache-stats", "cache-clear", "cache-invalidate",
      ],
      write_operations: [
        "create-customers", "delete-customer",
        "send-survey", "add-tags",
      ],
    }),
    "List available commands",
    { sideEffect: "read" }
  ),

  // ==================== Customer Commands ====================
  "list-customers": createCommand(
    z.object({
      page: cliTypes.int(1).optional().describe("Page number"),
      limit: cliTypes.int(1, 100).optional().describe("Results per page"),
      email: z.string().optional().describe("Filter by email"),
    }),
    async (args, client: RetentlyClient) => {
      const { page, limit, email } = args as {
        page?: number; limit?: number; email?: string;
      };
      const result = await client.listCustomers({ page, perPage: limit, email });

      const customers = (result?.data || []);
      const wrappedCustomers = (Array.isArray(customers) ? customers : []).map((c: any) => ({
        metadata: {
          id: c.id,
          created_date: c.created_date || c.createdDate,
        },
        content: {
          name: wrapUntrustedField("name", c.name, { maxChars: 200 }),
          firstName: wrapUntrustedField("first_name", c.first_name || c.firstName, { maxChars: 200 }),
          lastName: wrapUntrustedField("last_name", c.last_name || c.lastName, { maxChars: 200 }),
          email: wrapUntrustedField("email", c.email, { maxChars: 200 }),
          companyName: wrapUntrustedField("company_name", c.company_name || c.company, { maxChars: 200 }),
        },
      }));

      return buildSafeOutput(
        { command: "list-customers", count: wrappedCustomers.length, page: result?.meta?.page, total: result?.meta?.total },
        { customers: wrappedCustomers }
      );
    },
    "List customers",
    { sideEffect: "read" }
  ),

  "get-customer": createCommand(
    z.object({
      id: z.string().min(1).describe("Customer ID"),
    }),
    async (args, client: RetentlyClient) => {
      const { id } = args as { id: string };
      const result = await client.getCustomer(id);

      const c = (result as any)?.data || result;
      return buildSafeOutput(
        {
          command: "get-customer",
          id: c.id,
          created_date: c.created_date || c.createdDate,
        },
        {
          name: wrapUntrustedField("name", c.name, { maxChars: 200 }),
          firstName: wrapUntrustedField("first_name", c.first_name || c.firstName, { maxChars: 200 }),
          lastName: wrapUntrustedField("last_name", c.last_name || c.lastName, { maxChars: 200 }),
          email: wrapUntrustedField("email", c.email, { maxChars: 200 }),
          companyName: wrapUntrustedField("company_name", c.company_name || c.company, { maxChars: 200 }),
        }
      );
    },
    "Get customer by ID",
    { sideEffect: "read" }
  ),

  "create-customers": createCommand(
    z.object({
      data: z.string().min(1).describe("JSON array of customer objects"),
    }),
    async (args, client: RetentlyClient) => {
      const { data } = args as { data: string };
      let customers: Array<{ email: string; [key: string]: unknown }>;
      try {
        customers = JSON.parse(data);
        if (!Array.isArray(customers)) {
          throw new Error("Data must be a JSON array");
        }
      } catch (e) {
        throw new Error(`Invalid JSON data: ${(e as Error).message}`);
      }
      return client.createCustomers(customers);
    },
    "Bulk create/update customers",
    { sideEffect: "write", requiresConfirmation: true }
  ),

  "delete-customer": createCommand(
    z.object({
      email: z.string().min(1).describe("Customer email"),
    }),
    async (args, client: RetentlyClient) => {
      const { email } = args as { email: string };
      return client.deleteCustomer(email);
    },
    "Delete customer by email",
    { sideEffect: "destructive", requiresConfirmation: true }
  ),

  // ==================== Feedback Commands ====================
  "list-feedback": createCommand(
    z.object({
      page: cliTypes.int(1).optional().describe("Page number"),
      limit: cliTypes.int(1, 100).optional().describe("Results per page"),
      campaignId: z.string().optional().describe("Campaign ID"),
      since: z.string().optional().describe("Start date (ISO 8601)"),
      until: z.string().optional().describe("End date (ISO 8601)"),
      sort: z.enum(["asc", "desc"]).optional().describe("Sort order"),
    }),
    async (args, client: RetentlyClient) => {
      const { page, limit, campaignId, since, until, sort } = args as {
        page?: number; limit?: number; campaignId?: string;
        since?: string; until?: string; sort?: "asc" | "desc";
      };
      const result = await client.listFeedback({ page, perPage: limit, campaignId, since, until, sort });

      const feedback = (result?.data || []);
      const wrappedFeedback = (Array.isArray(feedback) ? feedback : []).map((f: any) => ({
        metadata: {
          id: f.id,
          score: f.score,
          campaign_id: f.campaign_id || f.campaignId,
          created_date: f.created_date || f.createdDate,
          channel: f.channel,
        },
        content: {
          comment: wrapUntrustedField("comment", f.comment, { maxChars: 8000 }),
          customerName: wrapUntrustedField("customer_name", f.customer_name || f.firstName || f.name, { maxChars: 200 }),
          customerEmail: wrapUntrustedField("customer_email", f.customer_email || f.email, { maxChars: 200 }),
          tags: wrapFeedbackTags(f.tags),
        },
      }));

      return buildSafeOutput(
        { command: "list-feedback", count: wrappedFeedback.length, page: result?.meta?.page, total: result?.meta?.total },
        { feedback: wrappedFeedback }
      );
    },
    "List survey responses",
    { sideEffect: "read" }
  ),

  "get-feedback": createCommand(
    z.object({
      id: z.string().min(1).describe("Feedback ID"),
    }),
    async (args, client: RetentlyClient) => {
      const { id } = args as { id: string };
      const result = await client.getFeedback(id);

      const f = (result as any)?.data || result;
      return buildSafeOutput(
        {
          command: "get-feedback",
          id: f.id,
          score: f.score,
          campaign_id: f.campaign_id || f.campaignId,
          created_date: f.created_date || f.createdDate,
          channel: f.channel,
        },
        {
          comment: wrapUntrustedField("comment", f.comment, { maxChars: 8000 }),
          customerName: wrapUntrustedField("customer_name", f.customer_name || f.firstName || f.name, { maxChars: 200 }),
          customerEmail: wrapUntrustedField("customer_email", f.customer_email || f.email, { maxChars: 200 }),
          tags: wrapFeedbackTags(f.tags),
        }
      );
    },
    "Get feedback by ID",
    { sideEffect: "read" }
  ),

  // ==================== Score Commands ====================
  "get-nps-score": createCommand(
    z.object({}),
    async (_args, client: RetentlyClient) => client.getNpsScore(),
    "Get current NPS score",
    { sideEffect: "read" }
  ),

  "get-csat-score": createCommand(
    z.object({}),
    async (_args, client: RetentlyClient) => client.getCsatScore(),
    "Get current CSAT score",
    { sideEffect: "read" }
  ),

  "get-ces-score": createCommand(
    z.object({}),
    async (_args, client: RetentlyClient) => client.getCesScore(),
    "Get current CES score",
    { sideEffect: "read" }
  ),

  // ==================== Campaign Commands ====================
  "list-campaigns": createCommand(
    z.object({
      limit: cliTypes.int(1, 100).optional().describe("Max results"),
    }),
    async (args, client: RetentlyClient) => {
      const { limit } = args as { limit?: number };
      const result = await client.listCampaigns({ limit });

      const campaigns = (result?.data || (result as any)?.campaigns || []);
      const wrappedCampaigns = (Array.isArray(campaigns) ? campaigns : []).map((c: any) => ({
        metadata: {
          id: c.id,
          type: c.type,
          status: c.status,
        },
        content: {
          name: wrapUntrustedField("name", c.name, { maxChars: 200 }),
        },
      }));

      return buildSafeOutput(
        { command: "list-campaigns", count: wrappedCampaigns.length },
        { campaigns: wrappedCampaigns }
      );
    },
    "List survey campaigns",
    { sideEffect: "read" }
  ),

  // ==================== Template Commands (read-only) ====================
  "list-templates": createCommand(
    // No limit/page options on purpose: probed 2026-08-17, /templates ignores
    // every pagination parameter and returns the complete set.
    z.object({}),
    async (_args, client: RetentlyClient) => {
      const result = await client.listTemplates();

      const templates = Array.isArray(result?.data) ? result.data : [];
      const wrappedTemplates = templates.map((t) => ({
        metadata: {
          id: t.id,
          channel: t.channel,
          metric: t.metric,
        },
        content: {
          name: wrapUntrustedField("name", t.name, { maxChars: 200 }),
        },
      }));

      return buildSafeOutput(
        { command: "list-templates", count: wrappedTemplates.length },
        { templates: wrappedTemplates }
      );
    },
    "List survey templates (returns all; this endpoint is not paginated)",
    { sideEffect: "read" }
  ),

  "get-template": createCommand(
    z.object({
      templateId: z.string().min(1).describe("Template ID (from list-templates)"),
    }),
    async (args, client: RetentlyClient) => {
      const { templateId } = args as { templateId: string };
      const template = await client.getTemplate(templateId);

      const questions = Array.isArray(template.surveyQuestions) ? template.surveyQuestions : [];
      const wrappedQuestions = questions.map((question: unknown, index: number) =>
        wrapUntrustedField(
          `surveyQuestions[${index}]`,
          typeof question === "string" ? question : JSON.stringify(question),
          { maxChars: 2000 }
        )
      );

      return buildSafeOutput(
        { command: "get-template", templateId },
        {
          template: {
            metadata: {
              id: template.id,
              channel: template.channel,
              metric: template.metric,
            },
            content: {
              name: wrapUntrustedField("name", template.name, { maxChars: 200 }),
              surveyQuestions: wrappedQuestions,
            },
          },
        }
      );
    },
    "Get one survey template including its questions. Does NOT expose email sender/reply routing or hosted logo settings - those still require the Retently web UI.",
    { sideEffect: "read" }
  ),

  // ==================== Company Commands ====================
  "list-companies": createCommand(
    z.object({
      page: cliTypes.int(1).optional().describe("Page number"),
      limit: cliTypes.int(1, 100).optional().describe("Results per page"),
    }),
    async (args, client: RetentlyClient) => {
      const { page, limit } = args as { page?: number; limit?: number };
      const result = await client.listCompanies({ page, perPage: limit });

      const companies = (result?.data || []);
      const wrappedCompanies = (Array.isArray(companies) ? companies : []).map((c: any) => ({
        metadata: {
          id: c.id,
          nps_score: c.nps_score,
        },
        content: {
          name: wrapUntrustedField("name", c.name, { maxChars: 200 }),
          domain: wrapUntrustedField("domain", c.domain, { maxChars: 200 }),
        },
      }));

      return buildSafeOutput(
        { command: "list-companies", count: wrappedCompanies.length },
        { companies: wrappedCompanies }
      );
    },
    "List companies with metrics",
    { sideEffect: "read" }
  ),

  // ==================== Survey Commands (WRITE) ====================
  "send-survey": createCommand(
    z.object({
      email: z.string().min(1).describe("Recipient email"),
      campaignId: z.string().min(1).describe("Campaign ID"),
      delayDays: cliTypes.int(0).optional().describe("Delay in days"),
    }),
    async (args, client: RetentlyClient) => {
      const { email, campaignId, delayDays } = args as {
        email: string; campaignId: string; delayDays?: number;
      };
      return client.sendSurvey({ email, campaignId, delayDays });
    },
    "Trigger transactional survey",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

  // ==================== Tag Commands (WRITE) ====================
  "add-tags": createCommand(
    z.object({
      feedbackId: z.string().min(1).describe("Feedback ID"),
      tags: z.string().min(1).describe("JSON array or comma-separated tags"),
    }),
    async (args, client: RetentlyClient) => {
      const { feedbackId, tags: tagsStr } = args as { feedbackId: string; tags: string };
      const tags = parseFeedbackTags(tagsStr);
      return client.addFeedbackTags(feedbackId, tags);
    },
    "Add tags to feedback",
    { sideEffect: "write", requiresConfirmation: true }
  ),

  // ==================== Utility Commands ====================
  "api-status": createCommand(
    z.object({}),
    async (_args, client: RetentlyClient) => ({
      rate_limit: client.getRateLimitInfo(),
      api_base: "https://app.retently.com/api/v2",
      max_requests_per_minute: 150,
    }),
    "Show rate limit info",
    { sideEffect: "read" }
  ),

  // Pre-built cache commands
  ...cacheCommands<RetentlyClient>(),
};

let isCliEntry = false;
try {
  isCliEntry =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isCliEntry = false;
}

if (isCliEntry) {
  runCli(commands, RetentlyClient, {
    programName: "retently-cli",
    description: "Retently NPS/CSAT feedback management",
  });
}
