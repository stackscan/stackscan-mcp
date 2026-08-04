#!/usr/bin/env node
/**
 * StackScan MCP server.
 *
 * Wraps the four read-only endpoints of the Tech Lookup API
 * (api.stackscan.com/v1/tech-lookup/...) as MCP tools so an assistant can answer
 * "what does this domain run?" and "who is behind it?" directly.
 *
 * Read-only by design: nothing here writes to a customer system.
 *
 * Credits: every lookup costs 1 credit against the caller's balance;
 * check_credits is free. Because an agent can loop far faster than a human
 * clicks, this server enforces its own per-session cap on top of the API's
 * rate limit - see SESSION_LOOKUP_CAP below.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const API_BASE = (process.env.STACKSCAN_API_BASE ?? "https://api.stackscan.com").replace(/\/+$/, "");

/**
 * Where the endpoints sit beneath the base URL.
 *
 * The dedicated host serves them at /v1/...; the older app.stackscan.com host
 * serves the same endpoints under /api/v1/... Both are live and neither
 * redirects to the other, so a config still naming the old host has to keep
 * working after upgrading this package rather than silently 404ing.
 */
const API_PREFIX = ((): string => {
  if (API_BASE.endsWith("/api")) {
    return "/v1";
  }

  try {
    return new URL(API_BASE).hostname.toLowerCase() === "app.stackscan.com" ? "/api/v1" : "/v1";
  } catch {
    return "/v1";
  }
})();

const API_TOKEN = process.env.STACKSCAN_API_TOKEN;
const TENANT_ID = process.env.STACKSCAN_TENANT_ID;

/**
 * Hard ceiling on credit-consuming lookups per server process.
 *
 * The API's own limit is a RATE limit (requests/minute), which does nothing to
 * stop a patient agent from spending an entire balance over an afternoon. This
 * is a spend cap, not a rate limit, and it is deliberately low by default -
 * raise it explicitly rather than discovering the balance is gone.
 */
const SESSION_LOOKUP_CAP = Number.parseInt(process.env.STACKSCAN_SESSION_LOOKUP_CAP ?? "25", 10);
let lookupsThisSession = 0;

/** Most recent balance seen, so tool results can report it without spending a call. */
let lastKnownBalance: number | null = null;

if (!API_TOKEN || !TENANT_ID) {
  // stderr, not stdout: stdout is the JSON-RPC channel and must stay clean.
  console.error(
    "stackscan-mcp: missing configuration.\n" +
      "  STACKSCAN_API_TOKEN  - create one at Dashboard -> API Tokens\n" +
      "  STACKSCAN_TENANT_ID  - your workspace UUID (the id in the dashboard URL)\n" +
      "Optional: STACKSCAN_API_BASE (default https://api.stackscan.com), " +
      "STACKSCAN_SESSION_LOOKUP_CAP (default 25).",
  );
  process.exit(1);
}

/**
 * `noData` distinguishes "StackScan has nothing for this input" from a real
 * failure. The API signals a miss as HTTP 200 with `{success: false}` rather
 * than a 404, and (verified against staging) a miss is NOT charged while a
 * hit is. Both facts matter: a naive client reads the 200 as success and
 * crashes on the absent payload, and counting misses against a spend cap would
 * bill the user's budget for nothing.
 */
type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; noData?: boolean };

/**
 * Call the Tech Lookup API and turn every failure into a message the model can
 * act on. Deliberately never throws: an MCP tool that rejects gives the model
 * nothing to reason about, whereas "you are out of credits" is actionable.
 */
