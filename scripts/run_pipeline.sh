#!/usr/bin/env bash
set -euo pipefail

# End-to-end runner for:
# 1) AI visibility checker
# 2) Shopify storefront/admin audits
# 3) Workbook + action-plan report generation
#
# Usage examples:
#   bash scripts/run_pipeline.sh
#   RUN_VISIBILITY=0 bash scripts/run_pipeline.sh
#   VISIBILITY_REPORT=output/spreadsheet/AI_Brand_Visibility_Report_2026-03-26.xlsx bash scripts/run_pipeline.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

run_py() {
  if [[ -x ".venv/bin/python" ]]; then
    .venv/bin/python "$@"
  else
    python3 "$@"
  fi
}

RUN_VISIBILITY="${RUN_VISIBILITY:-1}"
RUN_STOREFRONT="${RUN_STOREFRONT:-1}"
RUN_ADMIN="${RUN_ADMIN:-1}"
RUN_WORKBOOK="${RUN_WORKBOOK:-1}"
RUN_ACTION_PLAN="${RUN_ACTION_PLAN:-1}"

CONFIG_PATH="${CONFIG_PATH:-configs/audit_config.json}"
DATE_TAG="${DATE_TAG:-$(date +%F)}"

STOREFRONT_JSON="${STOREFRONT_JSON:-output/data/shopify_storefront_audit_${DATE_TAG}.json}"
ADMIN_JSON="${ADMIN_JSON:-output/data/shopify_admin_audit_${DATE_TAG}.json}"
VISIBILITY_REPORT="${VISIBILITY_REPORT:-output/spreadsheet/AI_Brand_Visibility_Report_${DATE_TAG}.xlsx}"
MASTER_TEMPLATE="${MASTER_TEMPLATE:-output/spreadsheet/AI_Analysis_Report_Master_Template_2026-03-30.xlsx}"
MASTER_REPORT_OUT="${MASTER_REPORT_OUT:-output/spreadsheet/AI_Analysis_Report_${DATE_TAG}.xlsx}"
ACTION_PLAN_MD="${ACTION_PLAN_MD:-output/docs/ai_readiness_action_plan_${DATE_TAG}.md}"
ACTION_PLAN_DOCX="${ACTION_PLAN_DOCX:-output/doc/ai_readiness_action_plan_${DATE_TAG}.docx}"
ACTION_PLAN_TEMPLATE_DOCX="${ACTION_PLAN_TEMPLATE_DOCX:-output/doc/ai_readiness_action_plan_2026-03-30.docx}"

mkdir -p output/data output/spreadsheet output/docs output/doc

echo "== Pipeline start =="
echo "Config: $CONFIG_PATH"
echo "Date tag: $DATE_TAG"

if [[ "$RUN_VISIBILITY" == "1" ]]; then
  echo "== Running AI visibility checker =="
  node scripts/generate_brand_visibility_report.mjs \
    --config "$CONFIG_PATH" \
    --output "$VISIBILITY_REPORT"
fi

if [[ "$RUN_STOREFRONT" == "1" ]]; then
  echo "== Running Shopify storefront audit =="
  node scripts/shopify_storefront_audit.js \
    --config "$CONFIG_PATH" \
    --output "$STOREFRONT_JSON"
fi

if [[ "$RUN_ADMIN" == "1" ]]; then
  echo "== Running Shopify admin audit =="
  node scripts/shopify_admin_audit.js \
    --config "$CONFIG_PATH" \
    --output "$ADMIN_JSON" \
    --storefront-audit "$STOREFRONT_JSON"
fi

if [[ "$RUN_WORKBOOK" == "1" ]]; then
  echo "== Generating master workbook report =="
  run_py scripts/generate_master_template_workbook.py \
    --template "$MASTER_TEMPLATE" \
    --visibility-report "$VISIBILITY_REPORT" \
    --audit-json "$STOREFRONT_JSON" \
    --admin-audit-json "$ADMIN_JSON" \
    --config "$CONFIG_PATH" \
    --output "$MASTER_REPORT_OUT"
fi

if [[ "$RUN_ACTION_PLAN" == "1" ]]; then
  echo "== Generating action-plan reports =="
  run_py scripts/generate_ai_readiness_action_plan.py \
    --storefront-audit "$STOREFRONT_JSON" \
    --admin-audit "$ADMIN_JSON" \
    --visibility-report "$VISIBILITY_REPORT" \
    --config "$CONFIG_PATH" \
    --output "$ACTION_PLAN_MD"

  run_py scripts/generate_ai_readiness_action_plan_docx.py \
    --storefront-audit "$STOREFRONT_JSON" \
    --admin-audit "$ADMIN_JSON" \
    --visibility-report "$VISIBILITY_REPORT" \
    --config "$CONFIG_PATH" \
    --template-docx "$ACTION_PLAN_TEMPLATE_DOCX" \
    --output "$ACTION_PLAN_DOCX"
fi

echo "== Pipeline complete =="
echo "Storefront audit: $STOREFRONT_JSON"
echo "Admin audit:      $ADMIN_JSON"
echo "Visibility:       $VISIBILITY_REPORT"
echo "Workbook report:  $MASTER_REPORT_OUT"
echo "Action plan MD:   $ACTION_PLAN_MD"
echo "Action plan DOCX: $ACTION_PLAN_DOCX"
