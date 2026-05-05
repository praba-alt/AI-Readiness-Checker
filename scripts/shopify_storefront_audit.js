#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), "configs", "audit_config.json");
const DEFAULT_ENV_PATH = path.join(process.cwd(), ".env");
const DEFAULT_AUDIT_SETTINGS = {
  ai_bots: [
    "GPTBot",
    "ChatGPT-User",
    "OAI-SearchBot",
    "Google-Extended",
    "CCBot",
    "ClaudeBot",
    "anthropic-ai",
    "PerplexityBot",
    "Bytespider",
  ],
  mcp_paths: [
    "/.well-known/mcp.json",
    "/.well-known/mcp/manifest.json",
    "/mcp",
    "/api/mcp",
  ],
  mcp_rpc_paths: [
    "/.well-known/mcp/rpc",
    "/mcp/rpc",
    "/rpc",
    "/api/mcp/rpc",
  ],
  sample_sizes: {
    products: 8,
    collections: 5,
    content: 5,
  },
  support_keywords: [
    "about",
    "contact",
    "help",
    "support",
    "faq",
    "faqs",
    "shipping",
    "returns",
    "refund",
    "privacy",
    "terms",
    "delivery",
    "size guide",
    "size chart",
  ],
  policy_keywords: [
    "privacy policy",
    "refund policy",
    "shipping policy",
    "terms of service",
    "returns",
    "delivery",
  ],
  related_module_headings: [
    "related products",
    "you may also like",
    "complete the look",
    "pair it with",
    "frequently bought together",
    "customers also bought",
    "complementary products",
    "recommended for you",
  ],
  clothing_attribute_keywords: {
    fabric: ["fabric", "material", "cotton", "polyester", "nylon", "fleece", "wool", "shell", "blend"],
    fit: ["fit", "oversized", "slim", "relaxed", "regular fit", "boxy", "tailored"],
    weather: ["waterproof", "water resistant", "breathable", "windproof", "rain", "cold weather", "winter", "lightweight"],
    style: ["streetwear", "outdoor", "casual", "performance", "technical", "minimal", "graphic", "layering"],
    care: ["machine wash", "wash care", "care instructions", "do not tumble dry", "cold wash"],
    occasion: ["hiking", "running", "gym", "everyday", "travel", "commute", "lifestyle"],
  },
};

let AUDIT_CONFIG = { sites: [], audit: { ...DEFAULT_AUDIT_SETTINGS } };
let ENV_MAP = {};
let AI_BOTS = [...DEFAULT_AUDIT_SETTINGS.ai_bots];
let MCP_PATHS = [...DEFAULT_AUDIT_SETTINGS.mcp_paths];
let MCP_RPC_PATHS = [...DEFAULT_AUDIT_SETTINGS.mcp_rpc_paths];
let SAMPLE_SIZES = { ...DEFAULT_AUDIT_SETTINGS.sample_sizes };
let SUPPORT_KEYWORDS = [...DEFAULT_AUDIT_SETTINGS.support_keywords];
let POLICY_KEYWORDS = [...DEFAULT_AUDIT_SETTINGS.policy_keywords];
let RELATED_MODULE_HEADINGS = [...DEFAULT_AUDIT_SETTINGS.related_module_headings];

function loadConfig(configPath) {
  const resolved = configPath || DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(resolved)) {
    AUDIT_CONFIG = { sites: [], audit: { ...DEFAULT_AUDIT_SETTINGS } };
  } else {
    const loaded = JSON.parse(fs.readFileSync(resolved, "utf8"));
    AUDIT_CONFIG = {
      ...loaded,
      audit: {
        ...DEFAULT_AUDIT_SETTINGS,
        ...(loaded.audit || {}),
      },
    };
  }
  AI_BOTS = [...AUDIT_CONFIG.audit.ai_bots];
  MCP_PATHS = [...AUDIT_CONFIG.audit.mcp_paths];
  MCP_RPC_PATHS = [...AUDIT_CONFIG.audit.mcp_rpc_paths];
  SAMPLE_SIZES = {
    ...DEFAULT_AUDIT_SETTINGS.sample_sizes,
    ...(AUDIT_CONFIG.audit.sample_sizes || {}),
  };
  SUPPORT_KEYWORDS = [...(AUDIT_CONFIG.audit.support_keywords || DEFAULT_AUDIT_SETTINGS.support_keywords)];
  POLICY_KEYWORDS = [...(AUDIT_CONFIG.audit.policy_keywords || DEFAULT_AUDIT_SETTINGS.policy_keywords)];
  RELATED_MODULE_HEADINGS = [...(AUDIT_CONFIG.audit.related_module_headings || DEFAULT_AUDIT_SETTINGS.related_module_headings)];
}

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function mergedEnv() {
  return {
    ...parseEnvFile(DEFAULT_ENV_PATH),
    ...process.env,
  };
}

function slugifyLabel(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeAdminStoreHandle(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const withProtocol = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    const cleanPath = url.pathname.replace(/\/+$/, "");
    if (url.hostname === "admin.shopify.com") {
      const match = cleanPath.match(/\/store\/([^/]+)/);
      return match ? match[1] : "";
    }
    if (url.hostname.endsWith(".myshopify.com")) {
      return url.hostname.replace(/\.myshopify\.com$/i, "");
    }
  } catch {
    return "";
  }
  return "";
}

function findSiteConfig(domain) {
  const normalizedInput = String(domain || "").trim().toLowerCase();
  return (AUDIT_CONFIG.sites || []).find((site) => {
    const siteDomain = String(site.domain || "").trim().toLowerCase();
    const siteLabel = String(site.label || "").trim().toLowerCase();
    return normalizedInput === siteDomain || normalizedInput === siteLabel;
  }) || null;
}

