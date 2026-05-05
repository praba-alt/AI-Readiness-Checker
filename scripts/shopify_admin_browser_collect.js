#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const DEFAULT_PROFILE_DIR = path.join(process.cwd(), "tmp", "browser-profiles", "shopify-admin");
const MAX_SAMPLED_PRODUCTS = 5;
const MAX_SAMPLED_VARIANTS = 3;
const MAX_SAMPLED_METAFIELDS = 3;

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
  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeAdminBase(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    throw new Error("Missing Shopify admin domain");
  }

  const withProtocol = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  const cleanPath = url.pathname.replace(/\/+$/, "");

  if (url.hostname === "admin.shopify.com") {
    if (cleanPath.startsWith("/store/")) {
      return `${url.origin}${cleanPath}`;
    }
    const parts = cleanPath.split("/").filter(Boolean);
    if (parts.length === 1) {
      return `${url.origin}/store/${parts[0]}`;
    }
    throw new Error(`Unsupported admin.shopify.com path: ${url.pathname}`);
  }

  if (!cleanPath || cleanPath === "/") {
    return `${url.origin}/admin`;
  }
  if (cleanPath === "/admin") {
    return `${url.origin}${cleanPath}`;
  }
  return `${url.origin}${cleanPath}`;
}

function uniqueStrings(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function parseLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function firstMatch(text, regex, index = 1) {
  const match = regex.exec(String(text || ""));
  return match ? String(match[index] || "").trim() : "";
}

function parseInteger(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  return digits ? Number(digits) : 0;
}

function slugifyLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function looksAuthenticated(page) {
  const currentUrl = page.url().toLowerCase();
  if (
    currentUrl.includes("accounts.google.com") ||
    currentUrl.includes("shopify.com/authentication") ||
    currentUrl.includes("login") ||
    currentUrl.includes("signin")
  ) {
    return false;
  }

  try {
    const text = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 1500) : ""));
    if (/your connection needs to be verified before you can proceed/i.test(text)) {
      return false;
    }
    if (/sign in|log in/i.test(text) && /shopify|google/i.test(text)) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

async function launchBrowser(profileDir = DEFAULT_PROFILE_DIR, headless = false) {
  const common = {
    headless,
    userDataDir: profileDir,
    defaultViewport: null,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--start-maximized"],
  };

  if (common.executablePath) {
    return puppeteer.launch(common);
  }

  const preferredChannel = process.env.PUPPETEER_BROWSER_CHANNEL || "chrome";
  try {
    return await puppeteer.launch({ ...common, channel: preferredChannel });
  } catch {
    return puppeteer.launch(common);
  }
}

async function openSnapshot(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForNetworkIdle({ idleTime: 750, timeout: 15000 }).catch(() => {});
    return await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      text: document.body ? document.body.innerText.slice(0, 20000) : "",
      links: [...document.querySelectorAll("a[href]")]
        .map((anchor) => ({
          text: (anchor.innerText || anchor.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200),
          href: anchor.href,
        }))
        .filter((item) => item.href.includes("/store/")),
    }));
  } finally {
    await page.close().catch(() => {});
  }
}

function productUrlsFromSnapshot(snapshot, limit = MAX_SAMPLED_PRODUCTS) {
  const urls = uniqueStrings(
    (snapshot.links || [])
      .map((item) => item.href)
      .filter((href) => /\/products\/\d+$/.test(href)),
  );
  return urls.slice(0, limit);
}

function variantUrlsFromSnapshot(snapshot, limit = 1) {
  const urls = uniqueStrings(
    (snapshot.links || [])
      .map((item) => item.href)
      .filter((href) => /\/products\/\d+\/variants\/\d+$/.test(href)),
  );
  return urls.slice(0, limit);
}

function collectionNamesFromSnapshot(snapshot) {
  return uniqueStrings(
    (snapshot.links || [])
      .filter((item) => /\/collections\/\d+$/.test(item.href))
      .map((item) => item.text),
  );
}

