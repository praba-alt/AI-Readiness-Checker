#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import puppeteer from "puppeteer";

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), "configs", "audit_config.json");
const DEFAULT_PROFILE_DIR = path.join(process.cwd(), "tmp", "browser-profiles", "shopify-admin");
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "output", "admin-browser-navigation");
const DEFAULT_PAGES = [
  "home",
  "products",
  "collections",
  "inventory",
  "custom_data",
  "metaobjects",
  "locations",
  "markets",
  "shipping",
  "checkout",
  "discounts",
  "apps",
];

const PAGE_ROUTES = {
  home: { label: "Admin Home", route: "" },
  products: { label: "Products", route: "products" },
  collections: { label: "Collections", route: "collections" },
  inventory: { label: "Inventory", route: "inventory" },
  custom_data: { label: "Custom Data", route: "settings/custom_data" },
  metaobjects: { label: "Metaobjects", route: "content/metaobjects" },
  locations: { label: "Locations", route: "settings/locations" },
  markets: { label: "Markets", route: "settings/markets" },
  shipping: { label: "Shipping", route: "settings/shipping" },
  checkout: { label: "Checkout", route: "settings/checkout" },
  discounts: { label: "Discounts", route: "discounts" },
  apps: { label: "Apps", route: "apps" },
};

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG_PATH,
    site: "",
    pages: DEFAULT_PAGES.join(","),
    profileDir: process.env.SHOPIFY_ADMIN_PROFILE_DIR || DEFAULT_PROFILE_DIR,
    outputDir: DEFAULT_OUTPUT_DIR,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--config") {
      args.config = next;
      index += 1;
    } else if (current === "--site") {
      args.site = next;
      index += 1;
    } else if (current === "--pages") {
      args.pages = next;
      index += 1;
    } else if (current === "--profile-dir") {
      args.profileDir = next;
      index += 1;
    } else if (current === "--output-dir") {
      args.outputDir = next;
      index += 1;
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
  console.log(`Usage: node scripts/shopify_admin_browser_session.mjs [options]

Options:
  --config <path>       Config JSON path
  --site <value>        Optional site filter (domain, label, or admin domain)
  --pages <list>        Comma-separated admin sections to open
  --profile-dir <path>  Persistent browser profile directory
  --output-dir <path>   Directory for screenshots and visited-url logs
`);
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
    ...parseEnvFile(path.join(process.cwd(), ".env")),
    ...process.env,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function slugifyLabel(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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

function resolveAdminBase(site, envMap) {
  const siteAdmin = site.admin || {};
  const labelSlug = slugifyLabel(site.label || site.domain);
  const envKey = siteAdmin.admin_domain_env || `SHOPIFY_ADMIN_DOMAIN_${labelSlug}`;
  const adminDomain = siteAdmin.admin_domain || envMap[envKey] || "";
  if (!adminDomain) {
    throw new Error(`Missing admin domain for ${site.label || site.domain}. Set ${envKey} in .env.`);
  }
  return normalizeAdminBase(adminDomain);
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function selectSites(sites, filterValue) {
  const selected = parseList(filterValue);
  if (!selected.length) {
    return sites;
  }
  return sites.filter((site) => {
    const candidates = [
      site.domain,
      site.label,
      (site.admin || {}).admin_domain || "",
    ].map((item) => String(item || "").trim().toLowerCase());
    return selected.some((item) => candidates.includes(item));
  });
}

function selectPages(value) {
  const selected = parseList(value);
  if (!selected.length) {
    return DEFAULT_PAGES;
  }
  const unknown = selected.filter((item) => !PAGE_ROUTES[item]);
  if (unknown.length) {
    throw new Error(`Unknown page key(s): ${unknown.join(", ")}`);
  }
  return selected;
}

function buildAdminUrl(base, route) {
  if (!route) {
    return base;
  }
  const baseWithSlash = base.endsWith("/") ? base : `${base}/`;
  return new URL(route, baseWithSlash).toString();
}

function siteSlug(site) {
  return String(site.label || site.domain || "shop")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function promptEnter(rl, message) {
  await rl.question(`${message}\nPress Enter when ready.\n`);
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
    const bodyText = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 1500) : ""));
    if (/sign in|log in/i.test(bodyText) && /shopify|google/i.test(bodyText)) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

async function launchBrowser(profileDir) {
  const common = {
    headless: false,
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

async function visitPages(browser, base, pages, screenshotsDir) {
  const visited = [];
  for (let index = 0; index < pages.length; index += 1) {
    const pageKey = pages[index];
    const pageInfo = PAGE_ROUTES[pageKey];
    const requestedUrl = buildAdminUrl(base, pageInfo.route);
    const page = await browser.newPage();
    await page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.bringToFront();
    await page.waitForNetworkIdle({ idleTime: 750, timeout: 15000 }).catch(() => {});
    const screenshotPath = path.join(
      screenshotsDir,
      `${String(index + 1).padStart(2, "0")}-${pageKey}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    visited.push({
      key: pageKey,
      label: pageInfo.label,
      requested_url: requestedUrl,
      final_url: page.url(),
      screenshot_path: screenshotPath,
    });
  }
  return visited;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = readJson(args.config);
  const envMap = mergedEnv();
  const sites = selectSites(config.sites || [], args.site);
  const pages = selectPages(args.pages);

  if (!sites.length) {
    throw new Error("No sites matched the requested filter.");
  }

  fs.mkdirSync(args.profileDir, { recursive: true });
  fs.mkdirSync(args.outputDir, { recursive: true });

  const browser = await launchBrowser(args.profileDir);
  const rl = createInterface({ input, output });

  try {
    for (const site of sites) {
      const slug = siteSlug(site);
      const adminBase = resolveAdminBase(site, envMap);
      const siteOutputDir = path.join(args.outputDir, slug);
      fs.mkdirSync(siteOutputDir, { recursive: true });

      const homePage = await browser.newPage();
      await homePage.goto(adminBase, { waitUntil: "domcontentloaded", timeout: 120000 });
      await homePage.bringToFront();

      if (!(await looksAuthenticated(homePage))) {
        await promptEnter(
          rl,
          `Log in for ${site.label} in the opened browser window. Complete Google SSO, MFA, and Shopify prompts manually. The session will be stored in ${args.profileDir}.`,
        );
        await homePage.goto(adminBase, { waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
      }

      const visited = await visitPages(browser, adminBase, pages, siteOutputDir);
      const outputPath = path.join(siteOutputDir, "navigation.json");
      fs.writeFileSync(
        outputPath,
        `${JSON.stringify(
          {
            site: {
              label: site.label,
              domain: site.domain,
              admin_base: adminBase,
            },
            profile_dir: args.profileDir,
            captured_at: new Date().toISOString(),
            visited,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      console.log(`Stored session and navigation artifacts for ${site.label} at ${siteOutputDir}`);
      await promptEnter(
        rl,
        `Review the opened ${site.label} admin tabs. The visited URLs and screenshots were saved to ${outputPath}.`,
      );
    }
  } finally {
    rl.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
