#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_PROFILE_DIR,
  buildStorefrontSignals,
  isSemanticDefinition,
  launchBrowser,
  loadDotEnv,
  normalizeAdminBase,
  parseBoolean,
  scrapeSiteWithBrowser,
} = require("./shopify_admin_browser_collect");

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), "configs", "audit_config.json");
const DEFAULT_STOREFRONT_AUDIT_PATH = path.join(process.cwd(), "output", "data", "shopify_storefront_audit.json");
const DEFAULT_API_VERSION = "2025-10";
const MAX_PRODUCTS = 100;
const MAX_COLLECTIONS = 100;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readOptionalJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function slugifyLabel(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildResult(
  status,
  score,
  evidence,
  recommendation,
  sources = "Shopify Admin API",
  observability = "Shopify Admin/API",
) {
  return {
    status,
    score,
    evidence,
    recommendation,
    observability,
    sources,
  };
}

function missingCredentialsResult(missing) {
  return buildResult(
    "MANUAL",
    0,
    `Admin automation skipped because ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing.`,
    "Provide Shopify Admin API credentials to automate this check.",
    "Credential gate",
  );
}

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG_PATH,
    output: path.join(process.cwd(), "output", "data", "shopify_admin_audit.json"),
    storefrontAudit: DEFAULT_STOREFRONT_AUDIT_PATH,
    profileDir: process.env.SHOPIFY_ADMIN_PROFILE_DIR || DEFAULT_PROFILE_DIR,
    browserHeadless: parseBoolean(process.env.SHOPIFY_ADMIN_BROWSER_HEADLESS, false),
  };

  for (let idx = 2; idx < argv.length; idx += 1) {
    const current = argv[idx];
    if (current === "--config") {
      args.config = argv[idx + 1];
      idx += 1;
    } else if (current === "--output") {
      args.output = argv[idx + 1];
      idx += 1;
    } else if (current === "--storefront-audit") {
      args.storefrontAudit = argv[idx + 1];
      idx += 1;
    } else if (current === "--profile-dir") {
      args.profileDir = argv[idx + 1];
      idx += 1;
    } else if (current === "--browser-headless") {
      args.browserHeadless = parseBoolean(argv[idx + 1], false);
      idx += 1;
    } else {
      throw new Error(`Unknown argument: ${current}`);
    }
  }
  return args;
}

function credentialSpec(site, globalConfig = {}) {
  const siteAdmin = site.admin || {};
  const labelSlug = slugifyLabel(site.label || site.domain);
  const adminDomainEnv = siteAdmin.admin_domain_env || `SHOPIFY_ADMIN_DOMAIN_${labelSlug}`;
  const tokenEnv = siteAdmin.token_env || `SHOPIFY_ADMIN_TOKEN_${labelSlug}`;
  const rawAdminDomain = siteAdmin.admin_domain || process.env[adminDomainEnv] || "";
  const adminApiHost = (() => {
    if (!rawAdminDomain) {
      return "";
    }
    const withProtocol =
      rawAdminDomain.startsWith("http://") || rawAdminDomain.startsWith("https://")
        ? rawAdminDomain
        : `https://${rawAdminDomain}`;
    const url = new URL(withProtocol);
    if (url.hostname === "admin.shopify.com") {
      return "";
    }
    return url.hostname;
  })();
  return {
    apiVersion: siteAdmin.api_version || globalConfig.api_version || DEFAULT_API_VERSION,
    adminBase: rawAdminDomain ? normalizeAdminBase(rawAdminDomain) : "",
    adminApiHost,
    token: process.env[tokenEnv] || "",
    adminDomainEnv,
    tokenEnv,
  };
}

