# AI Readiness Checker

Pipeline to run:
- AI brand visibility checks
- Shopify storefront audit
- Shopify admin audit
- Master workbook generation
- AI readiness action-plan generation (Markdown + DOCX)

## 1) Setup

1. Install dependencies:
```bash
npm install
```

2. Create env file:
```bash
cp .env.example .env
```

3. Fill required keys in `.env`:
- visibility provider keys (`OPENAI_API_KEY` and/or `OPENROUTER_API_KEY`, etc.)
- Shopify admin credentials per store (`SHOPIFY_ADMIN_DOMAIN_*`, `SHOPIFY_ADMIN_TOKEN_*`)

4. Optional Python venv (recommended for report scripts):
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install openpyxl python-docx
```

## 2) Main Commands

### Full pipeline (recommended)
```bash
npm run run:pipeline
```

### Individual steps
```bash
npm run generate:visibility
npm run audit:storefront
npm run audit:admin
npm run report:workbook
npm run report:action-plan-md
npm run report:action-plan-docx
```

## 2.1) Manual Brand Visibility Commands (Per Tab / Per AI Model)

For the workbook `AI_Analysis_Input_Master_Template_28052026.xlsx`, use:

- [docs/brand-visibility-manual-commands.md](docs/brand-visibility-manual-commands.md)

## 2.2) 5-Website Visibility Runbook (Run + Status + Merge)

Use this section to run each website one-by-one, monitor progress, and merge all outputs into one master visibility workbook.

### Common Variables
```bash
SOURCE="/Users/macbook/AI Experiments/AI-Readiness-Checker/AI_Analysis_Input_Master_Template_28052026.xlsx"
```

### Run 1: Trailberg UK (`trailberg.com`)
```bash
CKPT="output/trailberg_uk_multisheet_checkpoint.json"
npx ai-brand-visibility-checker-multisheet \
  --input "$SOURCE" \
  --sheets "Trailberg UK_Visibility Tracker" \
  --providers "openai_or,gemini,claude,perplexity" \
  --openrouter-openai-model "openai/gpt-4.1-mini" \
  --openrouter-gemini-model "google/gemini-2.5-flash-lite" \
  --openrouter-claude-model "anthropic/claude-3.5-haiku" \
  --openrouter-perplexity-model "perplexity/sonar" \
  --checkpoint-json "$CKPT" \
  --checkpoint-save-every 1 \
  --output-xlsx "output/spreadsheet/trailberg_uk_all_models.xlsx" \
  --no-resume
```

### Run 2: Trailberg IE
```bash
CKPT="output/trailberg_ie_multisheet_checkpoint.json"
npx ai-brand-visibility-checker-multisheet \
  --input "$SOURCE" \
  --sheets "Trailberg IE_Visibility Tracker" \
  --providers "openai_or,gemini,claude,perplexity" \
  --openrouter-openai-model "openai/gpt-4.1-mini" \
  --openrouter-gemini-model "google/gemini-2.5-flash-lite" \
  --openrouter-claude-model "anthropic/claude-3.5-haiku" \
  --openrouter-perplexity-model "perplexity/sonar" \
  --checkpoint-json "$CKPT" \
  --checkpoint-save-every 1 \
  --output-xlsx "output/spreadsheet/trailberg_ie_all_models.xlsx" \
  --no-resume
```

### Run 3: Lorenzo
```bash
CKPT="output/lorenzo_multisheet_checkpoint.json"
npx ai-brand-visibility-checker-multisheet \
  --input "$SOURCE" \
  --sheets "Lorenzo_Visibility Tracker" \
  --providers "openai_or,gemini,claude,perplexity" \
  --openrouter-openai-model "openai/gpt-4.1-mini" \
  --openrouter-gemini-model "google/gemini-2.5-flash-lite" \
  --openrouter-claude-model "anthropic/claude-3.5-haiku" \
  --openrouter-perplexity-model "perplexity/sonar" \
  --checkpoint-json "$CKPT" \
  --checkpoint-save-every 1 \
  --output-xlsx "output/spreadsheet/lorenzo_all_models.xlsx" \
  --no-resume
```

### Run 4: Dream Is Free
```bash
CKPT="output/dreamisfree_multisheet_checkpoint.json"
npx ai-brand-visibility-checker-multisheet \
  --input "$SOURCE" \
  --sheets "Dream Is Free_Visibility Tracke" \
  --providers "openai_or,gemini,claude,perplexity" \
  --openrouter-openai-model "openai/gpt-4.1-mini" \
  --openrouter-gemini-model "google/gemini-2.5-flash-lite" \
  --openrouter-claude-model "anthropic/claude-3.5-haiku" \
  --openrouter-perplexity-model "perplexity/sonar" \
  --checkpoint-json "$CKPT" \
  --checkpoint-save-every 1 \
  --output-xlsx "output/spreadsheet/dreamisfree_all_models.xlsx" \
  --no-resume
