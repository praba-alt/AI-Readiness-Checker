#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

function parseArgs(argv) {
  const args = {
    base: "",
    retry: "",
    output: "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--base") {
      args.base = next;
      index += 1;
    } else if (current === "--retry") {
      args.retry = next;
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

  if (!args.base || !args.retry || !args.output) {
    printHelp();
    process.exit(1);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/overlay_visibility_retries.mjs --base <provider.xlsx> --retry <retry-results.xlsx> --output <provider.final.xlsx>`);
}

function readWorkbook(filePath) {
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
    String(row.Query || row.query || "").trim().toLowerCase(),
    String(row.Intent || row.intent || "").trim().toLowerCase(),
  ].join("::");
}

function overlayRows(baseRowsBySheet, retryRowsBySheet) {
  const out = {};
  const sheetNames = new Set([...Object.keys(baseRowsBySheet), ...Object.keys(retryRowsBySheet)]);
  for (const sheetName of sheetNames) {
    const baseRows = baseRowsBySheet[sheetName] || [];
    const retryRows = retryRowsBySheet[sheetName] || [];
    const retryMap = new Map(retryRows.map((row) => [rowKey(sheetName, row), row]));
    out[sheetName] = baseRows.map((row) => retryMap.get(rowKey(sheetName, row)) || row);
    for (const row of retryRows) {
      const key = rowKey(sheetName, row);
      if (!out[sheetName].some((item) => rowKey(sheetName, item) === key)) {
        out[sheetName].push(row);
      }
    }
  }
  return out;
}

function writeWorkbook(rowsBySheet, outputPath) {
  const workbook = XLSX.utils.book_new();
  for (const [sheetName, rows] of Object.entries(rowsBySheet)) {
    const sheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName.slice(0, 31));
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  XLSX.writeFile(workbook, outputPath);
}

function main() {
  const args = parseArgs(process.argv);
  const baseRowsBySheet = readWorkbook(args.base);
  const retryRowsBySheet = readWorkbook(args.retry);
  const outRowsBySheet = overlayRows(baseRowsBySheet, retryRowsBySheet);
  writeWorkbook(outRowsBySheet, args.output);
  console.log(`Overlay workbook written to ${args.output}`);
}

main();
