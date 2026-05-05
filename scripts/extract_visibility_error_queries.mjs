#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const OUTPUT_HEADERS = [
  "Query",
  "Intent",
  "Target Brand Name",
  "Target brand website",
  "Notes",
];

function parseArgs(argv) {
  const args = {
    input: "",
    output: "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--input") {
      args.input = next;
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

  if (!args.input || !args.output) {
    printHelp();
    process.exit(1);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/extract_visibility_error_queries.mjs --input <provider-report.xlsx> --output <retry-queries.xlsx>`);
}

function buildRetryRows(rows) {
  const seen = new Set();
  const retryRows = [];
  for (const row of rows) {
    if (String(row.status || "").toLowerCase() !== "error") {
      continue;
    }
    const query = String(row.Query || row.query || "").trim();
    const intent = String(row.Intent || row.intent || "").trim();
    const key = `${query.toLowerCase()}::${intent.toLowerCase()}`;
    if (!query || seen.has(key)) {
      continue;
    }
    seen.add(key);
    retryRows.push({
      Query: query,
      Intent: intent,
      "Target Brand Name": String(row["Target Brand Name"] || row.target_brand || "").trim(),
      "Target brand website": String(row["Target brand website"] || row.target_domain || "").trim(),
      Notes: String(row.Notes || row.notes || "").trim(),
    });
  }
  return retryRows;
}

function main() {
  const args = parseArgs(process.argv);
  const workbook = XLSX.readFile(args.input);
  const outWorkbook = XLSX.utils.book_new();

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
    const retryRows = buildRetryRows(rows);
    if (!retryRows.length) {
      continue;
    }
    const sheet = XLSX.utils.json_to_sheet(retryRows, { header: OUTPUT_HEADERS });
    XLSX.utils.book_append_sheet(outWorkbook, sheet, sheetName.slice(0, 31));
  }

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  XLSX.writeFile(outWorkbook, args.output);
  console.log(`Retry-query workbook written to ${args.output}`);
}

main();