function metafieldsUrlFromSnapshot(snapshot) {
  return (snapshot.links || []).find((item) => /\/products\/\d+\/metafields$/.test(item.href))?.href || "";
}

function extractOptionDetails(text) {
  const match = /Variants[\s\S]{0,1200}?Add variant([\s\S]{0,1200}?)(?:All locations|Select all variants)/i.exec(String(text || ""));
  if (!match) {
    return { names: [], values: [] };
  }

  const ignore = new Set([
    "add variant",
    "add another option",
    "variant",
    "price",
    "available",
    "upload image",
    "image is not applied",
    "select variant",
  ]);

  const tokens = parseLines(match[1]).filter((line) => {
    const lower = line.toLowerCase();
    if (ignore.has(lower)) {
      return false;
    }
    if (/^\d+ variants?$/.test(lower)) {
      return false;
    }
    if (/^[£$€₹]/.test(line)) {
      return false;
    }
    if (/^[A-Z0-9-]{6,}$/.test(line)) {
      return false;
    }
    if (/^\d+(\.\d+)?$/.test(line)) {
      return false;
    }
    return true;
  });

  if (!tokens.length) {
    return { names: [], values: [] };
  }

  const nameCandidates = tokens.filter((token) => /^[A-Za-z][A-Za-z /&()-]+$/.test(token) && token.length < 40);
  const optionName = nameCandidates[0] || "";
  const values = tokens
    .slice(optionName ? tokens.indexOf(optionName) + 1 : 0)
    .filter((token) => token !== optionName)
    .slice(0, 12);

  return {
    names: optionName ? [optionName] : [],
    values,
  };
}

function parseProductSnapshot(snapshot) {
  const titleParts = String(snapshot.title || "")
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  const text = String(snapshot.text || "");
  const optionDetails = extractOptionDetails(text);
  return {
    title: titleParts.length >= 3 ? titleParts[2] : firstMatch(text, /^([^\n]+)/, 1),
    status: firstMatch(text.slice(0, 1200), /\n(Active|Draft|Archived)\n/i),
    category: firstMatch(text, /Category(?:\n\d+ metafields)?\nCategory\s*\n+([^\n]+)/i),
    metafield_count: parseInteger(firstMatch(text, /Category\s*\n(\d+)\s+metafields/i)),
    variant_count: parseInteger(firstMatch(text, /(\d+)\s+variants/i)),
    inventory_total: parseInteger(firstMatch(text, /Total inventory across all locations:\s*(\d+)\s+available/i)),
    collections: collectionNamesFromSnapshot(snapshot),
    variant_urls: variantUrlsFromSnapshot(snapshot, MAX_SAMPLED_VARIANTS),
    metafields_url: metafieldsUrlFromSnapshot(snapshot),
    option_names: optionDetails.names,
    option_values: optionDetails.values,
  };
}

function parseVariantSnapshot(snapshot) {
  const text = String(snapshot.text || "");
  const lines = parseLines(text);
  const locationsIdx = lines.indexOf("Locations");
  const adjustmentIdx = lines.indexOf("View adjustment history");
  const locationLines =
    locationsIdx >= 0 && adjustmentIdx > locationsIdx
      ? lines
          .slice(locationsIdx + 1, adjustmentIdx)
          .filter(
            (line) =>
              !["Unavailable", "Committed", "Available", "On hand"].includes(line) &&
              !/^\d+$/.test(line),
          )
      : [];
  return {
    title: String(snapshot.title || ""),
    inventory_tracked: /Inventory tracked/i.test(text),
    sell_when_out_of_stock: firstMatch(text, /Sell when out of stock\s*\n\s*(On|Off)/i),
    location_names: uniqueStrings(locationLines),
    sku: firstMatch(text, /SKU\s*\n\s*([^\n]+)/i),
  };
}