async function apiGet<T>(path: string, params: Record<string, string | number | undefined>): Promise<ApiResult<T>> {
  const url = new URL(`${API_BASE}${API_PREFIX}/tech-lookup/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  return apiSend<T>(url);
}

/** The batch endpoint is the one POST. Same error handling as everything else. */
async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return apiSend<T>(new URL(`${API_BASE}${API_PREFIX}/tech-lookup/${path}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function apiSend<T>(url: URL, init: RequestInit = {}): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "X-Tenant-Id": TENANT_ID!,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    return { ok: false, message: `Could not reach StackScan at ${API_BASE}: ${(error as Error).message}` };
  }

  const raw = await response.text();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // A bot-protection interstitial is HTML, not JSON, and is by far the most
    // likely cause of a non-JSON reply: the edge blocks non-browser TLS
    // fingerprints before the request ever reaches StackScan. Say so, because
    // "non-JSON 403" sends people hunting for a bug in their token.
    const challenged =
      /Just a moment|Enable JavaScript and cookies|cf-browser-verification|Attention Required/i.test(raw);
    if (challenged) {
      return {
        ok: false,
        message:
          `Blocked by bot protection in front of ${API_BASE} (HTTP ${response.status}) - the request never reached the ` +
          `StackScan API. This is an edge configuration issue, not a problem with your token. ` +
          `The API host needs its bot protection relaxed for /api/ paths.`,
      };
    }
    return { ok: false, message: `StackScan returned a non-JSON ${response.status} response.` };
  }

  if (response.ok) {
    // A miss arrives as 200 {success: false, error: "..."}, not a 404.
    if ((body as { success?: boolean }).success === false) {
      return {
        ok: false,
        noData: true,
        message: (body as { error?: string }).error ?? "No data available",
      };
    }
    return { ok: true, data: body as T };
  }

  const message = (body as { message?: string }).message ?? `HTTP ${response.status}`;
  switch (response.status) {
    case 401:
      return { ok: false, message: "StackScan rejected the API token. Check STACKSCAN_API_TOKEN (Dashboard -> API Tokens)." };
    case 403:
      return { ok: false, message: `StackScan denied access: ${message}. Check STACKSCAN_TENANT_ID matches a workspace this token can use.` };
    case 429: {
      const retry = (body as { retry_after?: number }).retry_after;
      return { ok: false, message: `Rate limited by StackScan.${retry ? ` Retry in ${retry}s.` : ""} Space out requests rather than retrying immediately.` };
    }
    case 402:
      return { ok: false, message: `Out of StackScan credits: ${message}. Top up in the dashboard to continue.` };
    default:
      return { ok: false, message: `StackScan error (${response.status}): ${message}` };
  }
}

/** Wrap a plain string as an MCP tool result. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/**
 * Refuse a lookup once the session cap is reached. Returns a result to hand
 * straight back to the model, or null to proceed.
 *
 * Checked BEFORE the call; the counter is only advanced by recordSpend() after
 * a confirmed hit, so misses (which StackScan does not charge for) never eat
 * into the budget.
 */
function refuseIfCapReached(): { content: { type: "text"; text: string }[] } | null {
  if (lookupsThisSession >= SESSION_LOOKUP_CAP) {
    return text(
      `Session lookup cap reached (${SESSION_LOOKUP_CAP} credit-consuming lookups). ` +
        `This is a safety limit in the MCP server, not a StackScan balance problem. ` +
        `Stop and tell the user; they can raise STACKSCAN_SESSION_LOOKUP_CAP if more is intended.`,
    );
  }
  return null;
}

/** Record charged lookups, and keep the cached balance honest. */
function recordSpend(units = 1): void {
  lookupsThisSession += units;
  if (lastKnownBalance !== null) lastKnownBalance -= units;
}

/** Message for a lookup that found nothing. Explicit that it was free. */
function noDataNote(what: string): string {
  return `StackScan has no data for ${what}. No credit was charged.`;
}

/** Footer appended to successful lookups so the model can pace itself. */
function budgetNote(): string {
  const remaining = SESSION_LOOKUP_CAP - lookupsThisSession;
  const balance = lastKnownBalance === null ? "" : ` Account balance was ${lastKnownBalance} credits at last check.`;
  return `\n\n(Used 1 credit. ${remaining} of this session's ${SESSION_LOOKUP_CAP} lookups remaining.${balance})`;
}

const server = new McpServer({ name: "stackscan", version: "0.1.0" });

