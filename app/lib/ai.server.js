// app/lib/ai.server.js
//
// Claude API integration for the Prep page's Generate/Regenerate buttons.
// Reads the shop's AiSettings row (API key encrypted at rest — see
// crypto.server.js — decrypted only here, server-side) and calls the Claude
// Messages API via @anthropic-ai/sdk. The decrypted key never leaves this
// file: callers get generated text back, never the key itself. Also runs a
// cheap, shared Haiku "research" call (see researchComparableListings) when
// web search is enabled, instead of attaching search directly to the
// (possibly expensive) writer call.

import Anthropic from "@anthropic-ai/sdk";
import prisma from "../db.server.js";
import { encrypt, decrypt } from "./crypto.server.js";

export const AI_MODEL_OPTIONS = [
  { value: "claude-opus-5", label: "Claude Opus 5 — highest quality, highest cost" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5 — balanced (recommended)" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fastest & cheapest" },
];
const VALID_MODELS = AI_MODEL_OPTIONS.map((o) => o.value);
const DEFAULT_MODEL = "claude-sonnet-5";

export const DEFAULT_TITLE_SYSTEM_PROMPT =
  "You are an e-commerce copywriter for a secondhand/resale shop. Write a single, " +
  "concise, accurate, SEO-friendly product title (no more than about 70 characters) " +
  "from the product details you're given. Do not invent details that weren't provided " +
  "(brand, size, color, condition) and don't include the price. " +
  "Respond with ONLY the title text — no quotes, no labels, no explanation, no preamble " +
  "like 'Here's a title:' or 'Based on...' — the very first character of your response " +
  "must be the first character of the title itself.";

export const DEFAULT_DESCRIPTION_SYSTEM_PROMPT =
  "You are an e-commerce copywriter for a secondhand/resale shop. Write a compelling " +
  "product description as clean HTML (a short paragraph, optionally followed by a " +
  "<ul> of key details) using only <p>, <ul>, <li>, <strong>, and <em> tags. Do not " +
  "invent details that weren't provided and don't include a heading/title or the price. " +
  "Respond with ONLY the HTML — no markdown, no code fences, no explanation. " +
  "Never wrap your output in triple backticks or a ```html block — write the raw HTML tags directly.";

// ── Settings page: read/write (never decrypts the key for display) ────────