async function fetchAdminJson(adminDomain, token, apiVersion, endpoint, query = {}) {
  const url = new URL(`https://${adminDomain}/admin/api/${apiVersion}/${endpoint}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": token,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const message = body && body.errors ? JSON.stringify(body.errors) : text || response.statusText;
    throw new Error(`${endpoint} returned ${response.status}: ${message}`);
  }

  return body;
}

async function fetchAdminGraphql(adminDomain, token, apiVersion, query, variables = {}) {
  const response = await fetch(`https://${adminDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`graphql returned ${response.status}: ${JSON.stringify(body)}`);
  }
  if (body.errors && body.errors.length) {
    throw new Error(`graphql errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data || {};
}

async function fetchProductMetafields(adminDomain, token, apiVersion, products) {
  const out = {};
  for (const product of products) {
    const payload = await fetchAdminJson(
      adminDomain,
      token,
      apiVersion,
      `products/${product.id}/metafields.json`,
      { limit: 100 },
    );
    out[product.id] = payload.metafields || [];
  }
  return out;
}

function sampleProducts(products) {
  return (products || []).slice(0, MAX_PRODUCTS);
}

function normalizeValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function distinctValues(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function analyzeOptionConsistency(products) {
  const optionSummary = new Map();
  let blankValues = 0;

  for (const product of products) {
    for (const option of product.options || []) {
      const key = normalizeValue(option.name);
      if (!key) {
        continue;
      }
      if (!optionSummary.has(key)) {
        optionSummary.set(key, new Map());
      }
      for (const value of option.values || []) {
        const normalized = normalizeValue(value);
        if (!normalized) {
          blankValues += 1;
          continue;
        }
        if (!optionSummary.get(key).has(normalized)) {
          optionSummary.get(key).set(normalized, new Set());
        }
        optionSummary.get(key).get(normalized).add(String(value).trim());
      }
    }
  }

  let inconsistentDisplayValues = 0;
  let totalTrackedValues = 0;
  for (const variants of optionSummary.values()) {
    for (const rawValues of variants.values()) {
      totalTrackedValues += 1;
      if (rawValues.size > 1) {
        inconsistentDisplayValues += 1;
      }
    }
  }

  const ratio = totalTrackedValues ? inconsistentDisplayValues / totalTrackedValues : 0;
  if (!totalTrackedValues) {
    return buildResult(
      "MANUAL",
      0,
      "No option values were available in the sampled Admin product data.",
      "Verify variant option consistency once Admin product data is available.",
      "products/options",
    );
  }
  if (blankValues === 0 && ratio <= 0.05) {
    return buildResult(
      "PASS",
      5,
      `Sampled ${products.length} products. Blank option values: ${blankValues}. Inconsistent display variants: ${inconsistentDisplayValues}/${totalTrackedValues}.`,
      "Keep option values normalized and constrained to one display format per value.",
      "products/options",
    );
  }
  if (ratio <= 0.15) {
    return buildResult(
      "PARTIAL",
      3,
      `Sampled ${products.length} products. Blank option values: ${blankValues}. Inconsistent display variants: ${inconsistentDisplayValues}/${totalTrackedValues}.`,
      "Normalize option values such as size, colour, and material into a single display format.",
      "products/options",
    );
  }
  return buildResult(
    "FAIL",
    1,
    `Sampled ${products.length} products. Blank option values: ${blankValues}. Inconsistent display variants: ${inconsistentDisplayValues}/${totalTrackedValues}.`,
    "Clean up variant option vocabularies before using them as agent-facing product attributes.",
    "products/options",
  );
}

function analyzeMetafields(productMetafields) {
  const allMetafields = Object.values(productMetafields).flat();
  const semanticHints = ["material", "fit", "fabric", "size", "care", "style", "use", "gender", "category", "feature", "model", "origin"];
  const layoutHints = ["theme", "layout", "ui", "badge", "block", "widget", "accordion", "tab", "display", "custom_css"];
  const namespaces = new Map();
  let semanticCount = 0;
  let layoutCount = 0;

  for (const metafield of allMetafields) {
    const namespace = String(metafield.namespace || "");
    const key = String(metafield.key || "");
    const text = `${namespace}.${key}`.toLowerCase();
    namespaces.set(namespace, (namespaces.get(namespace) || 0) + 1);
    if (semanticHints.some((hint) => text.includes(hint))) {
      semanticCount += 1;
    }
    if (layoutHints.some((hint) => text.includes(hint))) {
      layoutCount += 1;
    }
  }

  const namespaceCount = namespaces.size;
  const topNamespaces = [...namespaces.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name || "(blank)"}:${count}`);

  const namespaceResult = (() => {
    if (!allMetafields.length) {
      return buildResult(
        "FAIL",
        1,
        "No product metafields were found in the sampled Admin data.",
        "Add semantic metafields for durable product facts instead of relying only on copy.",
        "product metafields",
      );
    }
    if (namespaceCount <= 6) {
      return buildResult(
        "PASS",
        5,
        `Sampled ${allMetafields.length} product metafields across ${namespaceCount} namespace(s): ${topNamespaces.join(", ")}.`,
        "Keep namespace usage intentional and consistent across products.",
        "product metafields",
      );
    }
    return buildResult(
      "PARTIAL",
      3,
      `Sampled ${allMetafields.length} product metafields across ${namespaceCount} namespace(s): ${topNamespaces.join(", ")}.`,
      "Reduce namespace sprawl and standardize semantic fields across the catalogue.",
      "product metafields",
    );
  })();

  const qualityResult = (() => {
    if (!allMetafields.length) {
      return buildResult(
        "FAIL",
        1,
        "No product metafields were found, so Admin semantic depth could not be validated.",
        "Introduce metafields for semantic product attributes such as material, fit, care, and use case.",
        "product metafields",
      );
    }
    const semanticRatio = semanticCount / allMetafields.length;
    const layoutRatio = layoutCount / allMetafields.length;
    if (semanticRatio >= 0.3 && layoutRatio <= 0.2) {
      return buildResult(
        "PASS",
        5,
        `Sampled ${allMetafields.length} metafields. Semantic-like keys: ${semanticCount}. Theme/layout-like keys: ${layoutCount}.`,
        "Keep semantic metafields separate from presentation-only fields.",
        "product metafields",
      );
    }
    if (semanticCount > 0) {
      return buildResult(
        "PARTIAL",
        3,
        `Sampled ${allMetafields.length} metafields. Semantic-like keys: ${semanticCount}. Theme/layout-like keys: ${layoutCount}.`,
        "Shift more durable product facts into semantic metafields and reduce layout-oriented field usage.",
        "product metafields",
      );
    }
    return buildResult(
      "FAIL",
      1,
      `Sampled ${allMetafields.length} metafields. Semantic-like keys: ${semanticCount}. Theme/layout-like keys: ${layoutCount}.`,
      "Use metafields for reusable product semantics rather than only theme or display behavior.",
      "product metafields",
    );
  })();

  const relatedResult = (() => {
    const relatedFields = allMetafields.filter((metafield) =>
      /(related|upsell|cross[_-]?sell|recommend|alternative|pair|bundle)/i.test(
        `${metafield.namespace}.${metafield.key}`,
      ),
    );
    if (relatedFields.length) {
      return buildResult(
        "PASS",
        5,
        `Detected ${relatedFields.length} related-product style metafield(s) in the sampled Admin data.`,
        "Keep related, upsell, and alternative-product logic explicit and data-backed.",
        "product metafields",
      );
    }
    return buildResult(
      "PARTIAL",
      2,
      "No obvious related-product, upsell, or alternative-product metafields were found in the sampled Admin data.",
      "Add explicit product-reference fields for related products, alternatives, and upsells if merchandising logic matters.",
      "product metafields",
    );
  })();

  return {
    metafield_namespaces: namespaceResult,
    metafield_quality: qualityResult,
    related_product_data: relatedResult,
  };
}

function analyzeCollections(collections) {
  const smartCollections = collections.filter((collection) => Array.isArray(collection.rules) && collection.rules.length > 0);
  const customCollections = collections.length - smartCollections.length;
  if (!collections.length) {
    return buildResult(
      "FAIL",
      1,
      "No collections were returned from the Admin API sample.",
      "Model category and use-case groupings explicitly in collections.",
      "collections",
    );
  }
  if (smartCollections.length > 0) {
    return buildResult(
      "PASS",
      5,
      `Sampled ${collections.length} collections with ${smartCollections.length} smart/rule-based and ${customCollections} manual collections.`,
      "Keep collection logic explicit so category membership can be explained and reproduced.",
      "collections",
    );
  }
  return buildResult(
    "PARTIAL",
    3,
    `Sampled ${collections.length} collections, all manual/custom with no rule-based collections in the sample.`,
    "Document manual collection logic or convert stable groupings into rule-based collections where possible.",
    "collections",
  );
}

function analyzeInventory(products, locations) {
  const variants = products.flatMap((product) => product.variants || []);
  const tracked = variants.filter((variant) => String(variant.inventory_management || "").toLowerCase() === "shopify").length;
  const continueSelling = variants.filter((variant) => String(variant.inventory_policy || "").toLowerCase() === "continue").length;
  const trackedRatio = variants.length ? tracked / variants.length : 0;

  const trackingResult = (() => {
    if (!variants.length) {
      return buildResult(
        "MANUAL",
        0,
        "No variant data was returned from the Admin API sample.",
        "Verify inventory tracking once variant data is available.",
        "products/variants",
      );
    }
    if (trackedRatio >= 0.95) {
      return buildResult(
        "PASS",
        5,
        `Tracked inventory on ${tracked}/${variants.length} sampled variants.`,
        "Keep inventory tracking enabled at variant level for all sellable SKUs.",
        "products/variants",
      );
    }
    if (trackedRatio >= 0.7) {
      return buildResult(
        "PARTIAL",
        3,
        `Tracked inventory on ${tracked}/${variants.length} sampled variants.`,
        "Review untracked variants and confirm whether they should remain sellable without inventory tracking.",
        "products/variants",
      );
    }
    return buildResult(
      "FAIL",
      1,
      `Tracked inventory on ${tracked}/${variants.length} sampled variants.`,
      "Enable variant-level inventory tracking before relying on automated availability answers.",
      "products/variants",
    );
  })();

  const policyResult = (() => {
    if (!variants.length) {
      return buildResult(
        "MANUAL",
        0,
        "No variant inventory policy data was returned from the Admin API sample.",
        "Verify oversell, backorder, and preorder rules once variant data is available.",
        "products/variants",
      );
    }
    if (continueSelling === 0) {
      return buildResult(
        "PASS",
        5,
        `None of the ${variants.length} sampled variants use continue-selling inventory policy.`,
        "Keep continue-selling disabled unless a deliberate backorder or preorder flow exists.",
        "products/variants",
      );
    }
    if (continueSelling / variants.length <= 0.15) {
      return buildResult(
        "PARTIAL",
        3,
        `${continueSelling}/${variants.length} sampled variants use continue-selling inventory policy.`,
        "Review continue-selling variants and document whether they are intentional backorder or preorder cases.",
        "products/variants",
      );
    }
    return buildResult(
      "FAIL",
      1,
      `${continueSelling}/${variants.length} sampled variants use continue-selling inventory policy.`,
      "Audit oversell, backorder, and preorder logic because continue-selling is widespread in the sample.",
      "products/variants",
    );
  })();

  const locationResult = (() => {
    if (!locations.length) {
      return buildResult(
        "MANUAL",
        0,
        "No active locations were returned from the Admin API sample.",
        "Verify multi-location inventory and fulfilment modeling in Admin.",
        "locations",
      );
    }
    if (locations.length === 1) {
      return buildResult(
        "PASS",
        4,
        `One active location detected: ${locations[0].name || "Unnamed location"}.`,
        "Keep inventory ownership clear if you only fulfil from one location.",
        "locations",
      );
    }
    return buildResult(
      "PARTIAL",
      3,
      `${locations.length} active locations detected: ${locations.slice(0, 5).map((item) => item.name).join(", ")}.`,
      "Validate how stock and fulfilment limits behave across multiple locations or warehouses.",
      "locations",
    );
  })();

  return {
    inventory_tracking: trackingResult,
    inventory_policy: policyResult,
    inventory_locations: locationResult,
  };
}

function analyzeTheme(themePayload) {
  const themes = themePayload.themes || [];
  const mainTheme = themes.find((theme) => theme.role === "main");
  if (!themes.length) {
    return buildResult(
      "MANUAL",
      0,
      "Theme data was not available from the Admin API sample.",
      "Verify theme, app, and headless boundaries in Shopify Admin.",
      "themes",
    );
  }
  if (mainTheme) {
    return buildResult(
      "PARTIAL",
      3,
      `Detected ${themes.length} theme(s); main theme is "${mainTheme.name}".`,
      "Document what logic lives in the theme versus apps or headless services, because theme presence alone does not prove architecture clarity.",
      "themes",
    );
  }
  return buildResult(
    "MANUAL",
    0,
    `Detected ${themes.length} theme(s), but no main theme role was returned.`,
    "Review theme ownership and deployment state in Admin.",
    "themes",
  );
}

function analyzeWebhooks(webhookPayload) {
  const webhooks = webhookPayload.webhooks || [];
  if (!webhooks.length) {
    return buildResult(
      "PARTIAL",
      2,
      "No webhook subscriptions were returned from the Admin API sample.",
      "If downstream systems depend on Shopify changes, confirm whether webhook delivery is intentionally absent or configured elsewhere.",
      "webhooks",
    );
  }
  const topics = distinctValues(webhooks.map((item) => item.topic)).slice(0, 8);
  return buildResult(
    "PARTIAL",
    3,
    `Detected ${webhooks.length} webhook subscription(s). Sample topics: ${topics.join(", ")}.`,
    "Review retry behavior, idempotency, and monitoring; the API can prove subscriptions exist but not that handlers are safe.",
    "webhooks",
  );
}

function analyzeMetaobjects(metaobjectPayload) {
  const definitions = metaobjectPayload.metaobjectDefinitions?.nodes || [];
  if (!definitions.length) {
    return buildResult(
      "PARTIAL",
      2,
      "No metaobject definitions were returned by the Admin GraphQL sample.",
      "Use metaobjects for repeatable semantic entities such as materials, care instructions, or sizing systems where appropriate.",
      "metaobjectDefinitions",
    );
  }
  const sampleTypes = definitions.slice(0, 6).map((item) => item.type || item.name);
  return buildResult(
    "PASS",
    5,
    `Detected ${definitions.length} metaobject definition(s). Sample types: ${sampleTypes.join(", ")}.`,
    "Keep reusable semantic data in metaobjects where repeated product facts need a shared source of truth.",
    "metaobjectDefinitions",
  );
}

function analyzeTaxonomy(taxonomyPayload) {
  const products = taxonomyPayload.products?.nodes || [];
  if (!products.length) {
    return buildResult(
      "MANUAL",
      0,
      "No product taxonomy sample was returned by Admin GraphQL.",
      "Verify Shopify product category assignment once Admin GraphQL access is available.",
      "products/category",
    );
  }
  const assigned = products.filter((product) => product.category && product.category.fullName).length;
  const ratio = assigned / products.length;
  if (ratio >= 0.85) {
    return buildResult(
      "PASS",
      5,
      `Shopify product categories were assigned on ${assigned}/${products.length} sampled products.`,
      "Keep Shopify taxonomy coverage high across active products.",
      "products/category",
    );
  }
  if (ratio >= 0.5) {
    return buildResult(
      "PARTIAL",
      3,
      `Shopify product categories were assigned on ${assigned}/${products.length} sampled products.`,
      "Fill in missing Shopify product categories for the remaining catalogue.",
      "products/category",
    );
  }
  return buildResult(
    "FAIL",
    1,
    `Shopify product categories were assigned on ${assigned}/${products.length} sampled products.`,
    "Populate Shopify product categories so product semantics are machine-readable beyond free-text product types.",
    "products/category",
  );
}

function comparisonReadiness(products, productMetafields) {
  const productsWithMetafields = products.filter((product) => (productMetafields[product.id] || []).length > 0).length;
  const productsWithRichVariants = products.filter((product) => (product.variants || []).length > 1 || (product.options || []).length > 1).length;
  if (!products.length) {
    return buildResult(
      "MANUAL",
      0,
      "No product sample was available for comparison-readiness analysis.",
      "Verify comparison attributes once Admin product data is available.",
      "products",
    );
  }
  const ratio = (productsWithMetafields + productsWithRichVariants) / (products.length * 2);
  if (ratio >= 0.7) {
    return buildResult(
      "PASS",
      4,
      `${productsWithMetafields}/${products.length} sampled products had metafields and ${productsWithRichVariants}/${products.length} had multi-variant or multi-option structures.`,
      "Keep durable comparison attributes explicit in product data rather than only in narrative copy.",
      "products + metafields",
    );
  }
  if (ratio >= 0.4) {
    return buildResult(
      "PARTIAL",
      3,
      `${productsWithMetafields}/${products.length} sampled products had metafields and ${productsWithRichVariants}/${products.length} had multi-variant or multi-option structures.`,
      "Add more structured comparison attributes such as fit, material, and use case to Admin product data.",
      "products + metafields",
    );
  }
  return buildResult(
    "FAIL",
    1,
    `${productsWithMetafields}/${products.length} sampled products had metafields and ${productsWithRichVariants}/${products.length} had multi-variant or multi-option structures.`,
    "Introduce structured comparison attributes before expecting reliable side-by-side product reasoning.",
    "products + metafields",
  );
}

function browserResult(status, score, evidence, recommendation, sources = "Shopify Admin browser") {
  return buildResult(
    status,
    score,
    evidence,
    recommendation,
    sources,
    "Shopify Admin browser + public storefront",
  );
}

function browserManual(evidence, recommendation, sources = "Shopify Admin browser") {
  return browserResult("MANUAL", 0, evidence, recommendation, sources);
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function analyzeBrowserOptionConsistency(sampledProducts) {
  const productsWithOptions = sampledProducts.filter((product) => product.option_values && product.option_values.length > 0);
  if (!productsWithOptions.length) {
    return browserManual(
      "Sampled product detail pages did not expose parseable option vocabularies.",
      "Inspect a few additional multi-variant products if option-label parsing is needed for this catalogue.",
      "Product detail browser sample",
    );
  }

  const optionNames = new Set();
  const normalizedValues = new Map();
  let blankValues = 0;

  for (const product of productsWithOptions) {
    for (const optionName of product.option_names || []) {
      optionNames.add(optionName);
    }
    for (const value of product.option_values || []) {
      const raw = String(value || "").trim();
      if (!raw) {
        blankValues += 1;
        continue;
      }
      const normalized = normalizeToken(raw);
      if (!normalizedValues.has(normalized)) {
        normalizedValues.set(normalized, new Set());
      }
      normalizedValues.get(normalized).add(raw);
    }
  }

  const inconsistentValues = [...normalizedValues.values()].filter((set) => set.size > 1).length;
  if (inconsistentValues === 0 && blankValues === 0) {
    return browserResult(
      "PASS",
      4,
      `Sampled ${productsWithOptions.length} product pages. Option labels included ${[...optionNames].join(", ") || "visible variant options"}, with no conflicting display forms in the sampled values.`,
      "Keep variant labels and value formatting consistent across products so agent answers can compare options reliably.",
      "Product detail browser sample",
    );
  }
  return browserResult(
    "PARTIAL",
    3,
    `Sampled ${productsWithOptions.length} product pages. Option labels included ${[...optionNames].join(", ") || "visible variant options"}. Blank values: ${blankValues}. Inconsistent display variants: ${inconsistentValues}.`,
    "Normalize sampled option vocabularies and verify additional products if the catalogue has more than one variant pattern.",
    "Product detail browser sample",
  );
}

function analyzeBrowserMetafields(browserData, storefrontSignals) {
  const definitions = browserData.product_metafield_definitions?.rows || [];
  const sampledMetafields = browserData.sampled_product_metafields || [];
  const semanticDefinitions = definitions.filter((row) => isSemanticDefinition(row.name));
  const semanticUsed = semanticDefinitions.filter((row) => row.used_count > 0);
  const relatedDefinitions = definitions.filter((row) => /(related products|complementary products)/i.test(row.name));
  const definitionsWithUse = definitions.filter((row) => row.used_count > 0);
  const visibleSemanticSamples = sampledMetafields.filter(
    (sample) =>
      sample.has_color_value ||
      sample.has_size_field ||
      sample.has_bundle_products ||
      sample.has_variation_products ||
      sample.has_sibling_field,
  ).length;

  const namespaceResult = (() => {
    if (!definitions.length) {
      return browserManual(
        "Product metafield definitions were not visible in the sampled Admin browser session.",
        "Open Product metafield definitions or provide Admin API access to verify literal namespace strings.",
        "Custom data browser sample",
      );
    }
    return browserResult(
      "PARTIAL",
      3,
      `Visible product definitions: ${definitions.length}. Semantic-style definitions with usage: ${semanticUsed.length}. The browser UI shows clear definition names, but not the raw namespace strings.`,
      "Keep definition naming clear, and separately verify namespace strings if exact namespace governance matters.",
      "Product metafield definitions browser sample",
    );
  })();

  const qualityResult = (() => {
    if (!definitions.length) {
      return browserResult(
        "FAIL",
        1,
        "No product metafield definitions were visible in the sampled Admin browser session.",
        "Add structured product definitions before relying on browser-visible product facts alone.",
        "Product metafield definitions browser sample",
      );
    }
    if (semanticUsed.length >= 5 && visibleSemanticSamples >= 1) {
      return browserResult(
        "PASS",
        5,
        `Visible product definitions: ${definitions.length}, with ${semanticUsed.length} semantic definitions actively used. Sampled product metafield pages exposed semantic fields such as colour, size, sibling, variation, or bundle data.`,
        "Keep durable product facts in Shopify fields rather than burying them only in narrative copy or theme settings.",
        "Product metafield definitions + product metafield browser samples",
      );
    }
    if (definitionsWithUse.length > 0) {
      return browserResult(
        "PARTIAL",
        3,
        `Visible product definitions: ${definitions.length}, with ${definitionsWithUse.length} definitions used on at least one product. Sampled product metafield pages showed some structured product fields.`,
        "Increase coverage of semantic product fields such as size, material, activity, care, and sibling/variation data.",
        "Product metafield definitions + product metafield browser samples",
      );
    }
    return browserResult(
      "FAIL",
      1,
      `Visible product definitions: ${definitions.length}, but the sampled definitions showed little or no actual product usage.`,
      "Populate definitions with real product data instead of relying on empty structures.",
      "Product metafield definitions browser sample",
    );
  })();

  const relatedResult = (() => {
    const relatedUsed = relatedDefinitions.filter((row) => row.used_count > 0).length;
    if (relatedUsed > 0 && storefrontSignals.related_module_count > 0) {
      return browserResult(
        "PASS",
        5,
        `Related/complementary product definitions are used in Admin (${relatedUsed} definition(s) with usage), and the public storefront also renders related-product modules on sampled PDPs.`,
        "Keep recommendation logic explicit in Shopify data and visible on PDPs so agents can justify alternatives and complements.",
        "Product metafield definitions browser sample + public storefront audit",
      );
    }
    if (relatedUsed > 0 || storefrontSignals.related_module_count > 0) {
      return browserResult(
        "PARTIAL",
        3,
        `Related/complementary product evidence was found in ${relatedUsed > 0 ? "Admin definitions" : "public PDP modules"}, but not strongly in both places.`,
        "Wire related, complementary, and alternative-product logic into both Shopify data and the rendered storefront where possible.",
        "Product metafield definitions browser sample + public storefront audit",
      );
    }
    return browserResult(
      "FAIL",
      1,
      "No strong related-product evidence was found in either the sampled Admin definitions or the sampled public PDP modules.",
      "Add explicit related/complementary data and render it on PDPs if recommendations are part of the buying journey.",
      "Product metafield definitions browser sample + public storefront audit",
    );
  })();

  return {
    metafield_namespaces: namespaceResult,
    metafield_quality: qualityResult,
    related_product_data: relatedResult,
  };
}

function analyzeBrowserMetaobjects(browserData) {
  const metaobjectNames = browserData.custom_data?.metaobject_names || [];
  const semantic = metaobjectNames.filter((name) => isSemanticDefinition(name));
  if (!metaobjectNames.length) {
    return browserResult(
      "PARTIAL",
      2,
      "No visible metaobject definitions were found in the sampled browser session.",
      "Use metaobjects where repeated semantic entities such as material, sizing, colour, or care content need a shared source of truth.",
      "Custom data browser sample",
    );
  }
  if (semantic.length > 0) {
    return browserResult(
      "PASS",
      5,
      `Visible metaobject definitions included ${semantic.slice(0, 8).join(", ")}${semantic.length > 8 ? ", and more" : ""}.`,
      "Keep reusable semantic content in metaobjects when the same facts repeat across products or collections.",
      "Custom data browser sample",
    );
  }
  return browserResult(
    "PARTIAL",
    3,
    `Visible metaobject definitions were mostly app- or layout-oriented: ${metaobjectNames.slice(0, 8).join(", ")}${metaobjectNames.length > 8 ? ", and more" : ""}.`,
    "Add semantic metaobjects for reusable entities such as materials, care info, FAQs, or size systems if those facts repeat.",
    "Custom data browser sample",
  );
}

function analyzeBrowserTaxonomy(sampledProducts) {
  if (!sampledProducts.length) {
    return browserManual(
      "No product detail pages were sampled from the Admin browser session.",
      "Sample a few product detail pages to verify Shopify category assignment.",
      "Product detail browser sample",
    );
  }
  const assigned = sampledProducts.filter((product) => product.category).length;
  const ratio = assigned / sampledProducts.length;
  if (ratio >= 0.85) {
    return browserResult(
      "PASS",
      5,
      `Shopify product category was visible on ${assigned}/${sampledProducts.length} sampled product pages.`,
      "Keep category coverage complete across active products so product semantics remain machine-readable.",
      "Product detail browser sample",
    );
  }
  if (ratio >= 0.5) {
    return browserResult(
      "PARTIAL",
      3,
      `Shopify product category was visible on ${assigned}/${sampledProducts.length} sampled product pages.`,
      "Fill category gaps on the remaining products before relying on taxonomy-driven filtering or recommendations.",
      "Product detail browser sample",
    );
  }
  return browserResult(
    "FAIL",
    1,
    `Shopify product category was visible on ${assigned}/${sampledProducts.length} sampled product pages.`,
    "Populate Shopify product categories so product meaning is not left to free text alone.",
    "Product detail browser sample",
  );
}

function analyzeBrowserCollections(browserData) {
  const visibleCollections = browserData.collections?.visible_collections || [];
  const ruleHints = Number(browserData.collections?.rule_hint_count || 0);
  if (!visibleCollections.length) {
    return browserManual(
      "The collections list was not visible in the sampled browser session.",
      "Open the collections list to inspect rule-based versus manually curated collection membership.",
      "Collections browser sample",
    );
  }
  if (ruleHints >= 10) {
    return browserResult(
      "PASS",
      5,
      `Visible collections on the Admin list showed explicit product conditions ${ruleHints} times across the sampled page, indicating rule-based collection logic is exposed in the UI.`,
      "Keep collection logic explainable in Admin, and document the intentionally manual exceptions.",
      "Collections browser sample",
    );
  }
  return browserResult(
    "PARTIAL",
    3,
    `Visible collections were accessible in Admin, but explicit rule conditions were only spotted ${ruleHints} time(s) on the sampled page.`,
    "Document or convert important manual collections so membership logic remains explainable.",
    "Collections browser sample",
  );
}

function analyzeBrowserInventory(browserData) {
  const variants = browserData.sampled_variants || [];
  const permissions = browserData.permissions || {};
  if (!variants.length) {
    return {
      inventory_tracking: browserManual(
        "No variant detail pages were sampled from the Admin browser session.",
        "Sample a few variants to confirm tracking, oversell policy, and location visibility.",
        "Variant browser sample",
      ),
      inventory_policy: browserManual(
        "No variant detail pages were sampled from the Admin browser session.",
        "Sample a few variants to confirm whether sell-when-out-of-stock is enabled.",
        "Variant browser sample",
      ),
      inventory_locations: browserManual(
        "No location-level stock details were visible because no variant page was sampled.",
        "Sample a variant page or open Locations settings to inspect multi-location behavior.",
        "Variant browser sample",
      ),
      manual_inventory_freshness: browserManual(
        "No variant or location evidence was captured for stock freshness.",
        "Capture a few variant pages and, if possible, Locations settings to understand stock freshness and ownership.",
        "Variant browser sample",
      ),
      manual_inventory_experience: browserManual(
        "No browser evidence was captured for PDP-to-checkout stock messaging consistency.",
        "Walk a stock-sensitive journey across PDP, cart, and checkout if this needs a confident answer.",
        "Browser storefront journey review",
      ),
      manual_data_ownership: browserManual(
        "The sampled browser session did not expose enough inventory or systems evidence to map ownership of product truth.",
        "Verify which system owns stock and product truth, especially if apps or external systems are involved.",
        "Inventory browser sample",
      ),
    };
  }

  const trackedCount = variants.filter((variant) => variant.inventory_tracked).length;
  const sellOffCount = variants.filter((variant) => String(variant.sell_when_out_of_stock).toLowerCase() === "off").length;
  const sellOnCount = variants.filter((variant) => String(variant.sell_when_out_of_stock).toLowerCase() === "on").length;
  const locationNames = distinctValues(variants.flatMap((variant) => variant.location_names || []));

  const trackingResult =
    trackedCount === variants.length
      ? browserResult(
          "PASS",
          5,
          `Inventory was explicitly tracked on ${trackedCount}/${variants.length} sampled variants.`,
          "Keep variant-level inventory tracking enabled for all sellable SKUs.",
          "Variant browser sample",
        )
      : trackedCount > 0
        ? browserResult(
            "PARTIAL",
            3,
            `Inventory was explicitly tracked on ${trackedCount}/${variants.length} sampled variants.`,
            "Review untracked sampled variants before relying on stock-aware agent answers.",
            "Variant browser sample",
          )
        : browserResult(
            "FAIL",
            1,
            `Inventory tracking was not visible on any of the ${variants.length} sampled variants.`,
            "Enable variant-level tracking or confirm why sampled variants are intentionally untracked.",
            "Variant browser sample",
          );

  const policyResult =
    sellOffCount === variants.length
      ? browserResult(
          "PASS",
          5,
          `Sell when out of stock was Off on all ${variants.length} sampled variants.`,
          "Keep oversell disabled unless a deliberate backorder or preorder flow exists.",
          "Variant browser sample",
        )
      : sellOnCount > 0 && sellOnCount < variants.length
        ? browserResult(
            "PARTIAL",
            3,
            `${sellOnCount}/${variants.length} sampled variants had sell-when-out-of-stock enabled.`,
            "Review sampled oversell exceptions and document whether they are intentional preorder/backorder cases.",
            "Variant browser sample",
          )
        : browserResult(
            "FAIL",
            1,
            `${sellOnCount}/${variants.length} sampled variants had sell-when-out-of-stock enabled.`,
            "Audit oversell logic before using stock-aware recommendations or availability promises.",
            "Variant browser sample",
          );

  const locationResult =
    locationNames.length && permissions.locations === "accessible"
      ? browserResult(
          locationNames.length === 1 ? "PASS" : "PARTIAL",
          locationNames.length === 1 ? 4 : 3,
          `${locationNames.length} sampled location name(s) appeared on variant inventory screens: ${locationNames.slice(0, 5).join(", ")}.`,
          "Keep location behavior explicit so regional fulfilment and stock routing remain explainable.",
          "Variant browser sample + Locations settings",
        )
      : locationNames.length
        ? browserResult(
            "PARTIAL",
            3,
            `Variant inventory screens exposed location-level stock for ${locationNames.slice(0, 5).join(", ")}, but the current Shopify user cannot access Locations settings directly.`,
            "Ask for Locations permission if you need to confirm location rules, fulfilment routing, or warehouse ownership in detail.",
            "Variant browser sample",
          )
        : browserManual(
            "Variant inventory screens did not expose location names clearly in the sampled pages.",
            "Open Locations settings or additional variants to verify multi-location stock behavior.",
            "Variant browser sample",
          );

  const freshnessResult = browserResult(
    "PARTIAL",
    3,
    `Sampled variants exposed live stock lines and per-location inventory values in the Admin UI, which is stronger than a blind manual check, but stock freshness timing and sync ownership are not explicit in the visible browser surfaces.`,
    "Document whether stock is real-time or delayed and which system owns stock truth when apps or external systems are involved.",
    "Variant browser sample",
  );

  const experienceResult = browserManual(
    `PDP-side stock truth can be inferred from variant inventory data, but the current browser evidence does not yet cover basket and checkout messaging consistency${permissions.checkout === "denied" ? " because Checkout settings are permission-restricted for this user" : ""}.`,
    "If stock messaging consistency matters, walk one availability-sensitive journey from PDP to cart and checkout.",
    "Variant browser sample + storefront journey review",
  );

  const ownershipResult = browserResult(
    "PARTIAL",
    3,
    `Inventory is visible and tracked in Shopify variant screens, and the installed-app surface can be used to spot additional systems, but the exact system-of-record cannot be proven from the sampled browser pages alone.`,
    "Document whether Shopify is the source of truth for stock and product data, especially where apps or external systems are involved.",
    "Variant browser sample + apps browser sample",
  );

  return {
    inventory_tracking: trackingResult,
    inventory_policy: policyResult,
    inventory_locations: locationResult,
    manual_inventory_freshness: freshnessResult,
    manual_inventory_experience: experienceResult,
    manual_data_ownership: ownershipResult,
  };
}

function analyzeBrowserThemeAndApps(browserData) {
  const apps = browserData.apps?.installed_apps || [];
  const permissions = browserData.permissions || {};
  if (permissions.themes === "accessible" && apps.length) {
    return browserResult(
      "PARTIAL",
      3,
      `The Online Store theme surface was reachable in Admin, and ${apps.length} installed app(s) were visible (${apps.slice(0, 8).join(", ")}${apps.length > 8 ? ", and more" : ""}).`,
      "Document what logic lives in theme code, apps, Shopify settings, and external systems so architectural boundaries are explicit.",
      "Themes + apps browser sample",
    );
  }
  if (permissions.themes === "accessible") {
    return browserResult(
      "PARTIAL",
      3,
      "The Online Store theme surface was reachable in Admin, but the supporting app surface was limited in the sampled browser pages.",
      "Document what logic lives in the theme and what comes from apps or external systems.",
      "Themes browser sample",
    );
  }
  return browserManual(
    "The current Shopify user could not expose enough theme/app detail from the sampled browser pages to describe architecture boundaries confidently.",
    "Open the Online Store theme area and installed apps with sufficient access if you want this turned into a stronger automated check.",
    "Themes + apps browser sample",
  );
}

function analyzeBrowserComparison(browserData, storefrontSignals) {
  const sampledProducts = browserData.sampled_products || [];
  if (!sampledProducts.length) {
    return browserManual(
      "No product detail pages were sampled from the Admin browser session.",
      "Sample a few products to evaluate whether comparison-ready data is explicit in Shopify and on the storefront.",
      "Product detail browser sample + public storefront audit",
    );
  }
  const withCategories = sampledProducts.filter((product) => product.category).length;
  const withMetafields = sampledProducts.filter((product) => Number(product.metafield_count || 0) > 0).length;
  const withRichVariants = sampledProducts.filter(
    (product) => Number(product.variant_count || 0) > 1 || (product.option_values || []).length > 1,
  ).length;

  let strength = 0;
  if (withCategories >= sampledProducts.length * 0.8) strength += 1;
  if (withMetafields >= sampledProducts.length * 0.8) strength += 1;
  if (withRichVariants >= sampledProducts.length * 0.5) strength += 1;
  if (storefrontSignals.clothing_attribute_category_count >= 2) strength += 1;
  if (storefrontSignals.size_guide_link_total > 0) strength += 1;
  if (storefrontSignals.related_module_count > 0) strength += 1;
  if (storefrontSignals.all_have_product_schema) strength += 1;

  if (strength >= 4) {
    return browserResult(
      "PASS",
      4,
      `${withCategories}/${sampledProducts.length} sampled products had visible categories, ${withMetafields}/${sampledProducts.length} had visible metafield counts, and ${withRichVariants}/${sampledProducts.length} had rich variant structures. Public PDPs also exposed ${storefrontSignals.clothing_attribute_category_count} attribute family/families and ${storefrontSignals.related_module_count} related-product module(s).`,
      "Keep comparison-relevant facts explicit in Shopify and visible on PDPs so agents can justify recommendations side by side.",
      "Product detail browser sample + public storefront audit",
    );
  }
  if (strength >= 2) {
    return browserResult(
      "PARTIAL",
      3,
      `${withCategories}/${sampledProducts.length} sampled products had visible categories, ${withMetafields}/${sampledProducts.length} had visible metafield counts, and ${withRichVariants}/${sampledProducts.length} had rich variant structures. Public PDP comparison signals were mixed.`,
      "Add more explicit comparison data such as size guides, attribute blocks, related alternatives, and consistent Product schema.",
      "Product detail browser sample + public storefront audit",
    );
  }
  return browserResult(
    "FAIL",
    1,
    `Comparison signals were weak in both Shopify Admin and sampled public PDPs. Categories, structured fields, and rich variant structures were sparse in the sample.`,
    "Introduce explicit comparison-ready product data before expecting strong recommendation quality.",
    "Product detail browser sample + public storefront audit",
  );
}

function analyzeBrowserLifecycle(browserData) {
  const sampledProducts = browserData.sampled_products || [];
  const sampledStatuses = distinctValues(sampledProducts.map((product) => product.status));
  const pageStatusCounts = browserData.products?.status_counts || {};
  if (!sampledProducts.length) {
    return browserManual(
      "No sampled product detail pages were available to inspect publication status usage.",
      "Sample a few product pages to verify how Draft, Active, and Archived states are being used.",
      "Products browser sample",
    );
  }
  return browserResult(
    "PARTIAL",
    3,
    `Products list filters for Active, Draft, and Archived were visible in Admin, and sampled product statuses included ${sampledStatuses.join(", ") || "one visible status"}. This confirms status usage exists, but not the merchandising rule for when each state should be used.`,
    "Define explicit lifecycle rules for draft, active, archived, and any seasonal/core/discontinued states so catalogue governance is explainable.",
    "Products browser sample + product detail browser sample",
  );
}

function analyzeBrowserCommerce(browserData) {
  const permissions = browserData.permissions || {};
  const denied = ["markets", "shipping", "checkout"].filter((key) => permissions[key] === "denied");
  if (!denied.length) {
    return browserResult(
      "PARTIAL",
      3,
      "Markets, shipping, and checkout settings were reachable in the sampled browser session, so commerce-rule surfaces are at least inspectable from this login.",
      "Translate the visible settings into plain-English rules for pricing, shipping, tax, and market behavior if those outcomes need to be audited consistently.",
      "Settings browser sample",
    );
  }
  return browserManual(
    `The current Shopify user cannot access ${denied.join(", ")} settings, so pricing, shipping, market, and checkout rules cannot be automated fully from this browser session.`,
    "Use a higher-permission Shopify login if you want commerce logic audited from Admin rather than left as a guided manual review.",
    "Settings browser sample",
  );
}

function analyzeBrowserWebhooks() {
  return browserManual(
    "The browser surfaces used in this audit do not expose webhook subscriptions or delivery reliability clearly.",
    "Use Admin API access or dedicated integration tooling if webhook verification needs to move beyond manual review.",
    "Browser limitation",
  );
}

function analyzeBrowserChecks(browserData, storefrontSite) {
  const storefrontSignals = buildStorefrontSignals(storefrontSite);
  return {
    option_consistency: analyzeBrowserOptionConsistency(browserData.sampled_products || []),
    ...analyzeBrowserMetafields(browserData, storefrontSignals),
    metaobject_usage: analyzeBrowserMetaobjects(browserData),
    taxonomy_assignment: analyzeBrowserTaxonomy(browserData.sampled_products || []),
    collection_logic: analyzeBrowserCollections(browserData),
    ...analyzeBrowserInventory(browserData),
    theme_architecture: analyzeBrowserThemeAndApps(browserData),
    webhook_setup: analyzeBrowserWebhooks(browserData),
    comparison_readiness: analyzeBrowserComparison(browserData, storefrontSignals),
    manual_product_lifecycle: analyzeBrowserLifecycle(browserData),
    manual_commerce_logic: analyzeBrowserCommerce(browserData),
  };
}

const AUTOMATED_CHECK_KEYS = [
  "option_consistency",
  "metafield_namespaces",
  "metafield_quality",
  "metaobject_usage",
  "taxonomy_assignment",
  "collection_logic",
  "related_product_data",
  "inventory_tracking",
  "inventory_policy",
  "inventory_locations",
  "theme_architecture",
  "webhook_setup",
  "comparison_readiness",
];

const BROWSER_OVERRIDE_KEYS = [
  "manual_product_lifecycle",
  "manual_inventory_freshness",
  "manual_inventory_experience",
  "manual_commerce_logic",
  "manual_data_ownership",
];

function applyCheckResult(siteResult, key, value) {
  siteResult.checks[key] = value;
}

function applyFailureChecks(siteResult, keys, evidence, recommendation, sources, observability = "Shopify Admin/API") {
  for (const key of keys) {
    applyCheckResult(
      siteResult,
      key,
      buildResult("MANUAL", 0, evidence, recommendation, sources, observability),
    );
  }
}

async function runSiteAuditWithApi(siteResult, site, creds) {
  const adminHost = creds.adminApiHost;
  const [shopPayload, productPayload, smartCollections, customCollections, locationsPayload, themesPayload, webhooksPayload] = await Promise.all([
    fetchAdminJson(adminHost, creds.token, creds.apiVersion, "shop.json"),
    fetchAdminJson(adminHost, creds.token, creds.apiVersion, "products.json", { limit: MAX_PRODUCTS, status: "any" }),
    fetchAdminJson(adminHost, creds.token, creds.apiVersion, "smart_collections.json", { limit: MAX_COLLECTIONS }),
    fetchAdminJson(adminHost, creds.token, creds.apiVersion, "custom_collections.json", { limit: MAX_COLLECTIONS }),
    fetchAdminJson(adminHost, creds.token, creds.apiVersion, "locations.json"),
    fetchAdminJson(adminHost, creds.token, creds.apiVersion, "themes.json"),
    fetchAdminJson(adminHost, creds.token, creds.apiVersion, "webhooks.json", { limit: 50 }),
  ]);

  const products = sampleProducts(productPayload.products || []);
  const productMetafields = await fetchProductMetafields(adminHost, creds.token, creds.apiVersion, products.slice(0, 25));

  let metaobjectResult = buildResult(
    "MANUAL",
    0,
    "Metaobject verification was not attempted because GraphQL did not run.",
    "Grant Admin GraphQL access to automate metaobject checks.",
    "metaobjectDefinitions",
  );
  let taxonomyResult = buildResult(
    "MANUAL",
    0,
    "Taxonomy verification was not attempted because GraphQL did not run.",
    "Grant Admin GraphQL access to automate Shopify product category checks.",
    "products/category",
  );

  try {
    const metaobjects = await fetchAdminGraphql(
      adminHost,
      creds.token,
      creds.apiVersion,
      `
        query AdminMetaobjects {
          metaobjectDefinitions(first: 25) {
            nodes {
              type
              name
            }
          }
        }
      `,
    );
    metaobjectResult = analyzeMetaobjects(metaobjects);
  } catch (error) {
    metaobjectResult = buildResult(
      "MANUAL",
      0,
      `Metaobject verification failed: ${error.message}`,
      "Ensure the Admin token includes GraphQL access needed for metaobject definitions.",
      "metaobjectDefinitions",
    );
  }

  try {
    const taxonomy = await fetchAdminGraphql(
      adminHost,
      creds.token,
      creds.apiVersion,
      `
        query ProductTaxonomySample($first: Int!) {
          products(first: $first, query: "status:active") {
            nodes {
              id
              title
              category {
                fullName
              }
            }
          }
        }
      `,
      { first: 25 },
    );
    taxonomyResult = analyzeTaxonomy(taxonomy);
  } catch (error) {
    taxonomyResult = buildResult(
      "MANUAL",
      0,
      `Shopify category verification failed: ${error.message}`,
      "Ensure the Admin token includes GraphQL product access needed for category assignment checks.",
      "products/category",
    );
  }

  const collections = [...(smartCollections.smart_collections || []), ...(customCollections.custom_collections || [])];
  siteResult.audit_path = "api";
  siteResult.shop = shopPayload.shop || null;
  siteResult.checks.option_consistency = analyzeOptionConsistency(products);
  Object.assign(siteResult.checks, analyzeMetafields(productMetafields));
  siteResult.checks.metaobject_usage = metaobjectResult;
  siteResult.checks.taxonomy_assignment = taxonomyResult;
  siteResult.checks.collection_logic = analyzeCollections(collections);
  Object.assign(siteResult.checks, analyzeInventory(products, locationsPayload.locations || []));
  siteResult.checks.theme_architecture = analyzeTheme(themesPayload);
  siteResult.checks.webhook_setup = analyzeWebhooks(webhooksPayload);
  siteResult.checks.comparison_readiness = comparisonReadiness(products, productMetafields);
  return siteResult;
}

async function runSiteAuditWithBrowser(siteResult, site, creds, browser, storefrontSite) {
  const browserData = await scrapeSiteWithBrowser(browser, site, creds.adminBase);
  if (!browserData.authenticated) {
    const evidence = browserData.error || "Stored browser session is not authenticated for this Shopify admin.";
    applyFailureChecks(
      siteResult,
      [...AUTOMATED_CHECK_KEYS, ...BROWSER_OVERRIDE_KEYS],
      evidence,
      "Run `npm run admin:session` again and complete any Shopify/Google prompts before retrying the browser audit.",
      "Shopify Admin browser session",
      "Shopify Admin browser + public storefront",
    );
    siteResult.error = evidence;
    return siteResult;
  }
  siteResult.audit_path = "browser";
  siteResult.browser_summary = {
    admin_base: browserData.admin_base,
    sampled_products: (browserData.sampled_products || []).length,
    sampled_variants: (browserData.sampled_variants || []).length,
    installed_apps: (browserData.apps?.installed_apps || []).length,
  };
  Object.assign(siteResult.checks, analyzeBrowserChecks(browserData, storefrontSite));
  return siteResult;
}

async function runSiteAudit(site, globalConfig = {}, browser = null, storefrontSite = null) {
  const creds = credentialSpec(site, globalConfig);
  const missing = [];
  if (!creds.adminBase && !creds.adminApiHost) {
    missing.push(`admin domain (${creds.adminDomainEnv})`);
  }
  if (!creds.token) {
    missing.push(`admin token (${creds.tokenEnv})`);
  }

  const siteResult = {
    domain: site.domain,
    label: site.label,
    admin_domain: creds.adminBase || creds.adminApiHost || null,
    api_version: creds.apiVersion,
    credentials_available: Boolean(creds.token && creds.adminApiHost),
    browser_session_available: Boolean(browser && creds.adminBase),
    audit_path: "manual",
    checks: {},
    error: null,
  };

  let apiError = null;
  if (creds.token && creds.adminApiHost) {
    try {
      return await runSiteAuditWithApi(siteResult, site, creds);
    } catch (error) {
      apiError = error;
    }
  }

  if (browser && creds.adminBase) {
    try {
      return await runSiteAuditWithBrowser(siteResult, site, creds, browser, storefrontSite);
    } catch (error) {
      siteResult.error = error.message;
      applyFailureChecks(
        siteResult,
        [...AUTOMATED_CHECK_KEYS, ...BROWSER_OVERRIDE_KEYS],
        `Browser-backed admin automation failed: ${error.message}`,
        "Check the saved Shopify browser session, permissions, and page reachability before retrying.",
        "Shopify Admin browser failure",
        "Shopify Admin browser + public storefront",
      );
      return siteResult;
    }
  }

  if (apiError) {
    siteResult.error = apiError.message;
    applyFailureChecks(
      siteResult,
      [...AUTOMATED_CHECK_KEYS, ...BROWSER_OVERRIDE_KEYS],
      `Admin automation failed: ${apiError.message}`,
      "Check Admin API credentials, scopes, or browser-session availability before retrying.",
      "Admin API failure",
    );
    return siteResult;
  }

  if (missing.length > 0) {
    const gated = missingCredentialsResult(missing);
    for (const key of AUTOMATED_CHECK_KEYS) {
      siteResult.checks[key] = gated;
    }
    return siteResult;
  }

  applyFailureChecks(
    siteResult,
    [...AUTOMATED_CHECK_KEYS, ...BROWSER_OVERRIDE_KEYS],
    "No usable Admin API credentials or authenticated browser session were available for this store.",
    "Provide a Shopify Admin token or run the browser-session helper before retrying the admin audit.",
    "Credential gate",
  );
  return siteResult;
}

async function main() {
  const args = parseArgs(process.argv);
  loadDotEnv();
  const config = readJson(args.config);
  const storefrontPayload = readOptionalJson(args.storefrontAudit);
  const storefrontByDomain = Object.fromEntries((storefrontPayload?.results || []).map((site) => [site.domain, site]));
  const globalAdminConfig = config.admin || {};
  const sites = config.sites || [];
  const needsBrowser = sites.some((site) => {
    const creds = credentialSpec(site, globalAdminConfig);
    return Boolean(creds.adminBase) && !(creds.token && creds.adminApiHost);
  });
  const browser = needsBrowser ? await launchBrowser(args.profileDir, args.browserHeadless) : null;
  const results = [];
  try {
    for (const site of sites) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await runSiteAudit(site, globalAdminConfig, browser, storefrontByDomain[site.domain] || null));
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
  writeJson(args.output, {
    generated_at: new Date().toISOString(),
    config_path: args.config,
    storefront_audit_path: storefrontPayload ? args.storefrontAudit : null,
    results,
  });
  console.log(`Wrote ${args.output}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