server.registerTool(
  "check_credits",
  {
    description:
      "Check the StackScan credit balance. Free - does not consume a credit. " +
      "Call this before a batch of lookups so you know how many you can afford.",
    inputSchema: {},
  },
  async () => {
    type Credits = {
      balance: number;
      credit_type: string;
      cost_per_successful_request: number;
      monthly: { available: number; used: number; remaining: number };
    };
    const result = await apiGet<Credits>("credits", {});
    if (!result.ok) return text(result.message);

    lastKnownBalance = result.data.balance;
    const d = result.data;
    return text(
      `StackScan credits\n` +
        `  Balance:          ${d.balance} (${d.credit_type})\n` +
        `  Cost per lookup:  ${d.cost_per_successful_request}\n` +
        `  Monthly:          ${d.monthly.remaining} remaining of ${d.monthly.available} (${d.monthly.used} used)\n` +
        `  This session:     ${lookupsThisSession} of ${SESSION_LOOKUP_CAP} lookups used`,
    );
  },
);

server.registerTool(
  "lookup_company",
  {
    description:
      "Given a domain, return the company behind it: name, industry, city, country, address and LinkedIn URL. " +
      "Use this when asked who owns or operates a website, or to enrich a domain into firmographics. " +
      "Costs 1 credit.",
    inputSchema: {
      domain: z.string().describe("Bare domain, e.g. shopify.com (no scheme, no path)"),
    },
  },
  async ({ domain }) => {
    const blocked = refuseIfCapReached();
    if (blocked) return blocked;

    type Company = {
      domain: string;
      last_updated: string;
      total_technologies_tracked: number;
      company: {
        name: string | null;
        industry: string | null;
        city: string | null;
        country: string | null;
        address: string | null;
        linkedin_url: string | null;
      };
    };
    const result = await apiGet<Company>("companies/lookup", { domain });
    if (!result.ok) return text(result.noData ? noDataNote(`the domain ${domain}`) : result.message);
    recordSpend();

    const c = result.data.company;
    // 14 not 12: "Technologies" is exactly 12 chars, so a 12-wide pad renders
    // it flush against its value ("Technologies30 tracked").
    const field = (label: string, value: string | null) => `  ${label.padEnd(14)}${value ?? "(not known)"}`;
    return text(
      `Company behind ${result.data.domain}\n` +
        [
          field("Name", c.name),
          field("Industry", c.industry),
          field("City", c.city),
          field("Country", c.country),
          field("Address", c.address),
          field("LinkedIn", c.linkedin_url),
          `  ${"Technologies".padEnd(14)}${result.data.total_technologies_tracked} tracked on this domain`,
          `  ${"Updated".padEnd(14)}${result.data.last_updated}`,
        ].join("\n") +
        budgetNote(),
    );
  },
);

server.registerTool(
  "lookup_domain_technologies",
  {
    description:
      "Given a domain, list the technologies detected on it (analytics, hosting, ecommerce platform, frameworks and so on), " +
      "each with its category and how many sites overall use it. " +
      "Use this to answer 'what is this site built with?'. Costs 1 credit.",
    inputSchema: {
      domain: z.string().describe("Bare domain, e.g. shopify.com (no scheme, no path)"),
      limit: z.number().int().min(1).max(50).optional().describe("Max technologies to return (default 25, cap 50)"),
    },
  },
  async ({ domain, limit }) => {
    const blocked = refuseIfCapReached();
    if (blocked) return blocked;

    type Domain = {
      domain: string;
      last_updated: string;
      technologies: Array<{
        name: string;
        parent_category: string | null;
        child_category: string | null;
        total_sites: number;
      }>;
      pagination: { total: number };
    };
    const result = await apiGet<Domain>("domains/lookup", { domain, per_page: limit ?? 25 });
    if (!result.ok) return text(result.noData ? noDataNote(`the domain ${domain}`) : result.message);
    recordSpend();

    const d = result.data;
    if (d.technologies.length === 0) {
      return text(`No technologies are tracked for ${d.domain}.${budgetNote()}`);
    }

    const rows = d.technologies.map((t) => {
      const category = [t.parent_category, t.child_category].filter(Boolean).join(" / ") || "uncategorised";
      return `  ${t.name} - ${category} (${t.total_sites.toLocaleString()} sites use this)`;
    });
    const shown = d.technologies.length;
    const more = d.pagination.total > shown ? `\n  ... ${d.pagination.total - shown} more not shown` : "";

    return text(
      `Technologies on ${d.domain} (${shown} of ${d.pagination.total}, updated ${d.last_updated})\n` +
        rows.join("\n") +
        more +
        budgetNote(),
    );
  },
);

