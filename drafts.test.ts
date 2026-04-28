import { describe, it, expect } from "vitest";

// ============================================================================
// Types (copied from drafts.ts for testing)
// ============================================================================

interface QnAResponse {
	selectedOptionIndex: number;
	selectedOptionIndices?: number[];  // NEW: for multi-select checkbox
	customText: string;
	selectionTouched: boolean;
	committed: boolean;
}

interface UnifiedQuestion {
	id: string;
	type: "radio" | "checkbox" | "text";
	prompt: string;
	options?: { label: string; value: string; description?: string }[];
}

interface AnswerDraft {
	sourceEntryId: string;
	updatedAt: number;
	state: "draft" | "cleared";
	answers: string[];
	questions: UnifiedQuestion[];
	responses?: QnAResponse[];
}

// ============================================================================
// Functions (copied from drafts.ts for testing)
// ============================================================================

function getQuestionOptions(question: UnifiedQuestion): { label: string; value: string; description?: string }[] {
	return question.options ?? [];
}

function formatResponseAnswer(question: UnifiedQuestion, response: QnAResponse): string {
	const options = getQuestionOptions(question);
	if (options.length === 0) return response.customText;

	const otherIndex = options.length;
	if (response.selectedOptionIndex === otherIndex) return response.customText;
	if (!response.selectionTouched) return "";

	const option = options[response.selectedOptionIndex];
	return option?.value ?? option?.label ?? "";
}

function normalizeResponses(
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

	let selectedOptionIndex = typeof response?.selectedOptionIndex === "number" && Number.isFinite(response.selectedOptionIndex)
		? Math.trunc(response.selectedOptionIndex)
		: undefined;

	let selectionTouched = response?.selectionTouched ?? false;

	if (options.length === 0) {
		selectedOptionIndex = 0;
		if (response?.selectionTouched === undefined && rawCustomText.trim().length > 0) {
			selectionTouched = true;
		}
	} else if (selectedOptionIndex === undefined) {
		const fallbackTrimmed = rawFallback.trim();
		if (fallbackTrimmed.length === 0) {
			selectedOptionIndex = 0;
			if (response?.selectionTouched === undefined) selectionTouched = false;
		} else {
			const optionIndex = options.findIndex((opt) => {
				const optLabel = opt.label.toLowerCase();
				const optValue = opt.value?.toLowerCase();
				const fallback = fallbackTrimmed.toLowerCase();
				return optLabel === fallback || optValue === fallback;
			});
			selectedOptionIndex = optionIndex >= 0 ? optionIndex : options.length;
			if (response?.selectionTouched === undefined) selectionTouched = true;
		}
	} else if (response?.selectionTouched === undefined) {
		selectionTouched = response?.committed === true;
	}

	const maxIndex = options.length;
	const normalizedIndex = Math.max(0, Math.min(maxIndex, selectedOptionIndex ?? 0));
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
		customText: normalizedCustomText,
		selectionTouched,
		committed,
	};
}

function cloneResponses(responses: QnAResponse[]): QnAResponse[] {
	return responses.map((response) => ({ ...response }));
}

function deriveAnswersFromResponses(questions: UnifiedQuestion[], responses: QnAResponse[]): string[] {
	return questions.map((question, index) => formatResponseAnswer(question, responses[index]));
}

function hasResponseContent(question: UnifiedQuestion, response: QnAResponse): boolean {
	return formatResponseAnswer(question, response).trim().length > 0;
}

function hasAnyDraftContent(questions: UnifiedQuestion[], responses: QnAResponse[]): boolean {
	return responses.some((response, index) => hasResponseContent(questions[index], response));
}

function getLatestDraftForEntry(
	entries: { type: string; customType?: string; data?: AnswerDraft }[],
	sourceEntryId: string,
): AnswerDraft | null {
	let latestDraft: AnswerDraft | null = null;
	let latestTime = 0;

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "answer:draft") {
			const draft = entry.data;
			if (draft?.sourceEntryId === sourceEntryId && draft.updatedAt > latestTime && draft.state === "draft") {
				latestDraft = draft;
				latestTime = draft.updatedAt;
			}
		}
	}

	return latestDraft;
}

// ============================================================================
// Tests
// ============================================================================

