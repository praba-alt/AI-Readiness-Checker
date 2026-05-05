#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

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
  console.log(`Usage: node scripts/merge_brand_visibility_reports.mjs --input <file> [--input <file> ...] --output <file>`);
}

function readWorkbookRows(filePath) {
  const workbook = XLSX.readFile(filePath);
  const rowsBySheet = {};
  for (const sheetName of workbook.SheetNames) {
    rowsBySheet[sheetName] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
  }
  return rowsBySheet;
}

function mergeRows(inputs) {
  const merged = {};
  for (const input of inputs) {
    const rowsBySheet = readWorkbookRows(input);
    for (const [sheetName, rows] of Object.entries(rowsBySheet)) {
      if (!merged[sheetName]) {
        merged[sheetName] = [];
      }
      merged[sheetName].push(...rows);
    }
  }
  return merged;
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
  const merged = mergeRows(args.inputs);
  writeWorkbook(merged, args.output);
  console.log(`Merged visibility workbook written to ${args.output}`);
}

main();