function resolveStorefrontMcpBaseUrl(inputDomain) {
  const site = findSiteConfig(inputDomain);
  const labelSlug = slugifyLabel(site?.label || inputDomain);
  const envKey = `SHOPIFY_STOREFRONT_MCP_DOMAIN_${labelSlug}`;
  const explicitDomain =
    site?.storefront_mcp_domain ||
    site?.shopify_store_domain ||
    ENV_MAP[envKey] ||
    "";
  if (explicitDomain) {
    const raw = String(explicitDomain).trim();
    const withProtocol = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
    try {
      const url = new URL(withProtocol);
      return `${url.protocol}//${url.hostname}`;
    } catch {
      return "";
    }
  }

  const adminEnvKey = site?.admin?.admin_domain_env || `SHOPIFY_ADMIN_DOMAIN_${labelSlug}`;
  const adminStoreHandle = normalizeAdminStoreHandle(site?.admin?.admin_domain || ENV_MAP[adminEnvKey] || "");
  if (adminStoreHandle) {
    return `https://${adminStoreHandle}.myshopify.com`;
  }

  const normalizedDomain = normalizeDomain(inputDomain);
  try {
    const url = new URL(normalizedDomain);
    if (url.hostname.endsWith(".myshopify.com")) {
      return `${url.protocol}//${url.hostname}`;
    }
  } catch {
    return "";
  }

  return "";
}

function normalizeDomain(input) {
  const raw = String(input).trim();
  if (!raw) {
    throw new Error("Empty domain");
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw.replace(/\/+$/, "");
  }
  return `https://${raw.replace(/\/+$/, "")}`;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(text) {
  return stripTags(String(text || "")).replace(/\s+/g, " ").trim();
}

function extractFirst(html, regex) {
  const match = regex.exec(html);
  return match ? cleanText(match[1]) : "";
}

function extractAll(html, regex) {
  const out = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    out.push(match[1]);
  }
  return out;
}

function decodeXml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function getMeta(html, key, attr = "name") {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `<meta[^>]*${attr}=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`,
    "i",
  );
  return extractFirst(html, regex);
}

function getLinkHref(html, relValue) {
  const escaped = relValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `<link[^>]*rel=["'][^"']*${escaped}[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>`,
    "i",
  );
  return extractFirst(html, regex);
}

function extractAttributes(tag) {
  const attrs = {};
  const regex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["']([^"']*)["']/g;
  let match;
  while ((match = regex.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[2];
  }
  return attrs;
}

function dedupe(items) {
  return [...new Set(items.filter(Boolean))];
}

function countMatches(text, regex) {
  const matches = String(text || "").match(regex);
  return matches ? matches.length : 0;
}

function countKeywordMentions(text, keywords) {
  const lower = String(text || "").toLowerCase();
  return (keywords || []).filter((keyword) => lower.includes(String(keyword).toLowerCase())).length;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function countKeywordHits(text, keywords) {
  const lower = String(text || "").toLowerCase();
  const hits = [];
  for (const keyword of keywords || []) {
    if (lower.includes(String(keyword).toLowerCase())) {
      hits.push(keyword);
    }
  }
  return dedupe(hits);
}

function scanAttributeDepth(text) {
  const families = AUDIT_CONFIG.audit.clothing_attribute_keywords || {};
  const coverage = {};
  for (const [family, keywords] of Object.entries(families)) {
    coverage[family] = countKeywordHits(text, keywords);
  }
  return coverage;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExplicitKeywordSignal(html, keywords) {
  for (const keyword of keywords || []) {
    const escaped = escapeRegex(keyword);
    const patterns = [
      new RegExp(`<(h[1-6]|dt|th|summary|button|label)[^>]*>\\s*${escaped}\\s*<`, "i"),
      new RegExp(`<(div|span|p|li|strong|b)[^>]*>\\s*${escaped}\\s*:`, "i"),
      new RegExp(`\\b${escaped}\\b\\s*:`, "i"),
      new RegExp(`(data-label|aria-label|title)=["'][^"']*${escaped}[^"']*["']`, "i"),
    ];
    if (patterns.some((pattern) => pattern.test(html))) {
      return true;
    }
  }
  return false;
}

function normalizeMediaText(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+-\s+(trailberg|lorenzo|dream is free)$/i, "")
    .toLowerCase();
}

function isProductMediaImage(attrs, title) {
  const src = String(attrs.src || attrs["data-src"] || attrs["data-original"] || "").toLowerCase();
  const classes = String(attrs.class || "").toLowerCase();
  const id = String(attrs.id || "").toLowerCase();
  const alt = String(attrs.alt || "").trim();
  if (!src.includes("/cdn/shop/files/")) {
    return false;
  }
  if (classes.includes("header__logo-image") || classes.includes("logo")) {
    return false;
  }
  const normalizedAlt = normalizeMediaText(alt);
  const normalizedTitle = normalizeMediaText(title);
  if (
    normalizedAlt &&
    normalizedTitle &&
    (normalizedAlt === normalizedTitle ||
      normalizedTitle.startsWith(normalizedAlt) ||
      normalizedAlt.startsWith(normalizedTitle))
  ) {
    return true;
  }
  return /(rounded|product|media|gallery|slider|zoom|thumbnail|swiper|img-cover)/i.test(classes) ||
    /(image-template|thumbnail-template|product-image|product-media)/i.test(id);
}

function scanExplicitAttributeDepth(html, productSchemaFields) {
  const families = AUDIT_CONFIG.audit.clothing_attribute_keywords || {};
  const coverage = {};
  const schemaText = (productSchemaFields || [])
    .flatMap((item) => [
      ...(item.additional_property_names || []),
      ...Object.values(item.clothing_attribute_coverage || {}).flat(),
    ])
    .join(" ");
  for (const [family, keywords] of Object.entries(families)) {
    const explicitHits = [];
    if (hasExplicitKeywordSignal(html, keywords)) {
      explicitHits.push("page-label");
    }
    const schemaHits = countKeywordHits(schemaText, keywords);
    coverage[family] = dedupe([...explicitHits, ...schemaHits]);
  }
  return coverage;
}

function summarizeAttributeDepth(coverage) {
  const categories = Object.entries(coverage || {})
    .filter(([, hits]) => Array.isArray(hits) && hits.length > 0)
    .map(([name]) => name);
  return {
    categories_present: categories,
    category_count: categories.length,
  };
}

function toAbsolute(baseUrl, maybeRelative) {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return "";
  }
}

async function fetchText(url, options = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "CodexShopifyAudit/1.0 (+https://openai.com)",
        accept:
          options.accept ||
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(options.timeoutMs || 20000),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: Object.fromEntries(response.headers.entries()),
      body: text,
      duration_ms: Date.now() - started,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      url,
      headers: {},
      body: "",
      duration_ms: Date.now() - started,
      error: error.message,
    };
  }
}

