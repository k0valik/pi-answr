/**
 * Drafts module - Draft autosave and /answer:again logic
 *
 * Handles:
 * - Draft persistence with auto-save
 * - /answer:again to restore previous questionnaire
 * - Version 2 draft format
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { NormalizedQuestion, UnifiedQuestion } from "./schema";

// ============================================================================
// Types
// ============================================================================

export interface DraftResponse {
	selectedOptionIndex: number;
	customText: string;
	selectionTouched?: boolean;
	committed?: boolean;
}

export interface DraftOptionAnswer {
	value: string;
	label: string;
	wasCustom: boolean;
}

export interface DraftAnswer {
	id: string;
	type: "radio" | "checkbox" | "text";
	value: string | string[];
	wasCustom: boolean;
}

export interface AnswerDraft {
	version: number;
	sourceEntryId: string;
	questions: UnifiedQuestion[];
	answers: string[];
	responses?: DraftResponse[];
	updatedAt: number;
	state: "draft" | "cleared";
}

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

// ============================================================================
// State Types (for TUI responses)
// ============================================================================

export interface QnAResponse {
	selectedOptionIndex: number;
	selectedOptionIndices?: number[];  // NEW: for multi-select checkbox persistence
	customText: string;
	selectionTouched: boolean;
	committed: boolean;
}

// ============================================================================
// Draft Store
// ============================================================================

const DRAFT_ENTRY_TYPE = "answer:draft";

/**
 * Create a draft store for auto-saving questionnaire responses
 */
export function createDraftStore(
	pi: ExtensionAPI,
	base: { sourceEntryId: string; questions: UnifiedQuestion[] },
	settings: Required<AnswerDraftSettings>,
) {
	if (!settings.enabled) {
		return {
			seed: (_responses: QnAResponse[]) => {},
			schedule: (_responses: QnAResponse[]) => {},
			flush: () => {},
			clear: () => {},
		};
	}

	let lastResponses: QnAResponse[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastSignature = "";

	const appendDraft = (responses: QnAResponse[], state: AnswerDraft["state"], force: boolean = false) => {
		const signature = `${state}:${JSON.stringify(responses)}`;
		if (!force && signature === lastSignature) return;

		lastSignature = signature;

		const answers = deriveAnswersFromResponses(base.questions, responses);
		const payload: AnswerDraft = {
			version: 2,
			sourceEntryId: base.sourceEntryId,
			questions: base.questions,
			answers: state === "cleared" ? [] : answers,
			responses:
				state === "cleared"
					? []
					: responses.map((response) => ({
							selectedOptionIndex: response.selectedOptionIndex,
							customText: response.customText,
							selectionTouched: response.selectionTouched,
							committed: response.committed,
						})),
			updatedAt: Date.now(),
			state,
		};

		pi.appendEntry(DRAFT_ENTRY_TYPE, payload);
	};

	const schedule = (responses: QnAResponse[]) => {
		lastResponses = [...responses];
		if (settings.autosaveMs <= 0) {
			appendDraft(lastResponses, "draft");
			return;
		}
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => appendDraft(lastResponses, "draft"), settings.autosaveMs);
	};

	const flush = () => {
		if (timer) clearTimeout(timer);
		appendDraft(lastResponses, "draft");
	};

	const clear = () => {
		if (timer) clearTimeout(timer);
		appendDraft([], "cleared", true);
	};

	const seed = (responses: QnAResponse[]) => {
		lastResponses = [...responses];
	};

	return { seed, schedule, flush, clear };
}

// ============================================================================
// Response Normalization
// ============================================================================

function getQuestionOptions(question: UnifiedQuestion): { label: string; description?: string }[] {
	return question.options ?? [];
}

function formatResponseAnswer(question: UnifiedQuestion, response: QnAResponse): string {
	const options = getQuestionOptions(question);

	// Text input or no options
	if (options.length === 0) {
		return response.customText;
	}

	// Check if "Other" is selected (index == options.length)
	const otherIndex = options.length;
	if (response.selectedOptionIndex === otherIndex) {
		return response.customText;
	}

	// No selection made yet
	if (!response.selectionTouched) {
		return "";
	}

	// Return the option's value (not label!)
	const option = options[response.selectedOptionIndex];
	return option?.value ?? option?.label ?? "";
}

/**
 * Normalize responses array, applying defaults and handling missing data
 */
export function normalizeResponses(
	questions: UnifiedQuestion[],
	responses: Array<Partial<QnAResponse>> | undefined,
	fallbackAnswers: string[] | undefined,
	inferCommittedFromContent: boolean,
): QnAResponse[] {
	return questions.map((question, index) =>
		normalizeResponseForQuestion(
			question,
			responses?.[index],
			fallbackAnswers?.[index],
			inferCommittedFromContent,
		),
	);
}

