#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { runMultisheetReport } from "ai-brand-visibility-checker";

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), "configs", "audit_config.json");
const DEFAULT_QUERY_WORKBOOK = path.join(process.cwd(), "AI Agent_Master Audit_Shopify.xlsx");
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "output", "spreadsheet");
const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.VISIBILITY_REQUEST_TIMEOUT_MS || 90000);
const DEFAULT_CHECKPOINT_EVERY = Number(process.env.VISIBILITY_CHECKPOINT_EVERY || 10);
const DEFAULT_FETCH_RETRIES = Number(process.env.VISIBILITY_FETCH_RETRIES || 3);
const DEFAULT_FETCH_RETRY_BASE_MS = Number(process.env.VISIBILITY_FETCH_RETRY_BASE_MS || 2000);
const OUTPUT_HEADERS = [
  "Checked On",
  "Platform",
  "Model Used",
  "Query",
  "Intent",
  "Target Brand Name",
  "Target brand website",
  "Brand Mentioned",
  "Brand Position",
  "Top 3 Brands in order",
  "Sentiment",
  "Response Type",
  "Notes",
  "citations_json",
  "status",
  "error",
];

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDotEnv(filePath = path.join(process.cwd(), ".env")) {
  const parsed = parseEnvFile(filePath);
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG_PATH,
    input: DEFAULT_QUERY_WORKBOOK,
    output: "",
    providers: process.env.VISIBILITY_PROVIDERS || "openai_or",
    providersExplicit: false,
    analysisProvider: process.env.ANALYSIS_PROVIDER || "openai",
    analysisOpenaiModel: process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1-mini",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    openrouterModel: process.env.OPENROUTER_MODEL || "anthropic/claude-3.5-haiku",
    openrouterOpenaiModel: process.env.OPENROUTER_OPENAI_MODEL || "openai/gpt-4.1-mini",
    openrouterClaudeModel:
      process.env.OPENROUTER_CLAUDE_MODEL ||
      process.env.CLAUDE_MODEL ||
      process.env.OPENROUTER_MODEL ||
      "anthropic/claude-3.5-haiku",
    openrouterGeminiModel: process.env.OPENROUTER_GEMINI_MODEL || "google/gemini-2.5-flash-lite",
    openrouterSonarModel: process.env.OPENROUTER_SONAR_MODEL || process.env.SONAR_MODEL || "perplexity/sonar",
    openrouterPerplexityModel: process.env.OPENROUTER_SONAR_MODEL || process.env.SONAR_MODEL || "perplexity/sonar",
    claudeApiModel: process.env.CLAUDE_API_MODEL || "claude-haiku-4-5-20251001",
    claudeApiMaxTokens: Number(process.env.CLAUDE_API_MAX_TOKENS || 300),
    claudeApiMinIntervalMs: Number(process.env.CLAUDE_API_MIN_INTERVAL_MS || 13000),
    openaiMinIntervalMs: Number(process.env.OPENAI_MIN_INTERVAL_MS || 2500),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    ollamaModel: process.env.MODEL_NAME || "qwen2.5:7b",
    sheets: "",
    maxQueriesPerSheet: 0,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    checkpointEvery: DEFAULT_CHECKPOINT_EVERY,
    fetchRetries: DEFAULT_FETCH_RETRIES,
    fetchRetryBaseMs: DEFAULT_FETCH_RETRY_BASE_MS,
    fresh: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--config") {
      args.config = next;
      index += 1;
    } else if (current === "--input") {
      args.input = next;
      index += 1;
    } else if (current === "--output") {
      args.output = next;
      index += 1;
    } else if (current === "--providers") {
      args.providers = next;
      args.providersExplicit = true;
      index += 1;
    } else if (current === "--analysis-provider") {
      args.analysisProvider = next;
      index += 1;
    } else if (current === "--analysis-openai-model") {
      args.analysisOpenaiModel = next;
      index += 1;
    } else if (current === "--openai-model") {
      args.openaiModel = next;
      index += 1;
    } else if (current === "--openrouter-model") {
      args.openrouterModel = next;
      index += 1;
    } else if (current === "--openrouter-openai-model") {
      args.openrouterOpenaiModel = next;
      index += 1;
    } else if (current === "--openrouter-claude-model") {
      args.openrouterClaudeModel = next;
      index += 1;
    } else if (current === "--openrouter-gemini-model") {
      args.openrouterGeminiModel = next;
      index += 1;
    } else if (current === "--openrouter-sonar-model") {
      args.openrouterSonarModel = next;
      index += 1;
    } else if (current === "--openrouter-perplexity-model") {
      args.openrouterPerplexityModel = next;
      index += 1;
    } else if (current === "--claude-api-model") {
      args.claudeApiModel = next;
      index += 1;
    } else if (current === "--claude-api-max-tokens") {
      args.claudeApiMaxTokens = Number(next);
      index += 1;
    } else if (current === "--claude-api-min-interval-ms") {
      args.claudeApiMinIntervalMs = Number(next);
      index += 1;
    } else if (current === "--openai-min-interval-ms") {
      args.openaiMinIntervalMs = Number(next);
      index += 1;
    } else if (current === "--ollama-base-url") {
      args.ollamaBaseUrl = next;
      index += 1;
    } else if (current === "--ollama-model") {
      args.ollamaModel = next;
      index += 1;
    } else if (current === "--sheets") {
      args.sheets = next;
      index += 1;
    } else if (current === "--max-queries-per-sheet") {
      args.maxQueriesPerSheet = Number(next || 0);
      index += 1;
    } else if (current === "--request-timeout-ms") {
      args.requestTimeoutMs = Number(next || 0);
      index += 1;
    } else if (current === "--checkpoint-every") {
      args.checkpointEvery = Number(next || 0);
      index += 1;
    } else if (current === "--fetch-retries") {
      args.fetchRetries = Number(next || 0);
      index += 1;
    } else if (current === "--fetch-retry-base-ms") {
      args.fetchRetryBaseMs = Number(next || 0);
      index += 1;
    } else if (current === "--fresh") {
      args.fresh = true;
    } else if (current === "--help" || current === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${current}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/generate_brand_visibility_report.mjs [options]

Options:
  --config <path>                     Config JSON path
  --input <path>                      Workbook containing visibility tracker query sheets
  --output <path>                     Output visibility-report workbook
  --providers <list>                  Force these providers for every tracker row
  --analysis-provider <name>          openai|ollama
  --analysis-openai-model <name>      Model used for mention analysis
  --openai-model <name>               OpenAI generation model
  --openrouter-model <name>           Generic OpenRouter model
  --openrouter-openai-model <name>    OpenAI-family model on OpenRouter
  --openrouter-claude-model <name>    Claude-family model on OpenRouter
  --openrouter-gemini-model <name>    Gemini-family model on OpenRouter
  --openrouter-sonar-model <name>     Sonar model on OpenRouter
  --openrouter-perplexity-model <name> Perplexity model on OpenRouter
  --claude-api-model <name>           Anthropic model for direct Claude API
  --sheets <list>                     Optional comma-separated site labels/domains/sheet names
  --max-queries-per-sheet <n>         Limit live queries per sheet for small verification runs
  --request-timeout-ms <n>            Abort provider/analysis requests that exceed this timeout
  --checkpoint-every <n>              Save partial workbook/checkpoint every N completed rows
  --fetch-retries <n>                 Retry failed fetches this many times before giving up
  --fetch-retry-base-ms <n>           Base backoff used between fetch retries
  --fresh                             Ignore any resumable checkpoint for the chosen output path
`);
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function defaultOutputPath() {
  return path.join(DEFAULT_OUTPUT_DIR, `AI_Brand_Visibility_Report_${isoDate()}.xlsx`);
}

function checkpointPathFor(outputPath) {
  return outputPath.replace(/\.xlsx$/i, ".checkpoint.json");
}

function loadConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installFetchTimeout(timeoutMs, fetchRetries, fetchRetryBaseMs) {
  if (!timeoutMs || timeoutMs <= 0 || typeof globalThis.fetch !== "function") {
    return;
  }
  const baseFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    if (init?.signal) {
      return baseFetch(input, init);
    }
    let lastError = null;
    for (let attempt = 0; attempt <= fetchRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await baseFetch(input, { ...init, signal: controller.signal });
      } catch (error) {
        const message = error?.name === "AbortError" ? `Request timed out after ${timeoutMs}ms` : String(error?.message || error);
        lastError = new Error(message);
        if (attempt >= fetchRetries) {
          throw lastError;
        }
        const waitMs = Math.max(fetchRetryBaseMs, 0) * (attempt + 1);
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error("fetch failed");
  };
}

function mapTrackerPlatform(value) {
  const lower = String(value || "").trim().toLowerCase();
  if (!lower) return [];
  if (lower.includes("chatgpt") || lower.includes("openai") || lower.includes("gpt")) return ["openai_or"];
  if (lower.includes("claude")) return ["claude"];
  if (lower.includes("gemini")) return ["gemini"];
  if (lower.includes("perplexity")) return ["perplexity"];
  if (lower.includes("sonar")) return ["sonar"];
  return [];
}

function shouldIncludeSite(site, selectedSheets) {
  if (!selectedSheets.length) return true;
  const candidates = [
    site.domain,
    site.label,
    site.visibility_sheet,
    site.visibility_report_sheet,
  ].map((item) => String(item || "").trim().toLowerCase());
  return selectedSheets.some((selected) => candidates.includes(selected));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function resolveSourceSheet(workbook, site) {
  if (workbook.Sheets[site.visibility_sheet]) {
    return site.visibility_sheet;
  }
  if (workbook.Sheets[site.visibility_report_sheet]) {
    return site.visibility_report_sheet;
  }
  return "";
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAlias(query, alias, canonicalBrandName) {
  const aliasText = String(alias || "").trim();
  if (!aliasText) {
    return query;
  }
  const pattern = aliasText
    .split(/\s+/)
    .map((part) => escapeRegex(part))
    .join("\\s+");
  return query.replace(new RegExp(`\\b${pattern}\\b`, "gi"), canonicalBrandName);
}

function normalizeBrandQuery(query, site, canonicalBrandName) {
  let normalized = String(query || "").trim();
  if (!normalized) {
    return "";
  }

  const aliases = new Set([
    site.label,
    site.visibility_report_sheet,
    String(site.domain || "").split(".")[0],
  ]);

  const lowerContext = `${canonicalBrandName} ${site.label} ${site.visibility_report_sheet} ${site.domain}`.toLowerCase();
  if (lowerContext.includes("dreamisfree") || lowerContext.includes("dream is free")) {
    aliases.add("Dream Is Free");
    aliases.add("dreamisfree");
  }

  for (const alias of aliases) {
    if (String(alias || "").trim().toLowerCase() === canonicalBrandName.toLowerCase()) {
      continue;
    }
    normalized = replaceAlias(normalized, alias, canonicalBrandName);
  }

  return normalized;
}

function normalizeQueryRows(workbook, sites, defaultProviders, selectedSheets, maxQueriesPerSheet, useRowProviders) {
  const sheetRowsByName = {};
  for (const site of sites) {
    if (!shouldIncludeSite(site, selectedSheets)) {
      continue;
    }
    const sourceSheetName = resolveSourceSheet(workbook, site);
    if (!sourceSheetName) {
      continue;
    }
    const sheet = workbook.Sheets[sourceSheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const canonicalBrandName = firstNonEmpty(
      ...rawRows.map((row) => row["Target Brand Name"] || row.target_brand),
      site.label
    );
    const canonicalDomain = firstNonEmpty(
      ...rawRows.map((row) => row["Target brand website"] || row.target_domain),
      site.domain
    );
    const seenQueries = new Set();
    const queryRows = [];

    for (const row of rawRows) {
      const providers = useRowProviders
        ? mapTrackerPlatform(row.Platform || row.platform || row.Provider || row.provider)
        : [];
      const query = normalizeBrandQuery(row.Query || row.query || "", site, canonicalBrandName);
      const intent = String(row.Intent || row.intent || "").trim();
      const key = `${query.toLowerCase()}::${intent.toLowerCase()}`;
      if (!query || seenQueries.has(key)) {
        continue;
      }
      seenQueries.add(key);
      queryRows.push({
        Query: query,
        Intent: intent,
        "Target Brand Name": canonicalBrandName,
        "Target brand website": canonicalDomain,
        Notes: String(row.Notes || row.notes || "").trim(),
        providers: providers.length ? providers.join(",") : defaultProviders.join(","),
      });
    }

    sheetRowsByName[site.visibility_report_sheet] =
      maxQueriesPerSheet > 0 ? queryRows.slice(0, maxQueriesPerSheet) : queryRows;
  }
  return sheetRowsByName;
}

function countExpectedItems(sheetRowsByName) {
  return Object.values(sheetRowsByName).reduce((sum, rows) => {
    return (
      sum +
      rows.reduce((rowSum, row) => {
        const providers = parseList(row.providers);
        return rowSum + Math.max(providers.length, 1);
      }, 0)
    );
  }, 0);
}

function trimOutputColumns(rows) {
  return rows.map((row) => {
    const trimmed = {};
    const remark = buildRemark(row);
    for (const header of OUTPUT_HEADERS) {
      trimmed[header] = header === "Notes" ? remark : row[header] ?? "";
    }
    return trimmed;
  });
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function buildRemark(row) {
  const notes = [];
  const rank = String(row["Brand Position"] || "").trim();
  const mentioned = String(row["Brand Mentioned"] || "").trim().toUpperCase() === "Y";
  const citations = safeParseJson(row.citations_json);
  const targetDomain = String(row["Target brand website"] || "").trim().toLowerCase().replace(/^https?:\/\//, "");
  const top3 = String(row["Top 3 Brands in order"] || "").trim();
  const status = String(row.status || "").trim().toLowerCase();
  const error = String(row.error || "").trim();
  const targetCitations = citations.filter((item) => String(item || "").toLowerCase().includes(targetDomain));
  const productCitations = targetCitations.filter((item) => String(item || "").toLowerCase().includes("/products/"));

  if (status === "error") {
    return error ? `Run failed: ${error}` : "Run failed.";
  }

  if (mentioned && rank) {
    notes.push(`Mentioned at rank ${rank}.`);
  } else if (mentioned) {
    notes.push("Mentioned, but rank could not be resolved.");
  } else {
    notes.push("Target brand was not mentioned.");
  }

  if (productCitations.length) {
    notes.push(`AI cited ${productCitations.length} target product URL(s).`);
  } else if (targetCitations.length) {
    notes.push(`AI cited ${targetCitations.length} target site source(s), but not a product URL.`);
  } else {
    notes.push("No target-domain citations were captured.");
  }

  if (top3) {
    notes.push(`Visible shortlist: ${top3}.`);
  }

  return notes.join(" ");
}

function buildWorkbook(config, sheets) {
  const outWb = XLSX.utils.book_new();
  for (const site of config.sites || []) {
    const reportSheetName = site.visibility_report_sheet;
    if (!sheets[reportSheetName]) {
      continue;
    }
    const trimmedRows = trimOutputColumns(sheets[reportSheetName]);
    const sheet = XLSX.utils.json_to_sheet(trimmedRows, { header: OUTPUT_HEADERS });
    XLSX.utils.book_append_sheet(outWb, sheet, reportSheetName.slice(0, 31));
  }
  return outWb;
}

function writeWorkbook(outputPath, config, sheets) {
  const outWb = buildWorkbook(config, sheets);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  XLSX.writeFile(outWb, outputPath);
}

function buildRunKey({ inputPath, providers, selectedSheets, maxQueriesPerSheet }) {
  return JSON.stringify({
    inputPath: path.resolve(inputPath),
    providers: [...providers].sort(),
    selectedSheets: [...selectedSheets].sort(),
    maxQueriesPerSheet: Number(maxQueriesPerSheet || 0),
  });
}

function loadCheckpoint(checkpointPath, runKey) {
  if (!fs.existsSync(checkpointPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    if (parsed.runKey !== runKey) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function persistCheckpoint({
  checkpointPath,
  outputPath,
  config,
  runKey,
  totalItems,
  completedItems,
  sheets,
  doneKeysBySheet,
  state,
}) {
  writeWorkbook(outputPath, config, sheets);
  fs.writeFileSync(
    checkpointPath,
    JSON.stringify(
      {
        runKey,
        totalItems,
        completedItems,
        sheets,
        doneKeysBySheet,
        state,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

function truncateText(value, maxLength = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv);
  installFetchTimeout(args.requestTimeoutMs, args.fetchRetries, args.fetchRetryBaseMs);
  const config = loadConfig(args.config);
  const workbook = XLSX.readFile(args.input);
  const selectedSheets = parseList(args.sheets).map((item) => item.toLowerCase());
  const defaultProviders = parseList(args.providers);
  if (!defaultProviders.length) {
    throw new Error("At least one provider must be supplied via --providers or VISIBILITY_PROVIDERS.");
  }

  const sheetRowsByName = normalizeQueryRows(
    workbook,
    config.sites || [],
    defaultProviders,
    selectedSheets,
    args.maxQueriesPerSheet,
    !args.providersExplicit
  );
  const outputPath = args.output || defaultOutputPath();
  const checkpointPath = checkpointPathFor(outputPath);
  const checkedOn = isoDate();
  const totalItems = countExpectedItems(sheetRowsByName);
  const runKey = buildRunKey({
    inputPath: args.input,
    providers: defaultProviders,
    selectedSheets,
    maxQueriesPerSheet: args.maxQueriesPerSheet,
  });
  const checkpoint = args.fresh ? null : loadCheckpoint(checkpointPath, runKey);
  let completedItems = Object.values(checkpoint?.doneKeysBySheet || {}).reduce(
    (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
    0
  );

  console.log(
    `Starting visibility run: ${completedItems}/${totalItems} items complete. Providers: ${defaultProviders.join(", ")}`
  );

  const result = await runMultisheetReport({
    sheetRowsByName,
    queryColumn: "Query",
    providers: defaultProviders,
    checkedOn,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    claudeApiKey: process.env.CLAUDE_API_KEY,
    openaiModel: args.openaiModel,
    openrouterModel: args.openrouterModel,
    openrouterOpenaiModel: args.openrouterOpenaiModel,
    openrouterClaudeModel: args.openrouterClaudeModel,
    openrouterGeminiModel: args.openrouterGeminiModel,
    openrouterSonarModel: args.openrouterSonarModel,
    openrouterPerplexityModel: args.openrouterPerplexityModel,
    claudeApiModel: args.claudeApiModel,
    claudeApiMaxTokens: args.claudeApiMaxTokens,
    claudeApiMinIntervalMs: args.claudeApiMinIntervalMs,
    openaiMinIntervalMs: args.openaiMinIntervalMs,
    analysisProvider: args.analysisProvider,
    analysisOpenaiModel: args.analysisOpenaiModel,
    ollamaBaseUrl: args.ollamaBaseUrl,
    ollamaModel: args.ollamaModel,
    initialSheets: checkpoint?.sheets || {},
    doneKeysBySheet: checkpoint?.doneKeysBySheet || {},
    state: checkpoint?.state || {},
    onItemComplete: async ({ sheetName, provider, reportRow, sheets, doneKeysBySheet, state }) => {
      completedItems += 1;
      const queryLabel = truncateText(reportRow?.Query);
      const status = String(reportRow?.status || "ok").trim().toUpperCase() || "OK";
      console.log(`[${completedItems}/${totalItems}] ${sheetName} :: ${provider} :: ${status} :: ${queryLabel}`);

      if (args.checkpointEvery > 0 && (completedItems % args.checkpointEvery === 0 || completedItems === totalItems)) {
        persistCheckpoint({
          checkpointPath,
          outputPath,
          config,
          runKey,
          totalItems,
          completedItems,
          sheets,
          doneKeysBySheet,
          state,
        });
        console.log(`Checkpoint saved at ${completedItems}/${totalItems} -> ${outputPath}`);
      }
    },
  });

  writeWorkbook(outputPath, config, result.sheets);
  if (fs.existsSync(checkpointPath)) {
    fs.unlinkSync(checkpointPath);
  }
  console.log(`Visibility report written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