function parseJsonLd(html) {
  const blocks = extractAll(
    html,
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  const parsed = [];
  for (const block of blocks) {
    try {
      const value = JSON.parse(block.trim());
      parsed.push(value);
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  return parsed;
}

function collectJsonLdTypes(value, acc = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLdTypes(item, acc);
    }
    return acc;
  }
  if (!value || typeof value !== "object") {
    return acc;
  }
  if (value["@graph"]) {
    collectJsonLdTypes(value["@graph"], acc);
  }
  const typeValue = value["@type"];
  if (Array.isArray(typeValue)) {
    acc.push(...typeValue.map(String));
  } else if (typeValue) {
    acc.push(String(typeValue));
  }
  return acc;
}

function findSchemaObjects(value, wantedType, acc = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      findSchemaObjects(item, wantedType, acc);
    }
    return acc;
  }
  if (!value || typeof value !== "object") {
    return acc;
  }
  const typeValue = value["@type"];
  const matches = Array.isArray(typeValue)
    ? typeValue.includes(wantedType)
    : typeValue === wantedType;
  if (matches) {
    acc.push(value);
  }
  if (value["@graph"]) {
    findSchemaObjects(value["@graph"], wantedType, acc);
  }
  return acc;
}

function flattenSchemaValues(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenSchemaValues(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => flattenSchemaValues(item));
  }
  return value == null ? [] : [String(value)];
}

function extractProductSchemaDepth(productObjects) {
  return productObjects.map((obj) => {
    const additionalProperty = Array.isArray(obj.additionalProperty)
      ? obj.additionalProperty
      : obj.additionalProperty
        ? [obj.additionalProperty]
        : [];
    const additionalPropertyNames = dedupe(
      additionalProperty
        .map((item) => item && (item.name || item.propertyID || ""))
        .filter(Boolean),
    );
    const flattened = flattenSchemaValues(obj).join(" ").toLowerCase();
    const coverage = scanAttributeDepth(flattened);
    const signals = [
      Boolean(obj.offers),
      Boolean(obj.description),
      Boolean(obj.brand),
      Boolean(obj.sku),
      Boolean(obj.gtin || obj.gtin13 || obj.gtin12 || obj.gtin14),
      Boolean(obj.aggregateRating),
      Boolean(obj.material || obj.materials),
      Boolean(obj.color),
      Boolean(obj.size),
      additionalPropertyNames.length > 0,
      Boolean(obj.category),
      Boolean(obj.audience),
    ];
    return {
      name: obj.name || "",
      has_offers: Boolean(obj.offers),
      has_description: Boolean(obj.description),
      has_brand: Boolean(obj.brand),
      has_sku: Boolean(obj.sku),
      has_gtin: Boolean(obj.gtin || obj.gtin13 || obj.gtin12 || obj.gtin14),
      has_aggregate_rating: Boolean(obj.aggregateRating),
      has_material: Boolean(obj.material || obj.materials),
      has_color: Boolean(obj.color),
      has_size: Boolean(obj.size),
      has_category: Boolean(obj.category),
      has_audience: Boolean(obj.audience),
      additional_property_count: additionalPropertyNames.length,
      additional_property_names: additionalPropertyNames.slice(0, 20),
      clothing_attribute_coverage: coverage,
      depth_score: Number((signals.filter(Boolean).length / signals.length).toFixed(2)),
    };
  });
}