server.registerTool(
  "lookup_technology",
  {
    description:
      "Given a technology name, return how widely it is used and its top countries by adoption. " +
      "Use this to size a market or compare platforms, e.g. 'how many sites run Shopify, and where?'. " +
      "Costs 1 credit.",
    inputSchema: {
      technology: z.string().describe("Technology name as StackScan knows it, e.g. Shopify, Klaviyo, Cloudflare"),
    },
  },
  async ({ technology }) => {
    const blocked = refuseIfCapReached();
    if (blocked) return blocked;

    type Tech = {
      stack: string;
      parent_category: string | null;
      child_category: string | null;
      total_websites: number;
      top_countries: Array<{ country: string; country_code: string; websites: number }>;
    };
    const result = await apiGet<Tech>("technologies/lookup", { technology });
    if (!result.ok) {
      return text(
        result.noData
          ? `${noDataNote(`the technology "${technology}"`)} The name must match StackScan's spelling - try the exact product name.`
          : result.message,
      );
    }
    recordSpend();

    const t = result.data;
    const category = [t.parent_category, t.child_category].filter(Boolean).join(" / ");
    const countries = t.top_countries
      .map((c) => `  ${c.country} - ${c.websites.toLocaleString()} sites`)
      .join("\n");

    return text(
      `${t.stack}\n` +
        (category ? `  Category: ${category}\n` : "") +
        `  Total sites detected: ${t.total_websites.toLocaleString()}\n` +
        (countries ? `\nTop countries\n${countries}` : "") +
        budgetNote(),
    );
  },
);

/**
 * Deliberately far below the API's own limit of 100 per request.
 *
 * A tool result goes straight into the model's context. A hundred full company
 * payloads is tens of thousands of tokens, which crowds out the conversation
 * the user is actually having and then has to be re-read to answer anything.
 * Twenty compact rows is a table a model can reason over. Anyone who genuinely
 * needs hundreds should be driving the REST endpoint, not an assistant.
 */
const BATCH_MAX = 20;