function normalizeResponseForQuestion(
	question: UnifiedQuestion,
	response: Partial<QnAResponse> | undefined,
	fallbackAnswer: string | undefined,
	inferCommittedFromContent: boolean,
): QnAResponse {
	const options = getQuestionOptions(question);
	const rawFallback = fallbackAnswer ?? "";
	const rawCustomText = response?.customText ?? rawFallback;

	let selectedOptionIndex =
		typeof response?.selectedOptionIndex === "number" && Number.isFinite(response.selectedOptionIndex)
			? Math.trunc(response.selectedOptionIndex)
			: undefined;

	let selectionTouched = response?.selectionTouched ?? false;

	// Text input or no options - no selection to make
	if (options.length === 0) {
		selectedOptionIndex = 0;
		if (response?.selectionTouched === undefined && rawCustomText.trim().length > 0) {
			selectionTouched = true;
		}
	} else if (selectedOptionIndex === undefined) {
		// Try to match fallback answer to an option
		const fallbackTrimmed = rawFallback.trim();
		if (fallbackTrimmed.length === 0) {
			selectedOptionIndex = 0;
			if (response?.selectionTouched === undefined) {
				selectionTouched = false;
			}
		} else {
			// Look for matching option by value or label
			const optionIndex = options.findIndex((opt) => {
				const optLabel = opt.label.toLowerCase();
				const optValue = opt.value?.toLowerCase();
				const fallback = fallbackTrimmed.toLowerCase();
				return optLabel === fallback || optValue === fallback;
			});
			selectedOptionIndex = optionIndex >= 0 ? optionIndex : options.length;
			if (response?.selectionTouched === undefined) {
				selectionTouched = true;
			}
		}
	} else if (response?.selectionTouched === undefined) {
		selectionTouched = response?.committed === true;
	}

	const maxIndex = options.length;
	const normalizedIndex = Math.max(0, Math.min(maxIndex, selectedOptionIndex ?? 0));

	// Handle selectedOptionIndices for multi-select checkboxes (NEW)
	let normalizedIndices: number[] | undefined;
	if (response?.selectedOptionIndices && Array.isArray(response.selectedOptionIndices)) {
		normalizedIndices = response.selectedOptionIndices
			.filter((i): i is number => typeof i === "number" && Number.isFinite(i))
			.map((i) => Math.max(0, Math.min(maxIndex, i)))
			.filter((i) => i < maxIndex);  // Only valid option indices
	}

	// Custom text only if Other is selected or no options
	const useCustomText = options.length === 0 || normalizedIndex === options.length;
	const normalizedCustomText = useCustomText ? rawCustomText : "";

	let committed = response?.committed ?? false;
	if (response?.committed === undefined && inferCommittedFromContent) {
		committed = formatResponseAnswer(question, {
			selectedOptionIndex: normalizedIndex,
			customText: normalizedCustomText,
			selectionTouched,
			committed: false,
		}).trim().length > 0;
	}

	return {
		selectedOptionIndex: normalizedIndex,
		selectedOptionIndices: normalizedIndices,  // NEW: for multi-select checkboxes
		customText: normalizedCustomText,
		selectionTouched,
		committed,
	};
}

// ============================================================================
// Answer Derivation
// ============================================================================

/**
 * Clone responses array (deep copy)
 */
export function cloneResponses(responses: QnAResponse[]): QnAResponse[] {
	return responses.map((response) => ({ ...response }));
}

/**
 * Derive answer strings from responses
 * Returns array of answers in order matching questions
 */
export function deriveAnswersFromResponses(questions: UnifiedQuestion[], responses: QnAResponse[]): string[] {
	return questions.map((question, index) => formatResponseAnswer(question, responses[index]));
}

// ============================================================================
// Content Detection
// ============================================================================

/**
 * Check if a response has any content (answer filled in)
 */
export function hasResponseContent(question: UnifiedQuestion, response: QnAResponse): boolean {
	return formatResponseAnswer(question, response).trim().length > 0;
}

/**
 * Check if ANY response in the array has content
 */
export function hasAnyDraftContent(questions: UnifiedQuestion[], responses: QnAResponse[]): boolean {
	return responses.some((response, index) => hasResponseContent(questions[index], response));
}

// ============================================================================
// Draft Retrieval (for /answer:again)
// ============================================================================

/**
 * Find the latest draft for a given source entry ID
 */
export function getLatestDraftForEntry(
	entries: { type: string; customType?: string; data?: AnswerDraft }[],
	sourceEntryId: string,
): AnswerDraft | null {
	let latestDraft: AnswerDraft | null = null;
	let latestTime = 0;

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === DRAFT_ENTRY_TYPE) {
			const draft = entry.data as AnswerDraft;
			if (draft?.sourceEntryId === sourceEntryId && draft.updatedAt > latestTime && draft.state === "draft") {
				latestDraft = draft;
				latestTime = draft.updatedAt;
			}
		}
	}

	return latestDraft;
}

/**
 * Get initial responses from draft or fresh start
 */
export function getInitialResponses(
	questions: UnifiedQuestion[],
	draft: AnswerDraft | null,
): QnAResponse[] {
	if (!draft) {
		return normalizeResponses(questions, undefined, undefined, false);
	}

	return normalizeResponses(
		questions,
		draft.responses as QnAResponse[] | undefined,
		draft.answers,
		true,
	);
}