```

### Run 5: Aari
```bash
CKPT="output/aari_multisheet_checkpoint.json"
npx ai-brand-visibility-checker-multisheet \
  --input "$SOURCE" \
  --sheets "Aari_Visibility Tracker" \
  --providers "openai_or,gemini,claude,perplexity" \
  --openrouter-openai-model "openai/gpt-4.1-mini" \
  --openrouter-gemini-model "google/gemini-2.5-flash-lite" \
  --openrouter-claude-model "anthropic/claude-3.5-haiku" \
  --openrouter-perplexity-model "perplexity/sonar" \
  --checkpoint-json "$CKPT" \
  --checkpoint-save-every 1 \
  --output-xlsx "output/spreadsheet/aari_all_models.xlsx" \
  --no-resume
```

### Status Check (Reusable for Any Website)

Set `CKPT` and `SHEET`, then run:
```bash
CKPT="output/trailberg_uk_multisheet_checkpoint.json"
SHEET="Trailberg UK_Visibility Tracker"

while true; do
  clear
  date
  node - <<'NODE' "$CKPT" "$SHEET" "$SOURCE"
const fs = require("fs");
const XLSX = require("xlsx");
const [ckpt, sheet, source] = process.argv.slice(2);

let total = 0;
if (fs.existsSync(source)) {
  const wb = XLSX.readFile(source);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: "" });
  total = rows.filter(r => String(r.Query || r.query || "").trim()).length * 4;
}

if (!fs.existsSync(ckpt)) {
  console.log("Checkpoint not created yet.");
  console.log(`Estimated total items: ${total}`);
  process.exit(0);
}

const c = JSON.parse(fs.readFileSync(ckpt, "utf8"));
const done = (((c.sheets || {})[sheet] || {}).done_keys || []).length;
const pct = total ? ((done / total) * 100).toFixed(1) : "0.0";

console.log("Sheet:", sheet);
console.log("Done:", done, "/", total, `(${pct}%)`);
console.log("Last checkpoint update:", c.updated_at || "n/a");
NODE
  sleep 5
done
```

### Final Merge (All 5 Outputs into One Workbook)

Creates one workbook with `Overall Reporting` as the first sheet, then applies template formatting to match the master report style.

```bash
node scripts/build_consolidated_visibility_report.mjs \
  --input output/spreadsheet/trailberg_uk_all_models_YYYY-MM-DD.xlsx \
  --input output/spreadsheet/trailberg_ie_all_models_YYYY-MM-DD.xlsx \
  --input output/spreadsheet/lorenzo_all_models_YYYY-MM-DD.xlsx \
  --input output/spreadsheet/dreamisfree_all_models_YYYY-MM-DD.xlsx \
  --input output/spreadsheet/aari_all_models_YYYY-MM-DD.xlsx \
  --output output/spreadsheet/AI_Brand_Visibility_Master_5_Sites_YYYY-MM-DD.xlsx

.venv/bin/python scripts/format_visibility_overall_sheet.py \
  --workbook output/spreadsheet/AI_Brand_Visibility_Master_5_Sites_YYYY-MM-DD.xlsx \
  --template output/spreadsheet/AI_Analysis_Report_Master_Template_2026-03-30.xlsx
```

### Optional: Validate Completion Before Merge

```bash
node - <<'NODE'
const fs=require('fs');
const checkpoints=[
  'output/trailberg_uk_multisheet_checkpoint.json',
  'output/trailberg_ie_multisheet_checkpoint.json',
  'output/lorenzo_multisheet_checkpoint.json',
  'output/dreamisfree_multisheet_checkpoint.json',
  'output/aari_multisheet_checkpoint.json'
];
for (const p of checkpoints) {
  if (!fs.existsSync(p)) { console.log(`${p} :: missing`); continue; }
  const c=JSON.parse(fs.readFileSync(p,'utf8'));
  const parts=Object.entries(c.sheets||{}).map(([k,v])=>`${k}=${(v?.done_keys||[]).length}`).join(', ');
  console.log(`${p} :: updated=${c.updated_at||'n/a'} :: ${parts}`);
}
NODE
```

## 3) Pipeline Script

`scripts/run_pipeline.sh` orchestrates end-to-end execution.

Supported env overrides:
- `RUN_VISIBILITY` (`1|0`)
- `RUN_STOREFRONT` (`1|0`)
- `RUN_ADMIN` (`1|0`)
- `RUN_WORKBOOK` (`1|0`)
- `RUN_ACTION_PLAN` (`1|0`)
- `CONFIG_PATH`
- `DATE_TAG`
- `VISIBILITY_REPORT`
- `STOREFRONT_JSON`
- `ADMIN_JSON`
- `MASTER_TEMPLATE`
- `MASTER_REPORT_OUT`
- `ACTION_PLAN_MD`
- `ACTION_PLAN_DOCX`
- `ACTION_PLAN_TEMPLATE_DOCX`

Example:
```bash
RUN_VISIBILITY=0 DATE_TAG=2026-05-05 bash scripts/run_pipeline.sh
```

## 4) Repo Notes

- Generated artifacts are ignored via `.gitignore` (notably `output/`, `tmp/`, `.venv/`, `node_modules/`).
- Primary runtime config is `configs/audit_config.json`.
- Existing scripts are under `scripts/`.
