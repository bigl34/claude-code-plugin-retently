#!/usr/bin/env npx tsx
/**
 * Retently Feedback Manager CLI
 *
 * Zod-validated CLI for Retently NPS/CSAT feedback operations.
 */

import { z, createCommand, runCli, cacheCommands, cliTypes } from "@local/cli-utils";
import { RetentlyClient } from "./retently-client.js";

// Define commands with Zod schemas
const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: RetentlyClient) => ({
      tools: client.listTools(),
      read_operations: [
        "list-customers", "get-customer",
        "list-feedback", "get-feedback",
        "get-nps-score", "get-csat-score", "get-ces-score",
        "list-campaigns", "list-companies",
        "api-status", "list-tools",
        "cache-stats", "cache-clear", "cache-invalidate",
      ],
      write_operations: [
        "create-customers", "delete-customer",
        "send-survey", "add-tags",
      ],
    }),
    "List available commands"
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
      return client.listCustomers({ page, perPage: limit, email });
    },
    "List customers"
  ),

  "get-customer": createCommand(
    z.object({
      id: z.string().min(1).describe("Customer ID"),
    }),
    async (args, client: RetentlyClient) => {
      const { id } = args as { id: string };
      return client.getCustomer(id);
    },
    "Get customer by ID"
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
    "Bulk create/update customers"
  ),

  "delete-customer": createCommand(
    z.object({
      email: z.string().min(1).describe("Customer email"),
    }),
    async (args, client: RetentlyClient) => {
      const { email } = args as { email: string };
      return client.deleteCustomer(email);
    },
    "Delete customer by email"
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
      return client.listFeedback({ page, perPage: limit, campaignId, since, until, sort });
    },
    "List survey responses"
  ),

  "get-feedback": createCommand(
    z.object({
      id: z.string().min(1).describe("Feedback ID"),
    }),
    async (args, client: RetentlyClient) => {
      const { id } = args as { id: string };
      return client.getFeedback(id);
    },
    "Get feedback by ID"
  ),

  // ==================== Score Commands ====================
  "get-nps-score": createCommand(
    z.object({}),
    async (_args, client: RetentlyClient) => client.getNpsScore(),
    "Get current NPS score"
  ),

  "get-csat-score": createCommand(
    z.object({}),
    async (_args, client: RetentlyClient) => client.getCsatScore(),
    "Get current CSAT score"
  ),

  "get-ces-score": createCommand(
    z.object({}),
    async (_args, client: RetentlyClient) => client.getCesScore(),
    "Get current CES score"
  ),

  // ==================== Campaign Commands ====================
  "list-campaigns": createCommand(
    z.object({
      limit: cliTypes.int(1, 100).optional().describe("Max results"),
    }),
    async (args, client: RetentlyClient) => {
      const { limit } = args as { limit?: number };
      return client.listCampaigns({ limit });
    },
    "List survey campaigns"
  ),

  // ==================== Company Commands ====================
  "list-companies": createCommand(
    z.object({
      page: cliTypes.int(1).optional().describe("Page number"),
      limit: cliTypes.int(1, 100).optional().describe("Results per page"),
    }),
    async (args, client: RetentlyClient) => {
      const { page, limit } = args as { page?: number; limit?: number };
      return client.listCompanies({ page, perPage: limit });
    },
    "List companies with metrics"
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
    "Trigger transactional survey"
  ),

  // ==================== Tag Commands (WRITE) ====================
  "add-tags": createCommand(
    z.object({
      feedbackId: z.string().min(1).describe("Feedback ID"),
      tags: z.string().min(1).describe("JSON array or comma-separated tags"),
    }),
    async (args, client: RetentlyClient) => {
      const { feedbackId, tags: tagsStr } = args as { feedbackId: string; tags: string };
      let tags: string[];
      try {
        tags = JSON.parse(tagsStr);
        if (!Array.isArray(tags)) {
          throw new Error("Tags must be a JSON array of strings");
        }
      } catch {
        tags = tagsStr.split(",").map(t => t.trim());
      }
      return client.addFeedbackTags(feedbackId, tags);
    },
    "Add tags to feedback"
  ),

  // ==================== Utility Commands ====================
  "api-status": createCommand(
    z.object({}),
    async (_args, client: RetentlyClient) => ({
      rate_limit: client.getRateLimitInfo(),
      api_base: "https://app.retently.com/api/v2",
      max_requests_per_minute: 150,
    }),
    "Show rate limit info"
  ),

  // Pre-built cache commands
  ...cacheCommands<RetentlyClient>(),
};

// Run CLI
runCli(commands, RetentlyClient, {
  programName: "retently-cli",
  description: "Retently NPS/CSAT feedback management",
});