function parseHtmlPage(url, html) {
  const title = extractFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const canonical = toAbsolute(url, getLinkHref(html, "canonical")) || getLinkHref(html, "canonical");
  const langMatch = /<html[^>]*lang=["']([^"']+)["']/i.exec(html);
  const h1s = extractAll(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi).map(cleanText);
  const jsonLd = parseJsonLd(html);
  const jsonLdTypes = dedupe(
    jsonLd.flatMap((block) => collectJsonLdTypes(block, [])),
  );
  const productObjects = jsonLd.flatMap((block) => findSchemaObjects(block, "Product", []));
  const breadcrumbObjects = jsonLd.flatMap((block) =>
    findSchemaObjects(block, "BreadcrumbList", []),
  );
  const faqObjects = jsonLd.flatMap((block) => findSchemaObjects(block, "FAQPage", []));
  const orgObjects = jsonLd.flatMap((block) => findSchemaObjects(block, "Organization", []));
  const websiteObjects = jsonLd.flatMap((block) => findSchemaObjects(block, "WebSite", []));
  const webpageObjects = jsonLd.flatMap((block) => findSchemaObjects(block, "WebPage", []));
  const collectionPageObjects = jsonLd.flatMap((block) =>
    findSchemaObjects(block, "CollectionPage", []),
  );
  const itemListObjects = jsonLd.flatMap((block) => findSchemaObjects(block, "ItemList", []));
  const searchActionObjects = jsonLd.flatMap((block) =>
    findSchemaObjects(block, "SearchAction", []),
  );
  const metaRobots = getMeta(html, "robots");
  const description = getMeta(html, "description");
  const ogTitle = getMeta(html, "og:title", "property");
  const ogDescription = getMeta(html, "og:description", "property");
  const twitterImageAlt = getMeta(html, "twitter:image:alt");
  const hrefs = extractAll(html, /<a[^>]*href=["']([^"']+)["'][^>]*>/gi)
    .map((href) => toAbsolute(url, href))
    .filter(Boolean);
  const anchorTexts = extractAll(html, /<a[^>]*>([\s\S]*?)<\/a>/gi).map(cleanText);
  const imageTags = extractAll(html, /(<img\b[^>]*>)/gi);
  const images = imageTags.map((tag) => extractAttributes(tag));
  const wordCount = stripTags(html).split(/\s+/).filter(Boolean).length;
  const host = new URL(url).host;
  const internalLinks = hrefs.filter((href) => {
    try {
      return new URL(href).host === host;
    } catch {
      return false;
    }
  });
  const productSchemaFields = extractProductSchemaDepth(productObjects);
  const attributeCoverage = scanExplicitAttributeDepth(html, productSchemaFields);
  const attributeSummary = summarizeAttributeDepth(attributeCoverage);
  const relatedHeadingRegex = new RegExp(
    `<[^>]+>\\s*(${RELATED_MODULE_HEADINGS.map((value) => escapeRegex(value)).join("|")})\\s*<`,
    "i",
  );
  const relatedHeading = relatedHeadingRegex.test(html);
  const relatedProductLinks = internalLinks.filter((href) => /\/products\//i.test(href)).length;
  const explicitFaq =
    faqObjects.length > 0 ||
    /<[^>]+>\s*(faq|frequently asked questions)\s*</i.test(html);
  const explicitSizeGuide =
    /<[^>]+>\s*(size guide|size chart)\s*</i.test(html) ||
    /\b(size guide|size chart)\b/i.test(anchorTexts.join(" | "));
  const explicitReviews =
    productObjects.some((obj) => Boolean(obj.aggregateRating || obj.review)) ||
    /aggregateRating|ratingValue|reviewCount/i.test(html) ||
    /<[^>]+>\s*reviews?\s*</i.test(html);
  const searchFormCount = countMatches(html, /<form[^>]+(?:role=["']search["']|action=["'][^"']*\/search)/gi);
  const predictiveSearchMarkers = countMatches(html, /predictive_search_url|search\/suggest|predictive-search/i);
  const filterControlCount = countMatches(html, /(filter|facet)[-_ ]?(drawer|panel|button|group|form|options|menu)/gi);
  const sortControlCount = countMatches(html, /sort by|sort_by|sort-options|sort_options|sort-selected/i);
  const faqHeadingCount = countMatches(html, /<[^>]+>\s*(faq|frequently asked questions)\s*</gi);
  const sizeGuideLinkCount = countMatches(anchorTexts.join(" | "), /\bsize guide\b|\bsize chart\b/gi);
  const policyLinkCount = countKeywordMentions(anchorTexts.join(" | "), POLICY_KEYWORDS);
  const supportLinkCount = countKeywordMentions(anchorTexts.join(" | "), SUPPORT_KEYWORDS);
  const reviewSignalCount =
    countMatches(html, /aggregateRating|ratingValue|reviewCount|product-rating|customer reviews?/gi) +
    (explicitReviews ? 1 : 0);
  const currencySignals = dedupe([
    ...extractAll(html, /"currency"\s*:\s*"([A-Z]{3})"/g),
    ...extractAll(html, /"shopCurrency"\s*:\s*"([A-Z]{3})"/g),
    ...extractAll(html, /"currencyCode"\s*:\s*"([A-Z]{3})"/g),
    ...extractAll(html, /\b(USD|GBP|EUR|AUD|CAD|CHF|AED|INR)\b/g),
  ]).slice(0, 12);
  const countrySignals = dedupe([
    ...extractAll(html, /"country"\s*:\s*"([A-Z]{2})"/g),
    ...extractAll(html, /"countryCode"\s*:\s*"([A-Z]{2})"/g),
    ...extractAll(html, /locale=[a-z]{2}(?:-[A-Z]{2})?/gi),
  ]).slice(0, 12);
  const hasRegionSelector =
    /country\/region|country selector|region selector|currency selector|market selector/i.test(html);
  const productMediaImages = images.filter((attrs) => isProductMediaImage(attrs, title));
  const productGalleryImagesWithoutAlt = productMediaImages.filter((attrs) => !String(attrs.alt || "").trim()).length;
  const productGalleryAltMatchTitleCount = productMediaImages.filter(
    (attrs) => title && String(attrs.alt || "").trim() === title,
  ).length;
  const contentText = stripTags(html);
  const collectionIntroWordCount = /\/collections\//i.test(url)
    ? contentText.split(/\s+/).filter(Boolean).length
    : 0;
  const collectionProductLinkCount = /\/collections\//i.test(url)
    ? internalLinks.filter((href) => /\/products\//i.test(href)).length
    : 0;
  return {
    url,
    title,
    title_length: title.length,
    meta_description: description,
    meta_description_length: description.length,
    meta_robots: metaRobots,
    canonical,
    canonical_matches: canonical ? canonical.replace(/\/+$/, "") === url.replace(/\/+$/, "") : false,
    lang: langMatch ? langMatch[1] : "",
    h1s,
    h1_count: h1s.length,
    og_title: ogTitle,
    og_description: ogDescription,
    twitter_image_alt: twitterImageAlt,
    json_ld_types: jsonLdTypes,
    product_schema_count: productObjects.length,
    breadcrumb_schema_count: breadcrumbObjects.length,
    faq_schema_count: faqObjects.length,
    organization_schema_count: orgObjects.length,
    website_schema_count: websiteObjects.length,
    webpage_schema_count: webpageObjects.length,
    collectionpage_schema_count: collectionPageObjects.length,
    itemlist_schema_count: itemListObjects.length,
    search_action_schema_count: searchActionObjects.length,
    product_schema_fields: productSchemaFields,
    schema_depth_summary: {
      product_avg_depth:
        productSchemaFields.length > 0
          ? Number(
              (
                productSchemaFields.reduce((sum, item) => sum + item.depth_score, 0) /
                productSchemaFields.length
              ).toFixed(2),
            )
          : 0,
      has_collection_semantics:
        collectionPageObjects.length > 0 || itemListObjects.length > 0,
      has_homepage_semantics:
        websiteObjects.length > 0 || orgObjects.length > 0 || searchActionObjects.length > 0,
    },
    word_count: wordCount,
    image_count: images.length,
    images_without_alt: images.filter((attrs) => !("alt" in attrs) || !attrs.alt.trim()).length,
    product_gallery_image_count: productMediaImages.length,
    product_gallery_images_without_alt: productGalleryImagesWithoutAlt,
    product_gallery_alt_match_title_count: productGalleryAltMatchTitleCount,
    internal_link_count: internalLinks.length,
    sample_internal_links: dedupe(internalLinks).slice(0, 20),
    has_search_link: internalLinks.some((href) => /\/search/i.test(href)),
    mentions_filter: /filter|facets|refine/i.test(html),
    mentions_sort: /sort by|sort_by|sort-options/i.test(html),
    mentions_policy: /privacy policy|refund policy|shipping policy|terms of service/i.test(html),
    mentions_faq: explicitFaq,
    mentions_reviews: explicitReviews,
    mentions_size_guide: explicitSizeGuide,
    has_related_products_module: relatedHeading && relatedProductLinks >= 2,
    has_complementary_or_related_module: relatedHeading && relatedProductLinks >= 2,
    related_product_link_count: relatedProductLinks,
    related_module_heading: relatedHeading,
    related_module_product_link_count: relatedProductLinks,
    faq_heading_count: faqHeadingCount,
    size_guide_link_count: sizeGuideLinkCount,
    support_link_count: supportLinkCount,
    policy_link_count: policyLinkCount,
    review_signal_count: reviewSignalCount,
    search_form_count: searchFormCount,
    predictive_search_markers: predictiveSearchMarkers,
    filter_control_count: filterControlCount,
    sort_control_count: sortControlCount,
    has_hreflang: /<link[^>]+hreflang=/i.test(html),
    has_search_action_schema: jsonLdTypes.includes("SearchAction"),
    currency_signals: currencySignals,
    country_signals: countrySignals,
    has_region_selector: hasRegionSelector,
    collection_intro_word_count: collectionIntroWordCount,
    collection_product_link_count: collectionProductLinkCount,
    meta_description_matches_body_prefix:
      Boolean(description) &&
      Boolean(contentText) &&
      contentText.toLowerCase().startsWith(description.toLowerCase().slice(0, Math.min(description.length, 120))),
    clothing_attribute_coverage: attributeCoverage,
    clothing_attribute_summary: attributeSummary,
  };
}

function parseRobots(body) {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const groups = [];
  let current = null;
  for (const line of lines) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) {
      continue;
    }
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      current = { agents: [value], disallow: [], allow: [], raw: [] };
      groups.push(current);
    } else if (current) {
      current.raw.push(line);
      if (key === "disallow") {
        current.disallow.push(value);
      } else if (key === "allow") {
        current.allow.push(value);
      }
    }
  }
  const botRules = {};
  for (const bot of AI_BOTS) {
    const matched = groups.filter((group) =>
      group.agents.some((agent) => agent.toLowerCase() === bot.toLowerCase()),
    );
    botRules[bot] = {
      mentioned: matched.length > 0,
      blocked: matched.some((group) =>
        group.disallow.some((value) => value && value !== ""),
      ),
      allow: matched.flatMap((group) => group.allow),
      disallow: matched.flatMap((group) => group.disallow),
    };
  }
  return {
    lines: lines.slice(0, 80),
    sitemap_directives: lines.filter((line) => /^sitemap:/i.test(line)),
    bot_rules: botRules,
  };
}

function parseXmlLocs(xml) {
  return dedupe(
    extractAll(xml, /<loc>([\s\S]*?)<\/loc>/gi).map((item) =>
      decodeXml(item).trim(),
    ),
  );
}

function classifyUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    if (/\/products\/[^/]+/i.test(pathname)) return "product";
    if (/\/collections\/[^/]+/i.test(pathname)) return "collection";
    if (/\/blogs\/[^/]+/i.test(pathname)) return "blog";
    if (/\/pages\/[^/]+/i.test(pathname)) return "page";
    return "other";
  } catch {
    return "other";
  }
}

