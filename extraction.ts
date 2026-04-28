/**
 * Extraction module - Remote LLM question extraction
 *
 * Handles:
 * - System prompt for extraction
 * - Model selection from preferences
 * - Extraction timeout handling
 * - Result parsing (via schema.ts)
 */

import type { Model, Api } from "@mariozechner/pi-ai";
import { parseExtractionResult, normalizeQuestions, UnifiedQuestion } from "./schema";

export interface ModelPreference {
	provider: string;
	id: string;
}

export interface ExtractionSettings {
	extractionModels?: ModelPreference[];
	extractionTimeoutMs?: number;
}

// ============================================================================
// System Prompt
// ============================================================================

export const DEFAULT_SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "id": "preferred_database",
      "type": "radio",
      "header": "Database",
      "question": "What is your preferred database?",
      "context": "Optional context that helps answer the question",
      "options": [
        {
          "label": "PostgreSQL",
          "description": "Mature relational option with strong ecosystem"
        }
      ],
      "allowOther": true,
      "required": true
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Keep id values stable snake_case when possible
- Use type "radio" for single-select, "checkbox" for multi-select, "text" for open-ended
- Keep header concise when provided; omit if the question alone is clear
- Include context only when it provides essential information for answering
- Include options only when the text clearly suggests concrete choices
- Each option needs a short label and one-sentence description
- Option labels should fully represent the answer to the question on their own
- Set allowOther to true unless the options are truly exhaustive
- Set required to true unless the question is clearly optional
- If no questions are found, return {"questions": []}`;

export const DEFAULT_MODEL_PREFERENCES: ModelPreference[] = [
	{ provider: "openai-codex", id: "gpt-5.4-mini" },
	{ provider: "github-copilot", id: "gpt-5.4-mini" },
	{ provider: "anthropic", id: "claude-haiku-4-5" },
];

export const DEFAULT_EXTRACTION_TIMEOUT_MS = 30000;

// ============================================================================
// Model Selection
// ============================================================================

/**
 * Select the best available extraction model from preferences
 * Tries each model in order until one with a valid API key is found
 */
export async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: {
		find: (provider: string, modelId: string) => Model<Api> | undefined;
		getApiKeyAndHeaders: (model: Model<Api>) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
	},
	modelPreferences: ModelPreference[],
): Promise<Model<Api>> {
	for (const preference of modelPreferences) {
		const model = modelRegistry.find(preference.provider, preference.id);
		if (!model) continue;

		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) return model;
	}

	// Fallback to current model if none of the preferences work
	return currentModel;
}

// ============================================================================
// Extraction Settings
// ============================================================================

export interface AnswerDraftSettings {
	enabled?: boolean;
	autosaveMs?: number;
	promptOnRestore?: boolean;
}

export const DEFAULT_DRAFT_SETTINGS: Required<AnswerDraftSettings> = {
	enabled: true,
	autosaveMs: 1000,
	promptOnRestore: true,
};