function parseCustomDataSnapshot(snapshot) {
  const text = String(snapshot.text || "");
  const metaobjectNames = uniqueStrings(
    (snapshot.links || [])
      .filter((item) => /\/settings\/custom_data\/metaobjects\//.test(item.href) && !/\/create$/.test(item.href))
      .map((item) => item.text),
  );
  return {
    product_definitions: parseInteger(firstMatch(text, /Products\s*\n(\d+)/i)),
    variant_definitions: parseInteger(firstMatch(text, /Variants\s*\n(\d+)/i)),
    collection_definitions: parseInteger(firstMatch(text, /Collections\s*\n(\d+)/i)),
    shop_definitions: parseInteger(firstMatch(text, /Shop\s*\n(\d+)/i)),
    metaobject_names: metaobjectNames,
  };
}

function parseProductDefinitionSnapshot(snapshot) {
  const lines = parseLines(snapshot.text || "");
  const usedInIdx = lines.indexOf("Used in");
  const rows = [];
  if (usedInIdx === -1) {
    return { rows };
  }

  for (let idx = usedInIdx + 1; idx + 2 < lines.length; idx += 3) {
    const name = lines[idx];
    const type = lines[idx + 1];
    const used = lines[idx + 2];
    if (!name || !type || !used) {
      break;
    }
    if (["Close", "Resize Sidebar"].includes(name)) {
      break;
    }
    if (!/\d+\s+product/i.test(used)) {
      break;
    }
    rows.push({
      name,
      type,
      used_label: used,
      used_count: parseInteger(used),
    });
  }
  return { rows };
}

function parseMetafieldSample(snapshot) {
  const text = String(snapshot.text || "");
  return {
    category_label: firstMatch(text, /Category metafields:\s*([^\n]+)/i),
    has_color_value: /\nColor\s*\n+\s*[^\n]+/i.test(text),
    has_size_field: /\nSize\s*\n/i.test(text),
    has_related_products: /\nRelated products\s*\n/i.test(text),
    has_complementary_products: /\nComplementary products\s*\n/i.test(text),
    has_bundle_products: /\nBundle Products\s*\n/i.test(text),
    has_sibling_field: /\nSibling\s*\n/i.test(text),
    has_variation_products: /\nVariation products\s*\n/i.test(text),
  };
}

function parseCollectionsSnapshot(snapshot) {
  const text = String(snapshot.text || "");
  const ruleHints =
    (text.match(/contains|is greater than|is less than|is equal to|doesn't have|has a compare-at price/gi) || [])
      .length;
  return {
    visible_collections: uniqueStrings(
      (snapshot.links || [])
        .filter((item) => /\/collections\/\d+$/.test(item.href))
        .map((item) => item.text),
    ),
    rule_hint_count: ruleHints,
  };
}

function permissionState(snapshot) {
  const text = String(snapshot.text || "");
  if (/you need permission to view this feature/i.test(text)) {
    return "denied";
  }
  if (/this page is ready/i.test(text) || /shopify plus/i.test(snapshot.title || "")) {
    return "accessible";
  }
  return "unknown";
}

function parseAppsSnapshot(snapshot) {
  const lines = parseLines(snapshot.text || "");
  const start = lines.indexOf("Installed");
  const end = lines.indexOf("Learn more about apps");
  const appLines =
    start >= 0
      ? lines
          .slice(start + 2, end >= 0 ? end : undefined)
          .filter((line) => !["Uninstalled", "Close", "Resize Sidebar"].includes(line))
      : [];
  return {
    installed_apps: uniqueStrings(appLines),
  };
}

function isSemanticDefinition(name) {
  return /(material|fabric|size|color|colour|age|gender|activity|feature|bundle|sibling|chart|related|complementary|breadcrumb)/i.test(
    String(name || ""),
  );
}

async function scrapeSiteWithBrowser(browser, site, adminBase) {
  const home = await openSnapshot(browser, adminBase);
  if (!home || !home.url || !(await (async () => {
    const page = await browser.newPage();
    try {
      await page.goto(adminBase, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForNetworkIdle({ idleTime: 750, timeout: 15000 }).catch(() => {});
      return looksAuthenticated(page);
    } finally {
      await page.close().catch(() => {});
    }
  })())) {
    return {
      label: site.label,
      domain: site.domain,
      admin_base: adminBase,
      authenticated: false,
      error: "Stored browser session is not authenticated for this Shopify admin.",
    };
  }

  const products = await openSnapshot(browser, `${adminBase}/products?selectedView=all`);
  const customData = await openSnapshot(browser, `${adminBase}/settings/custom_data`);
  const productDefinitions = await openSnapshot(browser, `${adminBase}/settings/custom_data/product/metafields`);
  const collections = await openSnapshot(browser, `${adminBase}/collections?selectedView=all`);
  const apps = await openSnapshot(browser, `${adminBase}/settings/apps?tab=installed`);
  const themes = await openSnapshot(browser, `${adminBase}/themes`);
  const locations = await openSnapshot(browser, `${adminBase}/settings/locations`);
  const markets = await openSnapshot(browser, `${adminBase}/settings/markets`);
  const shipping = await openSnapshot(browser, `${adminBase}/settings/shipping`);
  const checkout = await openSnapshot(browser, `${adminBase}/settings/checkout`);

  const productUrls = productUrlsFromSnapshot(products);
  const sampledProducts = [];
  const sampledVariants = [];
  const sampledMetafields = [];

  for (const productUrl of productUrls) {
    const productSnapshot = await openSnapshot(browser, productUrl);
    const parsedProduct = parseProductSnapshot(productSnapshot);
    sampledProducts.push(parsedProduct);

    if (parsedProduct.metafields_url && sampledMetafields.length < MAX_SAMPLED_METAFIELDS) {
      const metafieldSnapshot = await openSnapshot(browser, parsedProduct.metafields_url);
      sampledMetafields.push(parseMetafieldSample(metafieldSnapshot));
    }

    for (const variantUrl of parsedProduct.variant_urls || []) {
      if (sampledVariants.length >= MAX_SAMPLED_VARIANTS) {
        break;
      }
      const variantSnapshot = await openSnapshot(browser, variantUrl);
      sampledVariants.push(parseVariantSnapshot(variantSnapshot));
    }
    if (sampledVariants.length >= MAX_SAMPLED_VARIANTS) {
      continue;
    }
  }

  return {
    label: site.label,
    domain: site.domain,
    site_slug: slugifyLabel(site.label || site.domain),
    admin_base: adminBase,
    authenticated: true,
    products: {
      visible_product_urls: productUrls,
      status_counts: {
        active: (products.text.match(/\nActive\n/g) || []).length,
        draft: (products.text.match(/\nDraft\n/g) || []).length,
        archived: (products.text.match(/\nArchived\n/g) || []).length,
      },
    },
    custom_data: parseCustomDataSnapshot(customData),
    product_metafield_definitions: parseProductDefinitionSnapshot(productDefinitions),
    collections: parseCollectionsSnapshot(collections),
    apps: parseAppsSnapshot(apps),
    permissions: {
      themes: permissionState(themes),
      locations: permissionState(locations),
      markets: permissionState(markets),
      shipping: permissionState(shipping),
      checkout: permissionState(checkout),
    },
    sampled_products: sampledProducts,
    sampled_product_metafields: sampledMetafields,
    sampled_variants: sampledVariants,
  };
}

function buildStorefrontSignals(storefrontSite) {
  const productSummary = storefrontSite?.derived?.product_summary || {};
  return {
    related_module_count: Number(productSummary.related_module_count || 0),
    clothing_attribute_category_count: Number(productSummary.clothing_attribute_category_count || 0),
    size_guide_link_total: Number(productSummary.size_guide_link_total || 0),
    all_have_product_schema: Boolean(productSummary.all_have_product_schema),
    support_link_total: Number(productSummary.support_link_total || 0),
    policy_link_total: Number(productSummary.policy_link_total || 0),
    review_signal_total: Number(productSummary.review_signal_total || 0),
  };
}

module.exports = {
  DEFAULT_PROFILE_DIR,
  buildStorefrontSignals,
  isSemanticDefinition,
  launchBrowser,
  loadDotEnv,
  normalizeAdminBase,
  parseBoolean,
  parseEnvFile,
  scrapeSiteWithBrowser,
};
