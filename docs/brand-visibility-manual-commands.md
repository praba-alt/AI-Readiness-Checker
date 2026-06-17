# Brand Visibility Manual Commands

This guide contains ready-to-run commands for the source workbook:

`/Users/macbook/AI Experiments/AI-Readiness-Checker/AI_Analysis_Input_Master_Template_28052026.xlsx`

## Source Workbook

```bash
SOURCE="/Users/macbook/AI Experiments/AI-Readiness-Checker/AI_Analysis_Input_Master_Template_28052026.xlsx"
```

## Run Per Website Tab

```bash
npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Trailberg UK_Visibility Tracker" --providers openai_or --output-xlsx "output/spreadsheet/visibility_trailberg_uk_openai_or_$(date +%F).xlsx" --no-resume

npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Trailberg IE_Visibility Tracker" --providers openai_or --output-xlsx "output/spreadsheet/visibility_trailberg_ie_openai_or_$(date +%F).xlsx" --no-resume

npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Lorenzo_Visibility Tracker" --providers openai_or --output-xlsx "output/spreadsheet/visibility_lorenzo_openai_or_$(date +%F).xlsx" --no-resume

npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Dream Is Free_Visibility Tracke" --providers openai_or --output-xlsx "output/spreadsheet/visibility_dreamisfree_openai_or_$(date +%F).xlsx" --no-resume

npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Aari_Visibility Tracker" --providers openai_or --output-xlsx "output/spreadsheet/visibility_aari_openai_or_$(date +%F).xlsx" --no-resume
```

## Run Per AI Provider/Model (Example: Aari Tab)

```bash
# OpenAI-family via OpenRouter
npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Aari_Visibility Tracker" --providers openai_or --openrouter-openai-model "openai/gpt-4.1-mini" --output-xlsx "output/spreadsheet/aari_openai_or_$(date +%F).xlsx" --no-resume

# Claude via OpenRouter
npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Aari_Visibility Tracker" --providers claude --openrouter-claude-model "anthropic/claude-3.5-haiku" --output-xlsx "output/spreadsheet/aari_claude_$(date +%F).xlsx" --no-resume

# Gemini via OpenRouter
npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Aari_Visibility Tracker" --providers gemini --openrouter-gemini-model "google/gemini-2.5-flash-lite" --output-xlsx "output/spreadsheet/aari_gemini_$(date +%F).xlsx" --no-resume

# Sonar via OpenRouter
npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Aari_Visibility Tracker" --providers sonar --openrouter-sonar-model "perplexity/sonar" --output-xlsx "output/spreadsheet/aari_sonar_$(date +%F).xlsx" --no-resume

# Perplexity via OpenRouter
npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Aari_Visibility Tracker" --providers perplexity --openrouter-perplexity-model "perplexity/sonar" --output-xlsx "output/spreadsheet/aari_perplexity_$(date +%F).xlsx" --no-resume

# Direct Claude API
npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Aari_Visibility Tracker" --providers claude_api --claude-api-model "claude-haiku-4-5-20251001" --output-xlsx "output/spreadsheet/aari_claude_api_$(date +%F).xlsx" --no-resume
```

## Quick Validation Run

Use this for a smaller test pass before a full run:

```bash
npx ai-brand-visibility-checker-multisheet --input "$SOURCE" --sheets "Aari_Visibility Tracker" --providers openai_or --openrouter-openai-model "openai/gpt-4.1-mini" --output-xlsx "output/spreadsheet/test_aari_openai_or_$(date +%F).xlsx" --no-resume
```

## Optional: Run All Tabs for One Provider

```bash
for s in \
  "Trailberg UK_Visibility Tracker" \
  "Trailberg IE_Visibility Tracker" \
  "Lorenzo_Visibility Tracker" \
  "Dream Is Free_Visibility Tracke" \
  "Aari_Visibility Tracker"
do
  slug=$(echo "$s" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g')
  npx ai-brand-visibility-checker-multisheet \
    --input "$SOURCE" \
    --sheets "$s" \
    --providers openai_or \
    --output-xlsx "output/spreadsheet/${slug}_openai_or_$(date +%F).xlsx" \
    --no-resume
done
```