export async function getAiSettingsForDisplay(shopId) {
  const row = await prisma.aiSettings.findUnique({ where: { shopId } });
  return {
    titleSystemPrompt: row?.titleSystemPrompt || DEFAULT_TITLE_SYSTEM_PROMPT,
    descriptionSystemPrompt: row?.descriptionSystemPrompt || DEFAULT_DESCRIPTION_SYSTEM_PROMPT,
    model: row?.model || DEFAULT_MODEL,
    webSearchEnabled: row?.webSearchEnabled ?? false,
    hasApiKey: !!row?.apiKeyEncrypted,
    apiKeyPreview: row?.apiKeyEncrypted ? maskKey(decrypt(row.apiKeyEncrypted)) : null,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

function maskKey(key) {
  return key.length > 4 ? `•••• ${key.slice(-4)}` : "•••• saved";
}

// Only re-encrypts and overwrites the stored key when a real new value was
// submitted — the masked placeholder shown in the form is never treated as
// a new key by the caller (the route strips it before calling this).
export async function saveAiSettings(
  shopId,
  { apiKey, titleSystemPrompt, descriptionSystemPrompt, model, webSearchEnabled, updatedBy },
) {
  const data = {
    titleSystemPrompt: titleSystemPrompt?.trim() || null,
    descriptionSystemPrompt: descriptionSystemPrompt?.trim() || null,
    model: VALID_MODELS.includes(model) ? model : DEFAULT_MODEL,
    webSearchEnabled: !!webSearchEnabled,
    updatedBy: updatedBy ?? null,
  };

  if (apiKey && apiKey.trim()) {
    data.apiKeyEncrypted = encrypt(apiKey.trim());
  }

  await prisma.aiSettings.upsert({
    where: { shopId },
    create: { shopId, ...data },
    update: data,
  });
}

export async function clearApiKey(shopId) {
  await prisma.aiSettings.updateMany({
    where: { shopId },
    data: { apiKeyEncrypted: null },
  });
}

// ── Generation ──────────────────────────────────────────────────────────

// Internal only — loads the decrypted key for an actual Claude call. Never
// exported; nothing outside this file ever sees a decrypted key.
async function getAiSettingsForCall(shopId) {
  const row = await prisma.aiSettings.findUnique({ where: { shopId } });
  if (!row?.apiKeyEncrypted) {
    throw new Error("No Claude API key configured yet — add one in AI Settings.");
  }
  return {
    apiKey: decrypt(row.apiKeyEncrypted),
    titleSystemPrompt: row.titleSystemPrompt || DEFAULT_TITLE_SYSTEM_PROMPT,
    descriptionSystemPrompt: row.descriptionSystemPrompt || DEFAULT_DESCRIPTION_SYSTEM_PROMPT,
    model: VALID_MODELS.includes(row.model) ? row.model : DEFAULT_MODEL,
    webSearchEnabled: row.webSearchEnabled ?? false,
  };
}

// Only ebay.com — never the open web — and capped at a few searches. Was
// also allowing amazon.com, but real AiUsageLog data showed research
// averaging ~12k input tokens/call (vs ~1k for title/description) with raw
// search-result content as the dominant cost driver, and Amazon rarely
// carries true secondhand/resale comps for this shop's inventory anyway —
// dropping it shrinks what the single search call pulls back at no quality
// cost. Only ever called with RESEARCH_MODEL now (see
// researchComparableListings below) — the writer call no longer attaches
// any tool — but kept parameterized on `model` since the branch is cheap
// and this stays a faithful record of the real API constraint (Haiku 4.5
// only supports the basic 20250305 variant, not the newer dynamic-
// filtering 20260209 one).
function webSearchTool(model) {
  return {
    type: model === "claude-haiku-4-5" ? "web_search_20250305" : "web_search_20260209",
    name: "web_search",
    // Was 3 — real AiUsageLog data showed the research call hitting that
    // ceiling essentially every time, and raw search-result content is the
    // dominant cost driver on these calls. Testing 1 to see whether a
    // single search still produces a usable "general pattern" summary,
    // since that's all this call needs (not exhaustive comparison
    // shopping). Revert to a higher value if 1 proves too thin.
    max_uses: 1,
    allowed_domains: ["ebay.com", "www.ebay.com"],
  };
}

// Always Haiku, regardless of the shop's configured writer model — that's
// the entire point of moving research off the (possibly Opus/Sonnet)
// writer call. Known trade-off, only relevant to Opus/Sonnet-configured
// shops (Haiku-configured shops see no change here — Haiku was already on
// the basic search tool): Haiku only supports web_search_20250305, not the
// newer dynamic-filtering 20260209 variant (~24% more raw search-result
// tokens read, per Anthropic's own figures). Still a large net win, since
// Haiku's per-token rate is a much bigger multiplier than that 24% — but
// revisit this constant if Anthropic ever extends dynamic filtering to
// Haiku, since that would remove the trade-off entirely.
const RESEARCH_MODEL = "claude-haiku-4-5";

const RESEARCH_SYSTEM_PROMPT =
  "You research how comparable secondhand/resale items are listed on eBay. " +
  "You have a web_search tool restricted to ebay.com — use it to look at a " +
  "handful of comparable listings for the item described below. Then respond with a short " +
  "(2-4 sentence) plain-text summary of the typical title structure and description " +
  "conventions you observed — general patterns only. Do not quote or list specific listings, " +
  "prices, sellers, or URLs, and do not mention that you searched.";

// Replaces the old WEB_SEARCH_INSTRUCTION now that the writer call no
// longer does its own tool-use reasoning — this just tells it how to use
// research context that may already be sitting in the user message.
const RESEARCH_CONTEXT_INSTRUCTION =
  "\n\nYou may be given a short 'Comparable listings research' summary of how similar items " +
  "are typically titled and described on eBay. Use it as grounding for realistic, " +
  "buyer-facing conventions, but never mention it, cite it, or refer to 'the research' or " +
  "'similar listings' in your output.";

// Cap on the existing-description context sent for generation (see
// existingDescriptionForPrompt below). Was previously the entire raw,
// untruncated bodyHtml — the #1 source of input-token cost.
const EXISTING_DESCRIPTION_MAX_CHARS = 400;

// Relocated from app/routes/app.prepb.jsx:92-107 — was dead code there
// (confirmed zero call sites), now used to shrink bodyHtml for the
// generation prompt below.
export function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Cuts at the last word boundary at or before maxChars, never mid-word.
export function truncateAtWordBoundary(text, maxChars) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  const slice = collapsed.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

function existingDescriptionForPrompt(bodyHtml) {
  const text = htmlToText(bodyHtml);
  if (!text) return "";
  return truncateAtWordBoundary(text, EXISTING_DESCRIPTION_MAX_CHARS);
}

// Defensive cleanup for model output. Smaller/cheaper models (notably
// Haiku) are less reliable about "respond with ONLY..." instructions and
// may wrap output in a markdown code fence or prefix it with commentary
// about how the answer was produced. Runs on every response regardless of
// model or call type — structured outputs constrain the JSON *shape*, not
// what characters end up inside a string value, so this stays as a
// defense-in-depth layer underneath output_config.format.
export function sanitizeGeneratedText(raw) {
  let text = String(raw ?? "").trim();

  // Strip a leading meta-commentary preamble before the real content.
  // Compound preambles ("Based on X, here's the description: Y") need more
  // than one pass — keep stripping until a full pass makes no further change.
  const preamblePatterns = [
    /^here(?:'s| is)[^:\n]{0,80}:\s*/i,
    /^(?:based on|according to|after (?:researching|reviewing|searching)|i (?:found|searched|checked|looked))[^\n]{0,140}?[:,]\s*/i,
    /^(?:title|description)\s*:\s*/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of preamblePatterns) {
      const next = text.replace(pattern, "").trim();
      if (next !== text) { text = next; changed = true; }
    }
  }

  // Strip a code fence wrapping the whole response, e.g. ```html\n...\n```
  const fenced = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1].trim();

  // Strip wrapping quotes some models add around a short "title" answer.
  const quoted = text.match(/^["'"](.+)["'"]$/s);
  if (quoted) text = quoted[1].trim();

  return text;
}

// Stable, structured product context first; research/instruction context
// goes last, after the (potentially cached) system prompt.
function buildUserPrompt({ kind, productContext, additionalInstruction, comparableResearch }) {
  const lines = ["Product details:"];
  const push = (label, value) => {
    if (value) lines.push(`- ${label}: ${value}`);
  };

  push("Vendor", productContext.vendor);
  push("Product type", productContext.productType);
  push("Category", productContext.categoryName);
  push("Condition", productContext.condition);
  push("Tags", productContext.tags);
  // Trimmed for both kinds now — was previously raw, untruncated bodyHtml,
  // and previously dropped entirely for title generation, but some shops'
  // title prompts do draw on the existing description for detail.
  push("Existing description", existingDescriptionForPrompt(productContext.bodyHtml));
  push(kind === "title" ? "Current title" : "Title", productContext.title);

  if (comparableResearch?.trim()) {
    lines.push("", `Comparable listings research: ${comparableResearch.trim()}`);
  }

  if (additionalInstruction?.trim()) {
    lines.push("", `Additional instruction for this generation: ${additionalInstruction.trim()}`);
  }

  lines.push("", kind === "title" ? "Generate the title now." : "Generate the HTML description now.");
  return lines.join("\n");
}

// Structured-output schema for the writer call. Same generic {text: string}
// shape for both kinds. Deliberately does NOT name specific tags/format
// rules here — that lives entirely in the system prompt (which a shop can
// fully replace with its own format, e.g. a custom HTML skeleton). Hardcoding
// a tag allowlist in the schema description would fight a custom prompt that
// requires different structure.
function buildOutputSchema(kind) {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            kind === "title"
              ? "The generated product title, formatted exactly as instructed in the system prompt."
              : "The generated product description, formatted exactly as instructed in the system " +
                "prompt (including any required HTML structure, tags, or sections).",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  };
}