describe("normalizeResponses", () => {
	const questions: UnifiedQuestion[] = [
		{ id: "q1", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Option A" }, { value: "b", label: "Option B" }] },
		{ id: "q2", type: "text", prompt: "What's your name?" },
	];

	it("should create default responses when no input", () => {
		const result = normalizeResponses(questions, undefined, undefined, false);
		expect(result).toHaveLength(2);
		expect(result[0].selectedOptionIndex).toBe(0);
		expect(result[0].selectionTouched).toBe(false);
	});

	it("should apply partial responses", () => {
		const input: Partial<QnAResponse>[] = [{ selectedOptionIndex: 1, selectionTouched: true }];
		const result = normalizeResponses(questions, input, undefined, false);
		expect(result[0].selectedOptionIndex).toBe(1);
		expect(result[0].selectionTouched).toBe(true);
	});

	it("should try to match fallback answers to options", () => {
		const result = normalizeResponses(questions, undefined, ["Option A", "John"], false);
		expect(result[0].selectedOptionIndex).toBe(0);
		expect(result[0].selectionTouched).toBe(true);
		expect(result[1].customText).toBe("John");
	});

	it("should clamp invalid indices to valid range", () => {
		const input: Partial<QnAResponse>[] = [{ selectedOptionIndex: 100 }, { customText: "test" }];
		const result = normalizeResponses(questions, input, undefined, false);
		expect(result[0].selectedOptionIndex).toBe(2); // clamped to max
	});
});

describe("deriveAnswersFromResponses", () => {
	const questions: UnifiedQuestion[] = [
		{ id: "q1", type: "radio", prompt: "Pick", options: [{ value: "option_a", label: "Option A" }, { value: "option_b", label: "Option B" }] },
		{ id: "q2", type: "text", prompt: "Name?" },
		{ id: "q3", type: "radio", prompt: "Pick", options: [{ value: "a", label: "A" }] },
	];

	const responses: QnAResponse[] = [
		{ selectedOptionIndex: 0, customText: "", selectionTouched: true, committed: false },
		{ selectedOptionIndex: 0, customText: "John", selectionTouched: true, committed: false },
		{ selectedOptionIndex: 1, customText: "Custom", selectionTouched: true, committed: false },
	];

	it("should return option value for radio", () => {
		const result = deriveAnswersFromResponses(questions, responses);
		expect(result[0]).toBe("option_a");
	});

	it("should return custom text for text type", () => {
		const result = deriveAnswersFromResponses(questions, responses);
		expect(result[1]).toBe("John");
	});

	it("should return custom text when Other is selected", () => {
		const result = deriveAnswersFromResponses(questions, responses);
		expect(result[2]).toBe("Custom");
	});

	it("should return empty string for untouched responses", () => {
		const untouched: QnAResponse[] = [
			{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
			{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
		];
		const result = deriveAnswersFromResponses(questions.slice(0, 2), untouched);
		expect(result[0]).toBe("");
	});
});

describe("hasResponseContent", () => {
	const question: UnifiedQuestion = {
		id: "q1", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }]
	};

	it("should return true when option selected", () => {
		const response: QnAResponse = { selectedOptionIndex: 0, customText: "", selectionTouched: true, committed: false };
		expect(hasResponseContent(question, response)).toBe(true);
	});

	it("should return true when custom text entered", () => {
		const response: QnAResponse = { selectedOptionIndex: 2, customText: "Custom", selectionTouched: true, committed: false };
		expect(hasResponseContent(question, response)).toBe(true);
	});

	it("should return false when nothing selected", () => {
		const response: QnAResponse = { selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false };
		expect(hasResponseContent(question, response)).toBe(false);
	});
});

describe("hasAnyDraftContent", () => {
	const questions: UnifiedQuestion[] = [
		{ id: "q1", type: "text", prompt: "Q1" },
		{ id: "q2", type: "text", prompt: "Q2" },
	];

	it("should return true if any response has content", () => {
		const responses: QnAResponse[] = [
			{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
			{ selectedOptionIndex: 0, customText: "Has content", selectionTouched: true, committed: false },
		];
		expect(hasAnyDraftContent(questions, responses)).toBe(true);
	});

	it("should return false if no responses have content", () => {
		const responses: QnAResponse[] = [
			{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
			{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
		];
		expect(hasAnyDraftContent(questions, responses)).toBe(false);
	});
});

describe("cloneResponses", () => {
	it("should deep clone responses", () => {
		const original: QnAResponse[] = [{ selectedOptionIndex: 1, customText: "test", selectionTouched: true, committed: false }];
		const cloned = cloneResponses(original);
		expect(cloned).toEqual(original);
		expect(cloned).not.toBe(original);
		cloned[0].customText = "modified";
		expect(original[0].customText).toBe("test");
	});
});

describe("getLatestDraftForEntry", () => {
	const entries = [
		{ type: "custom", customType: "answer:draft", data: { sourceEntryId: "id1", updatedAt: 1000, state: "draft", answers: [], questions: [] } },
		{ type: "custom", customType: "answer:draft", data: { sourceEntryId: "id1", updatedAt: 2000, state: "draft", answers: [], questions: [] } },
		{ type: "custom", customType: "answer:draft", data: { sourceEntryId: "id2", updatedAt: 3000, state: "draft", answers: [], questions: [] } },
		{ type: "custom", customType: "answer:draft", data: { sourceEntryId: "id1", updatedAt: 1500, state: "cleared", answers: [], questions: [] } },
	] as any;

	it("should find latest draft for matching source entry", () => {
		const result = getLatestDraftForEntry(entries, "id1");
		expect(result?.sourceEntryId).toBe("id1");
		expect(result?.updatedAt).toBe(2000);
	});

	it("should return null for non-matching source entry", () => {
		const result = getLatestDraftForEntry(entries, "nonexistent");
		expect(result).toBeNull();
	});

	it("should ignore cleared state", () => {
		const result = getLatestDraftForEntry(entries, "id1");
		expect(result?.state).toBe("draft");
	});
});