async function crawlSitemaps(startUrl, limit = 20) {
  const queue = [startUrl];
  const seen = new Set();
  const xmlDocs = [];
  const urls = [];
  while (queue.length && seen.size < limit) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const fetched = await fetchText(current, { accept: "application/xml,text/xml,*/*" });
    xmlDocs.push({
      url: current,
      status: fetched.status,
      final_url: fetched.url,
      ok: fetched.ok,
      error: fetched.error,
    });
    if (!fetched.ok || !fetched.body) {
      continue;
    }
    const locs = parseXmlLocs(fetched.body);
    for (const loc of locs) {
      if (/sitemap/i.test(loc) && !seen.has(loc)) {
        queue.push(loc);
      } else {
        urls.push(loc);
      }
    }
  }
  return {
    documents: xmlDocs,
    urls: dedupe(urls),
  };
}

async function inspectOptionalPath(baseUrl, route, accept, keepBody = false) {
  const result = await fetchText(`${baseUrl}${route}`, { accept });
  return {
    path: route,
    status: result.status,
    ok: result.ok,
    final_url: result.url,
    ...(keepBody ? { body: result.body } : {}),
    snippet: cleanText(result.body).slice(0, 240),
    body_length: result.body.length,
    headers: result.headers,
  };
}

function analyzeMcpManifest(check) {
  const parsed = safeJsonParse(check.body || "");
  if (!parsed || typeof parsed !== "object") {
    return {
      valid_json: false,
      keys: [],
      tool_count: 0,
      rpc_endpoints: [],
    };
  }
  const rpcCandidates = dedupe(
    flattenSchemaValues(parsed)
      .filter((value) => /^https?:\/\/|^\//i.test(value))
      .filter((value) => /rpc|mcp|transport|endpoint/i.test(value)),
  );
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools
    : Array.isArray(parsed.capabilities?.tools)
      ? parsed.capabilities.tools
      : [];
  return {
    valid_json: true,
    keys: Object.keys(parsed),
    tool_count: tools.length,
    rpc_endpoints: rpcCandidates.slice(0, 10),
  };
}

async function probeMcpRpc(baseUrl, endpoints) {
  const initializePayload = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "CodexShopifyAudit", version: "1.0" },
    },
  };
  const toolsListPayload = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  };
  const results = [];
  for (const endpoint of dedupe(endpoints)) {
    const url = toAbsolute(baseUrl, endpoint);
    if (!url) continue;
    try {
      const initializeResponse = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream, */*",
          "user-agent": "CodexShopifyAudit/1.0 (+https://openai.com)",
        },
        body: JSON.stringify(initializePayload),
        signal: AbortSignal.timeout(12000),
      });
      const initializeText = await initializeResponse.text();
      const initializeParsed = safeJsonParse(initializeText);
      let toolCount = 0;
      let toolNames = [];
      let toolsListStatus = null;
      let toolsListOk = false;
      let toolsListSnippet = "";
      let toolsListContentType = "";
      let protocolVersion = initializeParsed?.result?.protocolVersion || "";

      try {
        const toolsListResponse = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream, */*",
            "user-agent": "CodexShopifyAudit/1.0 (+https://openai.com)",
          },
          body: JSON.stringify(toolsListPayload),
          signal: AbortSignal.timeout(12000),
        });
        const toolsListText = await toolsListResponse.text();
        const toolsListParsed = safeJsonParse(toolsListText);
        const tools = Array.isArray(toolsListParsed?.result?.tools) ? toolsListParsed.result.tools : [];
        toolCount = tools.length;
        toolNames = dedupe(tools.map((tool) => tool?.name).filter(Boolean)).slice(0, 20);
        toolsListStatus = toolsListResponse.status;
        toolsListOk = toolsListResponse.ok;
        toolsListSnippet = cleanText(toolsListText).slice(0, 240);
        toolsListContentType = toolsListResponse.headers.get("content-type") || "";
      } catch (toolsError) {
        toolsListSnippet = toolsError.message;
      }

      results.push({
        url,
        status: initializeResponse.status,
        ok: initializeResponse.ok,
        content_type: initializeResponse.headers.get("content-type") || "",
        looks_like_jsonrpc:
          Boolean(
            initializeParsed &&
              typeof initializeParsed === "object" &&
              ("jsonrpc" in initializeParsed || "result" in initializeParsed || "error" in initializeParsed),
          ) || /jsonrpc/i.test(initializeText),
        snippet: cleanText(initializeText).slice(0, 240),
        protocol_version: protocolVersion,
        tool_count: toolCount,
        tool_names: toolNames,
        tools_list_status: toolsListStatus,
        tools_list_ok: toolsListOk,
        tools_list_content_type: toolsListContentType,
        tools_list_snippet: toolsListSnippet,
      });
    } catch (error) {
      results.push({
        url,
        status: null,
        ok: false,
        content_type: "",
        looks_like_jsonrpc: false,
        snippet: error.message,
        protocol_version: "",
        tool_count: 0,
        tool_names: [],
        tools_list_status: null,
        tools_list_ok: false,
        tools_list_content_type: "",
        tools_list_snippet: "",
      });
    }
  }
  return results;
}

