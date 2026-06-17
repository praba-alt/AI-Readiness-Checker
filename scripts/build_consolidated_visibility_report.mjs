#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

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

function parseArgs(argv) {
  const args = {
    inputs: [],
    output: "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--input") {
      args.inputs.push(next);
      index += 1;
    } else if (current === "--output") {
      args.output = next;
      index += 1;
    } else if (current === "--help" || current === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${current}`);
    }
  }

  if (!args.inputs.length || !args.output) {
    printHelp();
    process.exit(1);
  }

  return args;
}

function printHelp() {
  console.log(
    "Usage: node scripts/build_consolidated_visibility_report.mjs --input <provider.xlsx> [--input <provider.xlsx> ...] --output <report.xlsx>"
  );
}

function readWorkbookRows(filePath) {
  const workbook = XLSX.readFile(filePath);
  const rowsBySheet = {};
  for (const sheetName of workbook.SheetNames) {
    rowsBySheet[sheetName] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
  }
  return rowsBySheet;
}

function rowKey(sheetName, row) {
  return [
    sheetName,
    String(row["Platform"] || row.platform || "").trim().toLowerCase(),
    String(row["Query"] || row.query || "").trim().toLowerCase(),
    String(row["Intent"] || row.intent || "").trim().toLowerCase(),
  ].join("::");
}

function mergeRows(inputs) {
  const merged = {};
  for (const input of inputs) {
    const rowsBySheet = readWorkbookRows(input);
    for (const [sheetName, rows] of Object.entries(rowsBySheet)) {
      if (!merged[sheetName]) {
        merged[sheetName] = new Map();
      }
      for (const row of rows) {
        merged[sheetName].set(rowKey(sheetName, row), row);
      }
    }
  }

  const out = {};
  for (const [sheetName, rowMap] of Object.entries(merged)) {
    out[sheetName] = Array.from(rowMap.values()).sort((left, right) => {
      const byPlatform = String(left["Platform"] || "").localeCompare(String(right["Platform"] || ""));
      if (byPlatform !== 0) return byPlatform;
      return String(left["Query"] || "").localeCompare(String(right["Query"] || ""));
    });
  }
  return out;
}

function safeNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function mean(numbers) {
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function round2(value) {
  return Number(value.toFixed(2));
}

function visibilityScore(mentionRate, top3Rate, avgRank) {
  const rankComponent = avgRank == null ? 0 : Math.max(0, (6 - avgRank) / 5) * 20;
  return round2((mentionRate * 0.5) + (top3Rate * 0.3) + rankComponent);
}

function firstNonEmptyValue(rows, key) {
  for (const row of rows) {
    const value = String(row[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function compactText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isGenericQuery(row, targetBrand, targetWebsite) {
  const intent = String(row["Intent"] || row.intent || "").trim().toLowerCase();
  const query = String(row["Query"] || row.query || "").trim().toLowerCase();
  if (!query) return false;
  if (intent === "branded") return false;

  const aliases = new Set();
  const brand = String(targetBrand || "").trim().toLowerCase();
  if (brand) {
    aliases.add(brand);
    const compact = compactText(brand);
    if (compact) aliases.add(compact);
  }

  const website = String(targetWebsite || "").trim().toLowerCase().replace(/^https?:\/\//, "");
  const host = website.split("/")[0].replace(/^www\./, "");
  if (host) {
    const domainRoot = host.split(".")[0];
    if (domainRoot) aliases.add(domainRoot);
    aliases.add(host);
  }

  for (const alias of aliases) {
    if (!alias) continue;
    if (query.includes(alias)) return false;
  }
  return true;
}

function computeVisibilityMetrics(rows, targetBrand, targetWebsite) {
  const genericRows = rows.filter((row) => {
    const status = String(row.status || "").trim().toLowerCase();
    return status !== "error" && isGenericQuery(row, targetBrand, targetWebsite);
  });

  const byPlatform = new Map();
  for (const row of genericRows) {
    const platform = String(row["Platform"] || row.platform || "").trim() || "Unknown";
    if (!byPlatform.has(platform)) byPlatform.set(platform, []);
    byPlatform.get(platform).push(row);
  }
  byPlatform.set("All Platforms", genericRows.slice());

  const targetLower = String(targetBrand || "").trim().toLowerCase();
  const result = {};

  for (const [platform, platformRows] of byPlatform.entries()) {
    const total = Math.max(platformRows.length, 1);
    const brandData = new Map();
    const getEntry = (brandName) => {
      if (!brandData.has(brandName)) {
        brandData.set(brandName, { appearances: 0, positions: [] });
      }
      return brandData.get(brandName);
    };

    for (const row of platformRows) {
      const mention = String(row["Brand Mentioned"] || "").trim().toUpperCase() === "Y";
      if (mention) {
        const entry = getEntry(targetBrand);
        entry.appearances += 1;
        const pos = safeNumber(row["Brand Position"]);
        if (pos != null) entry.positions.push(pos);
      }

      const top3 = String(row["Top 3 Brands in order"] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      top3.forEach((brand, idx) => {
        const entry = getEntry(brand);
        entry.appearances += 1;
        entry.positions.push(idx + 1);
      });
    }

    const targetEntryRaw = brandData.get(targetBrand) || { appearances: 0, positions: [] };
    const targetAvg = mean(targetEntryRaw.positions);
    const targetTop3Rate = targetEntryRaw.positions.length
      ? round2((targetEntryRaw.positions.filter((pos) => pos <= 3).length / total) * 100)
      : 0;
    const targetMentionRate = round2((targetEntryRaw.appearances / total) * 100);
    const targetEntry = {
      brand: targetBrand,
      mention_rate: targetMentionRate,
      avg_rank: targetAvg == null ? null : round2(targetAvg),
      top3_rate: targetTop3Rate,
      visibility_score: visibilityScore(targetMentionRate, targetTop3Rate, targetAvg),
    };

    const competitors = [];
    for (const [brand, data] of brandData.entries()) {
      if (String(brand || "").trim().toLowerCase() === targetLower) continue;
      const avg = mean(data.positions);
      const mentionRate = round2((data.appearances / total) * 100);
      const top3Rate = data.positions.length
        ? round2((data.positions.filter((pos) => pos <= 3).length / total) * 100)
        : 0;
      competitors.push({
        brand,
        mention_rate: mentionRate,
        avg_rank: avg == null ? null : round2(avg),
        top3_rate: top3Rate,
        visibility_score: visibilityScore(mentionRate, top3Rate, avg),
      });
    }
    competitors.sort((a, b) => (b.visibility_score - a.visibility_score) || String(a.brand).localeCompare(String(b.brand)));
    result[platform] = { top_brands: [targetEntry, ...competitors.slice(0, 4)] };
  }

  return result;
}

function asWebsiteUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  const host = text.replace(/^www\./i, "");
  return `https://www.${host}/`;
}

function buildOverallReportingSheet(rowsBySheet) {
  const sites = Object.entries(rowsBySheet);
  let maxPlatformCount = 1;
  for (const [, rows] of sites) {
    const targetBrand = firstNonEmptyValue(rows, "Target Brand Name");
    const targetWebsite = firstNonEmptyValue(rows, "Target brand website");
    const seen = [];
    for (const row of rows) {
      const status = String(row.status || "").trim().toLowerCase();
      const platform = String(row["Platform"] || row.platform || "").trim();
      if (!platform || status === "error" || seen.includes(platform)) continue;
      if (!isGenericQuery(row, targetBrand, targetWebsite)) continue;
      seen.push(platform);
    }
    maxPlatformCount = Math.max(maxPlatformCount, seen.length || 1);
  }
  const maxRows = 3 + (5 * maxPlatformCount);
  const maxCols = 1 + (sites.length * 7);
  const aoa = Array.from({ length: maxRows }, () => Array.from({ length: maxCols }, () => ""));
  const headers = ["Platform", "Brand", "% Mention Rate", "Avg Rank", "Top 3 Rate", "Visibility Score"];

  sites.forEach(([sheetName, rows], index) => {
    const startCol = 2 + (index * 7);
    const targetBrand = firstNonEmptyValue(rows, "Target Brand Name") || sheetName;
    const targetWebsite = firstNonEmptyValue(rows, "Target brand website");
    const metrics = computeVisibilityMetrics(rows, targetBrand, targetWebsite);

    const seenPlatforms = [];
    for (const row of rows) {
      const status = String(row.status || "").trim().toLowerCase();
      const platform = String(row["Platform"] || row.platform || "").trim();
      if (!platform || status === "error" || seenPlatforms.includes(platform)) continue;
      if (!isGenericQuery(row, targetBrand, targetWebsite)) continue;
      seenPlatforms.push(platform);
    }
    const platforms = seenPlatforms.length ? seenPlatforms : ["All Platforms"];

    aoa[1][startCol - 1] = asWebsiteUrl(targetWebsite);
    headers.forEach((header, idx) => {
      aoa[2][startCol - 1 + idx] = header;
    });

    let rowPtr = 3;
    platforms.forEach((platform) => {
      const brands = (metrics[platform]?.top_brands || []).slice(0, 5);
      while (brands.length < 5) {
        brands.push({ brand: "", mention_rate: "", avg_rank: "", top3_rate: "", visibility_score: "" });
      }
      brands.forEach((item) => {
        aoa[rowPtr][startCol - 1] = platform;
        aoa[rowPtr][startCol] = item.brand ?? "";
        aoa[rowPtr][startCol + 1] = item.mention_rate ?? "";
        aoa[rowPtr][startCol + 2] = item.avg_rank ?? "";
        aoa[rowPtr][startCol + 3] = item.top3_rate ?? "";
        aoa[rowPtr][startCol + 4] = item.visibility_score ?? "";
        rowPtr += 1;
      });
    });
  });

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const cols = [{ wch: 3 }];
  for (let i = 0; i < sites.length; i += 1) {
    cols.push({ wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 3 });
  }
  sheet["!cols"] = cols;
  return sheet;
}

function autoWidthFromRows(rows, headers) {
  const widths = {};
  for (const header of headers) {
    widths[header] = Math.max(
      header.length,
      ...rows.map((row) => String(row[header] ?? "").length)
    );
  }
  return widths;
}

function setColumnWidths(sheet, headers, widths) {
  sheet["!cols"] = headers.map((header) => ({
    wch: Math.min(Math.max(widths[header] + 2, 12), 42),
  }));
}

function buildWorkbook(rowsBySheet) {
  const workbook = XLSX.utils.book_new();
  const overallSheet = buildOverallReportingSheet(rowsBySheet);
  XLSX.utils.book_append_sheet(workbook, overallSheet, "Overall Reporting");

  for (const [sheetName, rows] of Object.entries(rowsBySheet)) {
    const sheet = XLSX.utils.json_to_sheet(rows, { header: OUTPUT_HEADERS });
    setColumnWidths(sheet, OUTPUT_HEADERS, autoWidthFromRows(rows, OUTPUT_HEADERS));
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName.slice(0, 31));
  }

  return workbook;
}

function main() {
  const args = parseArgs(process.argv);
  const mergedRows = mergeRows(args.inputs);
  const workbook = buildWorkbook(mergedRows);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  XLSX.writeFile(workbook, args.output);
  console.log(`Consolidated visibility workbook written to ${args.output}`);
}

main();
