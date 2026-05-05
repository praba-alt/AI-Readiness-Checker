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