function analyzeUrlPatterns(urls) {
  const samples = urls.slice(0, 200);
  const trailingSlash = samples.filter((url) => /\/$/.test(new URL(url).pathname)).length;
  const withQuery = samples.filter((url) => new URL(url).search).length;
  const depths = samples.map((url) =>
    new URL(url).pathname.split("/").filter(Boolean).length,
  );
  return {
    sampled_urls: samples.length,
    avg_depth: depths.length
      ? Number((depths.reduce((sum, value) => sum + value, 0) / depths.length).toFixed(2))
      : 0,
    trailing_slash_ratio: samples.length
      ? Number((trailingSlash / samples.length).toFixed(2))
      : 0,
    query_ratio: samples.length ? Number((withQuery / samples.length).toFixed(2)) : 0,
  };
}

function pickSampleUrls(urls, count) {
  const items = dedupe(urls);
  if (items.length <= count) {
    return items;
  }
  const picks = new Set();
  for (let idx = 0; idx < count; idx += 1) {
    const position = Math.floor((idx * (items.length - 1)) / Math.max(count - 1, 1));
    picks.add(items[position]);
  }
  return items.filter((item) => picks.has(item)).slice(0, count);
}

function discoverSupportUrls(baseUrl, html, sitemapPages = [], sitemapBlogs = []) {
  const candidates = dedupe(
    extractAll(html || "", /<a[^>]*href=["']([^"']+)["'][^>]*>/gi)
      .map((href) => toAbsolute(baseUrl, href))
      .filter(Boolean),
  );
  const supportUrls = candidates.filter((href) => {
    const lower = href.toLowerCase();
    return SUPPORT_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase().replace(/\s+/g, "-")))
      || SUPPORT_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase().replace(/\s+/g, "")))
      || SUPPORT_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()));
  });
  return dedupe([
    ...supportUrls,
    ...sitemapPages.filter((href) =>
      SUPPORT_KEYWORDS.some((keyword) => href.toLowerCase().includes(keyword.toLowerCase().replace(/\s+/g, "-"))),
    ),
    ...sitemapBlogs.filter((href) =>
      SUPPORT_KEYWORDS.some((keyword) => href.toLowerCase().includes(keyword.toLowerCase().replace(/\s+/g, "-"))),
    ),
  ]).slice(0, SAMPLE_SIZES.content + 4);
}

async function auditSamplePages(urls, count) {
  const samples = pickSampleUrls(urls, count);
  const results = [];
  for (const url of samples) {
    const fetched = await fetchText(url);
    const page = parseHtmlPage(fetched.url || url, fetched.body || "");
    results.push({
      ...page,
      requested_url: url,
      final_url: fetched.url,
      status: fetched.status,
      ok: fetched.ok,
      fetch_error: fetched.error,
    });
  }
  return results;
}