server.registerTool(
  "lookup_companies",
  {
    description:
      `Look up the companies behind up to ${BATCH_MAX} domains in ONE call, returned as a compact table. ` +
      "Prefer this over repeated lookup_company calls whenever you have several domains in hand - it is one " +
      "request instead of many, and costs the same per resolved domain. Duplicates and www. variants collapse " +
      "and are charged once. Costs 1 credit per domain that HAS data; misses and malformed domains are free.",
    inputSchema: {
      domains: z
        .array(z.string())
        .min(1)
        .max(BATCH_MAX)
        .describe(`Bare domains, e.g. ["shopify.com","stripe.com"]. Maximum ${BATCH_MAX}.`),
    },
  },
  async ({ domains }) => {
    // Collapse before checking affordability, so the budget is measured
    // against what will actually be charged rather than what was typed.
    const unique = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter((d) => d !== ""))];

    if (unique.length === 0) {
      return text("No usable domains were given.");
    }

    const remaining = SESSION_LOOKUP_CAP - lookupsThisSession;

    if (remaining <= 0) {
      return refuseIfCapReached()!;
    }

    // Refuse rather than silently truncate. Quietly dropping domains would
    // give the model an answer that looks complete and is not.
    if (unique.length > remaining) {
      return text(
        `That would cost up to ${unique.length} credits, but only ${remaining} of this session's ` +
          `${SESSION_LOOKUP_CAP}-lookup cap remain. Nothing was charged. Ask for ${remaining} domains or fewer, ` +
          `or tell the user they can raise STACKSCAN_SESSION_LOOKUP_CAP.`,
      );
    }

    type BatchResult = {
      success: boolean;
      domain?: string;
      error?: string;
      total_technologies_tracked?: number;
      company?: {
        name: string | null;
        industry: string | null;
        city: string | null;
        country: string | null;
        linkedin_url: string | null;
      };
    };
    type Batch = {
      requested: number;
      resolved: number;
      served: number;
      credits_charged: number;
      results: BatchResult[];
      not_found: string[];
      invalid: string[];
      skipped_insufficient_credits: string[];
    };

    const result = await apiPost<Batch>("companies/batch", { domains: unique });
    if (!result.ok) return text(result.message);

    const d = result.data;

    // Trust the server's own figure rather than counting rows: it is what was
    // actually billed, and it already accounts for collapsed duplicates.
    recordSpend(d.credits_charged);

    const hits = d.results.filter((r) => r.success && r.company);

    /**
     * Clip to TWO less than the column width, so a value that fills its column
     * still leaves a gutter. Clipping to the full width lets a long name run
     * straight into the next column ("…longdomainnaAn Extremely Long Compa…"),
     * which turns the table back into unreadable soup - the exact thing the
     * compact format exists to avoid.
     */
    const cell = (v: string | null | undefined, width: number) => {
      const s = (v ?? "-").trim() || "-";
      const max = width - 2;
      return (s.length > max ? s.slice(0, max - 1) + "…" : s).padEnd(width);
    };

    const lines = [
      `${d.requested} domains requested, ${hits.length} with data (${d.credits_charged} credits).`,
      "",
      `  ${"DOMAIN".padEnd(26)}${"COMPANY".padEnd(24)}${"INDUSTRY".padEnd(20)}${"COUNTRY".padEnd(16)}TECH`,
      ...hits.map(
        (r) =>
          `  ${cell(r.domain, 26)}${cell(r.company!.name, 24)}` +
          `${cell(r.company!.industry, 20)}${cell(r.company!.country, 16)}` +
          `${r.total_technologies_tracked ?? 0}`,
      ),
    ];

    // LinkedIn URLs are too long for the table but are usually the reason
    // someone asked, so they follow underneath rather than being dropped.
    const withLinkedIn = hits.filter((r) => r.company!.linkedin_url);
    if (withLinkedIn.length > 0) {
      lines.push("", "  LinkedIn:");
      for (const r of withLinkedIn) {
        lines.push(`    ${cell(r.domain, 28)}${r.company!.linkedin_url}`);
      }
    }

    if (d.not_found.length > 0) {
      lines.push("", `  No data (not charged): ${d.not_found.join(", ")}`);
    }
    if (d.invalid.length > 0) {
      lines.push("", `  Not valid domains (not charged): ${d.invalid.join(", ")}`);
    }
    // The account ran dry mid-request. Distinct from "no data": these are worth
    // retrying after a top-up, and the model should say so rather than report
    // them as having nothing.
    if (d.skipped_insufficient_credits.length > 0) {
      lines.push(
        "",
        `  NOT looked up - the account ran out of credits: ${d.skipped_insufficient_credits.join(", ")}`,
        "  These still have data. Retry them after topping up.",
      );
    }

    const spent = SESSION_LOOKUP_CAP - lookupsThisSession;
    const balance = lastKnownBalance === null ? "" : ` Account balance was ${lastKnownBalance} credits at last check.`;
    lines.push(
      "",
      `(Used ${d.credits_charged} credits. ${spent} of this session's ${SESSION_LOOKUP_CAP} lookups remaining.${balance})`,
    );

    return text(lines.join("\n"));
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`stackscan-mcp running on stdio (api: ${API_BASE}, session cap: ${SESSION_LOOKUP_CAP} lookups)`);
}

main().catch((error) => {
  console.error("stackscan-mcp: fatal error:", error);
  process.exit(1);
});