function buildResearchPrompt(productContext) {
  const lines = ["Item details:"];
  const push = (label, value) => {
    if (value) lines.push(`- ${label}: ${value}`);
  };
  push("Vendor", productContext.vendor);
  push("Product type", productContext.productType);
  push("Category", productContext.categoryName);
  push("Condition", productContext.condition);
  push("Current title", productContext.title);
  lines.push(
    "",
    "Search eBay for comparable listings, then summarize typical title structure " +
      "and description conventions.",
  );
  return lines.join("\n");
}

function buildResearchOutputSchema() {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "A 2-4 sentence plain-text summary of typical title structure and description " +
            "conventions for comparable listings. No URLs, prices, seller names, or quotes " +
            "from specific listings.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  };
}

// Fire-and-safe usage logging — wrapped so a DB failure here can never
// break generation (mirrors the existing swallow-and-log pattern already
// used in this codebase, e.g. detectAndWriteChanges in sync.server.js).
// Called once per Claude API call — the writer call and, separately, the
// research call — so a product's title+description clicks in one session
// produce up to 3 rows total (2 writer + 1 shared research), not 4.
async function logAiUsageSafely({ shopId, callType, model, usage }) {
  try {
    await prisma.aiUsageLog.create({
      data: {
        shopId,
        callType,
        model,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
        webSearchCount: usage?.server_tool_use?.web_search_requests ?? 0,
      },
    });
  } catch (err) {
    console.error("[logAiUsageSafely] Failed to write AiUsageLog:", callType, err);
  }
}