function summarisePages(pages) {
  const okPages = pages.filter((page) => page.ok);
  const avg = (items, selector) => {
    if (!items.length) return 0;
    const values = items.map(selector);
    return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
  };
  const allSchema = dedupe(okPages.flatMap((page) => page.json_ld_types));
  const attributeCategories = dedupe(
    okPages.flatMap((page) => page.clothing_attribute_summary.categories_present),
  );
  const avgProductSchemaDepth = okPages.length
    ? Number(
        (
          okPages.reduce(
            (sum, page) => sum + (page.schema_depth_summary.product_avg_depth || 0),
            0,
          ) / okPages.length
        ).toFixed(2),
      )
    : 0;
  return {
    sampled: pages.length,
    ok: okPages.length,
    avg_title_length: avg(okPages, (page) => page.title_length),
    avg_meta_description_length: avg(okPages, (page) => page.meta_description_length),
    avg_word_count: avg(okPages, (page) => page.word_count),
    avg_images_without_alt: avg(okPages, (page) => page.images_without_alt),
    avg_product_gallery_images_without_alt: avg(
      okPages.filter((page) => page.product_gallery_image_count > 0),
      (page) => page.product_gallery_images_without_alt,
    ),
    avg_product_gallery_image_count: avg(
      okPages.filter((page) => page.product_gallery_image_count > 0),
      (page) => page.product_gallery_image_count,
    ),
    avg_product_gallery_alt_match_ratio: avg(
      okPages.filter((page) => page.product_gallery_image_count > 0),
      (page) =>
        page.product_gallery_image_count > 0
          ? page.product_gallery_alt_match_title_count / page.product_gallery_image_count
          : 0,
    ),
    canonical_match_ratio: okPages.length
      ? Number(
          (
            okPages.filter((page) => page.canonical_matches).length / okPages.length
          ).toFixed(2),
        )
      : 0,
    schema_types: allSchema,
    all_have_product_schema:
      okPages.length > 0 && okPages.every((page) => page.product_schema_count > 0),
    any_have_faq_schema: okPages.some((page) => page.faq_schema_count > 0),
    all_have_breadcrumb_schema:
      okPages.length > 0 && okPages.every((page) => page.breadcrumb_schema_count > 0),
    all_have_h1: okPages.length > 0 && okPages.every((page) => page.h1_count >= 1),
    avg_product_schema_depth: avgProductSchemaDepth,
    clothing_attribute_categories: attributeCategories,
    clothing_attribute_category_count: attributeCategories.length,
    faq_heading_total: okPages.reduce((sum, page) => sum + (page.faq_heading_count || 0), 0),
    size_guide_link_total: okPages.reduce((sum, page) => sum + (page.size_guide_link_count || 0), 0),
    review_signal_total: okPages.reduce((sum, page) => sum + (page.review_signal_count || 0), 0),
    support_link_total: okPages.reduce((sum, page) => sum + (page.support_link_count || 0), 0),
    policy_link_total: okPages.reduce((sum, page) => sum + (page.policy_link_count || 0), 0),
    search_form_total: okPages.reduce((sum, page) => sum + (page.search_form_count || 0), 0),
    predictive_search_marker_total: okPages.reduce((sum, page) => sum + (page.predictive_search_markers || 0), 0),
    filter_control_total: okPages.reduce((sum, page) => sum + (page.filter_control_count || 0), 0),
    sort_control_total: okPages.reduce((sum, page) => sum + (page.sort_control_count || 0), 0),
    related_module_count: okPages.filter((page) => page.has_complementary_or_related_module).length,
    any_region_selector: okPages.some((page) => page.has_region_selector),
    currency_signals: dedupe(okPages.flatMap((page) => page.currency_signals || [])),
    country_signals: dedupe(okPages.flatMap((page) => page.country_signals || [])),
    meta_description_matches_body_prefix_count: okPages.filter((page) => page.meta_description_matches_body_prefix).length,
    avg_collection_intro_word_count: avg(okPages, (page) => page.collection_intro_word_count || 0),
    avg_collection_product_link_count: avg(okPages, (page) => page.collection_product_link_count || 0),
    all_have_collection_semantics:
      okPages.length > 0 &&
      okPages.every(
        (page) =>
          page.collectionpage_schema_count > 0 ||
          page.itemlist_schema_count > 0,
      ),
  };
}

