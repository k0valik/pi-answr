/**
 * Schema module - Unified question schema, normalization, and parsing
 *
 * Defines the unified question schema and provides functions to:
 * - Normalize questions from raw input (extraction or tool params)
 * - Parse extraction results from remote LLM
 * - Apply defaults for optional fields
 */

// ============================================================================
// Types
// ============================================================================

export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

export interface UnifiedQuestion {
	id: string;
	type: "radio" | "checkbox" | "text";
	prompt: string;
	label?: string;
	options?: QuestionOption[];
	allowOther?: boolean;
	required?: boolean;
	placeholder?: string;
	default?: string | string[];
}

export interface NormalizedQuestion extends UnifiedQuestion {
	label: string;
	options: QuestionOption[];
	allowOther: boolean;
	required: boolean;
}

export interface Answer {
	id: string;
	type: "radio" | "checkbox" | "text";
	value: string | string[];
	wasCustom: boolean;
}

export interface FormResult {
	title?: string;
	questions: NormalizedQuestion[];
	answers: Answer[];
	cancelled: boolean;
}

// Types for extraction result
interface ExtractedQuestionOption {
	label: string;
	description?: string;
}

export interface ExtractedQuestion {
	id?: string;
	type?: "radio" | "checkbox" | "text";
	header?: string;
	question?: string;
	prompt?: string;
	context?: string;
	options?: ExtractedQuestionOption[];
	allowOther?: boolean;
	required?: boolean;
}

export interface ExtractionResult {
	questions: ExtractedQuestion[];
}

// ============================================================================
// Normalization
// ============================================================================

/**
 * Normalize a single question from raw input to a fully typed NormalizedQuestion
 */
export function normalizeQuestion(q: UnifiedQuestion, index: number): NormalizedQuestion {
	// Use 'prompt' if present, fallback to 'question' for backwards compatibility
	const prompt = q.prompt ?? (q as any).question ?? "";

	// Build options array - use value from extraction if provided, otherwise derive from label
	const options: QuestionOption[] = (q.options ?? []).map((opt) => ({
		value: opt.value ?? opt.label,
		label: opt.label,
		description: opt.description,
	}));

	// Determine allowOther default based on type
	const allowOtherDefault = q.type === "text" ? false : true;

	// Use 'label' if provided, fallback to 'header' for backwards compatibility, then default
	const label = q.label ?? (q as any).header ?? `Q${index + 1}`;

	return {
		id: q.id ?? `question_${index + 1}`,
		type: q.type ?? "text",
		prompt,
		label,
		options,
		allowOther: q.allowOther ?? allowOtherDefault,
		required: q.required ?? true,
		placeholder: q.placeholder,
		default: q.default,
	};
}

/**
 * Normalize an array of questions, filtering out invalid ones
 */
export function normalizeQuestions(questions: UnifiedQuestion[] | unknown): NormalizedQuestion[] {
	if (!Array.isArray(questions)) {
		return [];
	}

	return questions
		.map((q, index) => {
			// Must have a prompt or question field
			const prompt = (q as UnifiedQuestion).prompt ?? (q as any).question;
			if (typeof prompt !== "string" || prompt.trim().length === 0) {
				return null;
			}
			return normalizeQuestion(q as UnifiedQuestion, index);
		})
		.filter((q): q is NormalizedQuestion => q !== null);
}

/**
 * Normalize options from raw extraction format
 */
export function normalizeOptions(raw: unknown): QuestionOption[] {
	if (!Array.isArray(raw)) return [];

	return raw
		.map((option): QuestionOption | null => {
			if (!option || typeof option !== "object") return null;
			const opt = option as { value?: unknown; label?: unknown; description?: unknown };

			// Must have at least a label
			const label = typeof opt.label === "string" ? opt.label.trim() : null;
			if (!label) return null;

			// Use provided value, or derive from label if not provided
			const value = typeof opt.value === "string" ? opt.value.trim() : label.toLowerCase().replace(/\s+/g, "_");

			return {
				value,
				label,
				description: typeof opt.description === "string" ? opt.description.trim() : undefined,
			};
		})
		.filter((opt): opt is QuestionOption => opt !== null);
}

// ============================================================================
// Extraction Result Parsing
// ============================================================================

/**
 * Parse extraction result from remote LLM response
 * Handles JSON wrapped in markdown code blocks
 */
export function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		let jsonStr = text;

		// Extract JSON from markdown code block
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		const parsed = JSON.parse(jsonStr) as { questions?: unknown };

		if (!parsed || !Array.isArray(parsed.questions)) {
			return null;
		}

		// Convert extraction format to unified format
		const questions: ExtractedQuestion[] = [];
		for (const rawQuestion of parsed.questions) {
			if (!rawQuestion || typeof rawQuestion !== "object") continue;

			const q = rawQuestion as {
				id?: unknown;
				type?: unknown;
				header?: unknown;
				question?: unknown;
				prompt?: unknown;
				context?: unknown;
				options?: unknown;
				allowOther?: unknown;
				required?: unknown;
			};

			// Must have question or prompt
			const questionText = typeof q.question === "string" ? q.question.trim()
				: typeof q.prompt === "string" ? q.prompt.trim()
				: "";

			if (questionText.length === 0) continue;

			// Normalize type (defaults to radio if options exist, otherwise text)
			let type: "radio" | "checkbox" | "text" = "text";
			if (typeof q.type === "string" && ["radio", "checkbox", "text"].includes(q.type)) {
				type = q.type;
			} else if (Array.isArray(q.options) && q.options.length > 0) {
				// Infer from options if no explicit type
				// Default to radio, but extraction prompt can specify checkbox
				type = "radio";
			}

			const extractedQuestion: ExtractedQuestion = {
				id: typeof q.id === "string" ? q.id : undefined,
				type,
				header: typeof q.header === "string" ? q.header.trim() : undefined,
				question: questionText,
				context: typeof q.context === "string" ? q.context.trim() : undefined,
				options: normalizeOptions(q.options),
				allowOther: typeof q.allowOther === "boolean" ? q.allowOther : undefined,
				required: typeof q.required === "boolean" ? q.required : undefined,
			};

			// Only add optional fields if they have values
			if (extractedQuestion.context) {
				// Keep context for now - will be merged into prompt
			} else {
				delete extractedQuestion.context;
			}

			questions.push(extractedQuestion);
		}

		return { questions };
	} catch {
		return null;
	}
}

/**
 * Convert extraction format questions to unified question format
 */
export function convertExtractionToUnified(extractionQuestions: ExtractedQuestion[]): UnifiedQuestion[] {
	return extractionQuestions.map((eq, index) => {
		// Merge header and context into the unified schema
		// header -> label
		// context -> prepend to prompt

		let prompt = eq.question ?? "";
		if (eq.context) {
			prompt = eq.context + " " + prompt;
		}

		return {
			id: eq.id ?? `question_${index + 1}`,
			type: eq.type ?? "text",
			prompt,
			label: eq.header,
			options: eq.options?.map((opt) => ({
				value: opt.label.toLowerCase().replace(/\s+/g, "_"),
				label: opt.label,
				description: opt.description,
			})),
			allowOther: eq.allowOther,
			required: eq.required,
		};
	});
}