// Runs once per product per Prep session — the caller (generateProductText
// below, and ultimately the route/client) is responsible for caching the
// returned summary across a product's title-click and description-click so
// this only runs once per product, not once per field-click.
async function researchComparableListings({ shopId, productContext, settings }) {
  const client = new Anthropic({ apiKey: settings.apiKey });
  // cache_control here is currently a permanent no-op: RESEARCH_SYSTEM_PROMPT
  // is ~110 tokens and hardcoded (no AI Settings control over it), while
  // claude-haiku-4-5 only caches prefixes above ~4096 tokens. Kept for
  // symmetry with the writer call, and in case this prompt ever grows or
  // becomes configurable. Default 5-min TTL for the same reason as there —
  // see generateProductText's cache_control comment for the full rationale.
  const requestParams = {
    model: RESEARCH_MODEL,
    max_tokens: 1000,
    system: [
      { type: "text", text: RESEARCH_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: buildResearchPrompt(productContext) }],
    tools: [webSearchTool(RESEARCH_MODEL)],
    output_config: { format: buildResearchOutputSchema() },
  };

  let response;
  try {
    response = await client.messages.parse(requestParams);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error("Claude rejected the API key — check it in AI Settings.");
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error("Claude is rate-limiting this key right now — try again in a moment.");
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Claude API error: ${err.message}`);
    }
    throw err;
  }

  // Log real spend even if the checks below end up throwing (a refused or
  // truncated call still cost tokens).
  await logAiUsageSafely({ shopId, callType: "research", model: RESEARCH_MODEL, usage: response.usage });

  // pause_turn belongs here now, not on the writer call — this is the only
  // remaining call that attaches a tool, so it's the only one whose
  // server-side tool-use loop can hit the 10-iteration pause_turn cap.
  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined the comparable-listings research.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Comparable-listings research was cut off.");
  }
  if (response.stop_reason === "pause_turn") {
    throw new Error("Comparable-listings web search took too long to finish.");
  }

  const summary = response.parsed_output?.summary;
  if (!summary?.trim()) {
    throw new Error("Comparable-listings research returned an empty response.");
  }
  return sanitizeGeneratedText(summary);
}

export async function generateProductText({
  shopId, kind, productContext, additionalInstruction, comparableResearch,
}) {
  if (kind !== "title" && kind !== "description") {
    throw new Error(`Unknown generation kind: ${kind}`);
  }

  const settings = await getAiSettingsForCall(shopId);

  // Reuse research passed in by the caller (the route round-trips a
  // product's first-click summary back on its second click — see
  // app.prepb.jsx) rather than re-fetching. A research failure degrades to
  // "no research", not a failed generation — same as if web search were off.
  let research = comparableResearch || null;
  if (!research && settings.webSearchEnabled) {
    try {
      research = await researchComparableListings({ shopId, productContext, settings });
    } catch (err) {
      console.error("[generateProductText] Comparable-listings research failed, continuing without it:", err);
      research = null;
    }
  }

  const baseSystemPrompt = kind === "title" ? settings.titleSystemPrompt : settings.descriptionSystemPrompt;
  const systemPrompt = settings.webSearchEnabled ? baseSystemPrompt + RESEARCH_CONTEXT_INSTRUCTION : baseSystemPrompt;
  const client = new Anthropic({ apiKey: settings.apiKey });

  // No more +1000 web-search headroom — the writer no longer runs its own
  // tool-use turns, so it never needs it.
  const maxTokens = kind === "title" ? 500 : 2000;
  // cache_control below is inert for the built-in prompts: prefix caching
  // only engages above a per-model minimum (~512 tokens for claude-opus-5,
  // ~1024 for claude-sonnet-5, ~4096 for claude-haiku-4-5), and the default
  // title/description prompts are only ~130 tokens each. It starts doing
  // something only once a shop pastes a long custom prompt into AI Settings
  // that clears that bar — it's kept for exactly that case. Default 5-min
  // TTL, not "1h": Prep is a bulk tool, Generate clicks land seconds-to-
  // minutes apart and keep the window warm, and the cache-write premium is
  // 1.25x vs 2x for "1h". Confirm with AiUsageLog.cacheReadTokens before
  // assuming this saves anything.
  const requestParams = {
    model: settings.model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: buildUserPrompt({ kind, productContext, additionalInstruction, comparableResearch: research }),
      },
    ],
    output_config: { format: buildOutputSchema(kind) },
  };
  // effort is rejected on Haiku 4.5 — only Opus 5 / Sonnet 5 accept it.
  if (settings.model !== "claude-haiku-4-5") {
    requestParams.output_config.effort = "low";
  }
  // No `tools` here anymore — search moved entirely to researchComparableListings above.

  let response;
  try {
    response = await client.messages.parse(requestParams);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error("Claude rejected the API key — check it in AI Settings.");
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error("Claude is rate-limiting this key right now — try again in a moment.");
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Claude API error: ${err.message}`);
    }
    throw err;
  }

  await logAiUsageSafely({ shopId, callType: kind, model: settings.model, usage: response.usage });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to generate this — try rephrasing the additional instruction.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude's response was cut off — try a shorter additional instruction, then try again.");
  }
  // pause_turn is no longer possible here — the writer call attaches no
  // tools, so there's no server-side tool-use loop left to pause.

  const text = response.parsed_output?.text;
  if (!text?.trim()) {
    throw new Error("Claude returned an empty response — try again.");
  }

  return { text: sanitizeGeneratedText(text), comparableResearch: research };
}