async function auditDomain(inputDomain) {
  const baseUrl = normalizeDomain(inputDomain);
  const storefrontMcpBaseUrl = resolveStorefrontMcpBaseUrl(inputDomain);
  const homepageResult = await fetchText(baseUrl);
  const homepage = parseHtmlPage(homepageResult.url || baseUrl, homepageResult.body || "");
  const robotsFetch = await inspectOptionalPath(baseUrl, "/robots.txt", "text/plain,*/*", true);
  const sitemapFetch = await inspectOptionalPath(baseUrl, "/sitemap.xml", "application/xml,text/xml,*/*");
  const llmsRoot = await inspectOptionalPath(baseUrl, "/llms.txt", "text/plain,*/*");
  const llmsWellKnown = await inspectOptionalPath(baseUrl, "/.well-known/llms.txt", "text/plain,*/*");
  const productsJson = await inspectOptionalPath(
    baseUrl,
    "/products.json?limit=250",
    "application/json,text/plain,*/*",
    true,
  );
  const mcpChecks = [];
  for (const route of MCP_PATHS) {
    mcpChecks.push(await inspectOptionalPath(baseUrl, route, "*/*", true));
  }
  const mcpManifestSummaries = mcpChecks.map((check) => ({
    path: check.path,
    status: check.status,
    ok: check.ok,
    final_url: check.final_url,
    snippet: check.snippet,
    ...analyzeMcpManifest(check),
  }));
  const discoveredRpc = dedupe(
    mcpManifestSummaries.flatMap((item) => item.rpc_endpoints || []),
  );
  const storefrontMcpEndpoint = storefrontMcpBaseUrl ? `${storefrontMcpBaseUrl}/api/mcp` : "";
  const mcpRpcChecks = await probeMcpRpc(baseUrl, [...MCP_RPC_PATHS, ...discoveredRpc, storefrontMcpEndpoint]);
  const augmentedMcpManifestSummaries = [
    ...mcpManifestSummaries,
    ...mcpRpcChecks
      .filter((item) => item.ok && item.tool_count > 0)
      .map((item) => ({
        path: new URL(item.url).pathname,
        status: item.status,
        ok: item.ok,
        final_url: item.url,
        snippet: item.tools_list_snippet || item.snippet,
        valid_json: true,
        keys: ["jsonrpc", "result", "tools"],
        tool_count: item.tool_count,
        rpc_endpoints: [item.url],
      })),
  ];
  const sitemap = await crawlSitemaps(`${baseUrl}/sitemap.xml`);
  const classified = sitemap.urls.reduce(
    (acc, url) => {
      const key = classifyUrl(url);
      acc[key].push(url);
      return acc;
    },
    { product: [], collection: [], blog: [], page: [], other: [] },
  );
  const supportUrls = discoverSupportUrls(baseUrl, homepageResult.body || "", classified.page, classified.blog);
  const collectionPages = await auditSamplePages(classified.collection, SAMPLE_SIZES.collections);
  const productPages = await auditSamplePages(classified.product, SAMPLE_SIZES.products);
  const contentPages = await auditSamplePages(
    dedupe([
      ...supportUrls,
      ...classified.page,
      ...classified.blog,
    ]),
    SAMPLE_SIZES.content,
  );
  const currencyMatches = extractAll(homepageResult.body || "", /"currency"\s*:\s*"([A-Z]{3})"/g);
  const marketMentions = extractAll(homepageResult.body || "", /"country"\s*:\s*"([A-Z]{2})"/g);
  return {
    domain: new URL(baseUrl).host,
    base_url: baseUrl,
    audited_at: new Date().toISOString(),
    homepage: {
      ...homepage,
      status: homepageResult.status,
      ok: homepageResult.ok,
      final_url: homepageResult.url,
      fetch_error: homepageResult.error,
      response_headers: homepageResult.headers,
      body_length: homepageResult.body.length,
      scripts_count: (homepageResult.body.match(/<script\b/gi) || []).length,
      stylesheet_count: (homepageResult.body.match(/<link\b[^>]+stylesheet/gi) || []).length,
      has_shopify_markers:
        /cdn\.shopify\.com|Shopify\.theme|ShopifyAnalytics|shopify-section/gi.test(
          homepageResult.body || "",
        ),
    },
    robots: {
      ...robotsFetch,
      parsed: robotsFetch.ok ? parseRobots(robotsFetch.body || "") : null,
    },
    sitemap: {
      root_status: sitemapFetch.status,
      crawled_documents: sitemap.documents,
      total_urls: sitemap.urls.length,
      counts: {
        product: classified.product.length,
        collection: classified.collection.length,
        blog: classified.blog.length,
        page: classified.page.length,
        other: classified.other.length,
      },
      samples: {
        product: classified.product.slice(0, 10),
        collection: classified.collection.slice(0, 10),
        blog: classified.blog.slice(0, 5),
        page: classified.page.slice(0, 5),
      },
      url_patterns: analyzeUrlPatterns(sitemap.urls),
    },
    ai_readiness: {
      llms: [llmsRoot, llmsWellKnown],
      products_json: {
        path: productsJson.path,
        status: productsJson.status,
        ok: productsJson.ok,
        final_url: productsJson.final_url,
        snippet: productsJson.snippet,
        body_length: productsJson.body_length,
        headers: productsJson.headers,
        sample_product_titles: (() => {
          try {
            const parsed = JSON.parse(productsJson.body || "{}");
            return Array.isArray(parsed.products)
              ? parsed.products.slice(0, 5).map((product) => product.title).filter(Boolean)
              : [];
          } catch {
            return [];
          }
        })(),
      },
      mcp: mcpChecks,
      mcp_manifest: augmentedMcpManifestSummaries,
      mcp_rpc: mcpRpcChecks,
      storefront_mcp: storefrontMcpBaseUrl
        ? {
            base_url: storefrontMcpBaseUrl,
            endpoint: storefrontMcpEndpoint,
            ok: mcpRpcChecks.some((item) => item.url === storefrontMcpEndpoint && item.ok),
          }
        : {
            base_url: "",
            endpoint: "",
            ok: false,
          },
      ai_bot_blocks: robotsFetch.ok && robotsFetch.body
        ? Object.entries(parseRobots(robotsFetch.body).bot_rules)
            .filter(([, rule]) => rule.blocked)
            .map(([bot]) => bot)
        : [],
    },
    samples: {
      collection_pages: collectionPages,
      product_pages: productPages,
      content_pages: contentPages,
    },
    derived: {
      currencies: dedupe(currencyMatches),
      country_codes: dedupe(marketMentions),
      homepage_schema_types: homepage.json_ld_types,
      support_urls: supportUrls,
      collection_summary: summarisePages(collectionPages),
      product_summary: summarisePages(productPages),
      content_summary: summarisePages(contentPages),
      has_any_llms: [llmsRoot, llmsWellKnown].some((item) => item.ok),
      has_products_json: productsJson.ok,
      has_public_mcp: mcpChecks.some((item) => item.ok) || mcpRpcChecks.some((item) => item.ok),
      has_working_mcp_rpc: mcpRpcChecks.some((item) => item.looks_like_jsonrpc),
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  let outputPath = "";
  let configPath = DEFAULT_CONFIG_PATH;
  const domains = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--output") {
      outputPath = args[i + 1];
      i += 1;
      continue;
    }
    if (args[i] === "--config") {
      configPath = args[i + 1];
      i += 1;
      continue;
    }
    domains.push(args[i]);
  }
  loadConfig(configPath);
  ENV_MAP = mergedEnv();
  const effectiveDomains = domains.length
    ? domains
    : (AUDIT_CONFIG.sites || []).map((site) => site.domain).filter(Boolean);
  if (!effectiveDomains.length) {
    console.error("Usage: node scripts/shopify_storefront_audit.js [--config config.json] [--output output.json] domain...");
    process.exit(1);
  }
  const results = [];
  for (const domain of effectiveDomains) {
    console.error(`Auditing ${domain}...`);
    results.push(await auditDomain(domain));
  }
  const payload = {
    generated_at: new Date().toISOString(),
    config_path: configPath,
    domains: effectiveDomains,
    results,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, serialized, "utf8");
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
