/**
 * Tests for TUI checkbox initialization logic
 * These are unit tests for the key logic fixes applied to tui.ts
 */

import { describe, it, expect } from "vitest";

// ============================================================================
// Types (matching tui.ts)
// ============================================================================

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface NormalizedQuestion {
	id: string;
	type: "radio" | "checkbox" | "text";
	prompt: string;
	label?: string;
	options: QuestionOption[];
	allowOther?: boolean;
	required?: boolean;
	placeholder?: string;
	default?: string | string[];
}

interface QnAResponse {
	selectedOptionIndex: number;
	selectedOptionIndices?: number[];  // NEW
	customText: string;
	selectionTouched: boolean;
	committed: boolean;
}

interface FormAnswer {
	id: string;
	type: "radio" | "checkbox" | "text";
	value: string | string[];
	wasCustom: boolean;
}

// ============================================================================
// Pure functions copied from tui.ts initialization logic
// ============================================================================

function initializeAnswerStores(
	questions: NormalizedQuestion[],
	responses: QnAResponse[],
): {
	radioAnswers: Map<string, FormAnswer>;
	checkAnswers: Map<string, Set<string>>;
	checkCustom: Map<string, string>;
	textAnswers: Map<string, string>;
} {
	const radioAnswers = new Map<string, FormAnswer>();
	const checkAnswers = new Map<string, Set<string>>();
	const checkCustom = new Map<string, string>();
	const textAnswers = new Map<string, string>();

	// First pass: initialize from q.default
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const r = responses[i];

		if (q.type === "text" && typeof q.default === "string") {
			textAnswers.set(q.id, q.default);
		}
		if (q.type === "radio" && typeof q.default === "string") {
			const opt = q.options.find((o) => o.value === q.default);
			if (opt) {
				radioAnswers.set(q.id, { id: q.id, type: "radio", value: opt.value, wasCustom: false });
			}
		}
		if (q.type === "checkbox") {
			const defaults = new Set<string>();
			if (Array.isArray(q.default)) {
				for (const v of q.default) defaults.add(v);
			} else if (typeof q.default === "string") {
				defaults.add(q.default);
			}
			checkAnswers.set(q.id, defaults);
			if (r.customText && r.customText.trim()) {
				checkCustom.set(q.id, r.customText);
			}
		}
	}

	// Second pass: restore from draft (overrides defaults)
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const r = responses[i];

		if (q.type === "text" && r.customText) {
			textAnswers.set(q.id, r.customText);
		}
		if (q.type === "radio" && r.selectionTouched) {
			const qOptions = q.options ?? [];
			if (r.selectedOptionIndex === qOptions.length && r.customText) {
				radioAnswers.set(q.id, { id: q.id, type: "radio", value: r.customText, wasCustom: true });
			} else if (r.selectedOptionIndex < qOptions.length) {
				const opt = qOptions[r.selectedOptionIndex];
				if (opt) {
					radioAnswers.set(q.id, { id: q.id, type: "radio", value: opt.value, wasCustom: false });
				}
			}
		}
		if (q.type === "checkbox" && r.selectionTouched) {
			const qOptions = q.options ?? [];
			const set = checkAnswers.get(q.id) ?? new Set<string>();
			if (r.selectedOptionIndex === qOptions.length && r.customText) {
				checkCustom.set(q.id, r.customText);
			} else if (r.selectedOptionIndex < qOptions.length) {
				const opt = qOptions[r.selectedOptionIndex];
				if (opt) set.add(opt.value);
			}
			checkAnswers.set(q.id, set);
		}
	}

	return { radioAnswers, checkAnswers, checkCustom, textAnswers };
}

function isCheckboxAnswered(
	questionId: string,
	checkAnswers: Map<string, Set<string>>,
	checkCustom: Map<string, string>,
): boolean {
	const set = checkAnswers.get(questionId);
	const custom = checkCustom.get(questionId);
	return (set != null && set.size > 0) || (custom != null && custom.trim().length > 0);
}

// ============================================================================
// Tests: Issue #1 - Checkbox Default Initialization
// ============================================================================

describe("TUI checkbox default initialization", () => {
	const checkboxQuestion: NormalizedQuestion = {
		id: "colors",
		type: "checkbox",
		prompt: "Select your favorite colors?",
		options: [
			{ value: "red", label: "Red" },
			{ value: "green", label: "Green" },
			{ value: "blue", label: "Blue" },
		],
		default: ["red", "blue"],
	};

	const emptyResponses: QnAResponse[] = [
		{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
	];

	it("should initialize checkbox defaults from q.default array", () => {
		const { checkAnswers } = initializeAnswerStores([checkboxQuestion], emptyResponses);

		const set = checkAnswers.get("colors");
		expect(set?.has("red")).toBe(true);
		expect(set?.has("blue")).toBe(true);
		expect(set?.has("green")).toBe(false);
		expect(set?.size).toBe(2);
	});

	it("should handle single string default", () => {
		const singleDefault: NormalizedQuestion = {
			...checkboxQuestion,
			id: "color",
			default: "green",
		};

		const { checkAnswers } = initializeAnswerStores([singleDefault], emptyResponses);

		expect(checkAnswers.get("color")?.has("green")).toBe(true);
		expect(checkAnswers.get("color")?.size).toBe(1);
	});

	it("should handle empty default array", () => {
		const noDefault: NormalizedQuestion = {
			...checkboxQuestion,
			id: "empty",
			default: [],
		};

		const { checkAnswers } = initializeAnswerStores([noDefault], emptyResponses);

		expect(checkAnswers.get("empty")?.size).toBe(0);
	});

	it("should mark as answered when defaults exist", () => {
		const { checkAnswers, checkCustom } = initializeAnswerStores([checkboxQuestion], emptyResponses);
		expect(isCheckboxAnswered("colors", checkAnswers, checkCustom)).toBe(true);
	});

	it("should mark as answered when draft has selectionTouched", () => {
		const touchedResponses: QnAResponse[] = [
			{ selectedOptionIndex: 0, customText: "", selectionTouched: true, committed: false },
		];

		const { checkAnswers, checkCustom } = initializeAnswerStores([checkboxQuestion], touchedResponses);
		expect(isCheckboxAnswered("colors", checkAnswers, checkCustom)).toBe(true);
	});

	it("should NOT be answered if no defaults AND no selectionTouched", () => {
		const noDefault: NormalizedQuestion = {
			...checkboxQuestion,
			id: "nodft",
			default: undefined,
		};

		const { checkAnswers, checkCustom } = initializeAnswerStores([noDefault], emptyResponses);
		expect(isCheckboxAnswered("nodft", checkAnswers, checkCustom)).toBe(false);
	});
});

// ============================================================================
// Tests: Issue #1 - Radio defaults
// ============================================================================

describe("TUI radio default initialization", () => {
	const radioQuestion: NormalizedQuestion = {
		id: "preferred_db",
		type: "radio",
		prompt: "Select your preferred database?",
		options: [
			{ value: "postgres", label: "PostgreSQL" },
			{ value: "mysql", label: "MySQL" },
			{ value: "mongodb", label: "MongoDB" },
		],
		default: "postgres",
	};

	const emptyResponses: QnAResponse[] = [
		{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
	];

	it("should initialize radio default from q.default string", () => {
		const { radioAnswers } = initializeAnswerStores([radioQuestion], emptyResponses);

		expect(radioAnswers.get("preferred_db")?.value).toBe("postgres");
		expect(radioAnswers.get("preferred_db")?.wasCustom).toBe(false);
	});

	it("should NOT initialize radio if no default", () => {
		const noDefault: NormalizedQuestion = {
			...radioQuestion,
			id: "no_default",
			default: undefined,
		};

		const { radioAnswers } = initializeAnswerStores([noDefault], emptyResponses);

		expect(radioAnswers.has("no_default")).toBe(false);
	});

	it("should override default when draft has selectionTouched", () => {
		const draftResponses: QnAResponse[] = [
			{ selectedOptionIndex: 2, customText: "", selectionTouched: true, committed: false },
		];

		const { radioAnswers } = initializeAnswerStores([radioQuestion], draftResponses);

		// Draft overrides default
		expect(radioAnswers.get("preferred_db")?.value).toBe("mongodb");
	});
});

// ============================================================================
// Tests: Text defaults
// ============================================================================

describe("TUI text default initialization", () => {
	const textQuestion: NormalizedQuestion = {
		id: "name",
		type: "text",
		prompt: "What is your name?",
		default: "Anonymous",
	};

	const emptyResponses: QnAResponse[] = [
		{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
	];

	it("should initialize text default from q.default string", () => {
		const { textAnswers } = initializeAnswerStores([textQuestion], emptyResponses);

		expect(textAnswers.get("name")).toBe("Anonymous");
	});

	it("should override default when draft has customText", () => {
		const draftResponses: QnAResponse[] = [
			{ selectedOptionIndex: 0, customText: "John", selectionTouched: true, committed: false },
		];

		const { textAnswers } = initializeAnswerStores([textQuestion], draftResponses);

		// Draft overrides default
		expect(textAnswers.get("name")).toBe("John");
	});
});

// ============================================================================
// Integration: Multi-question forms
// ============================================================================

describe("TUI multi-question initialization", () => {
	const questions: NormalizedQuestion[] = [
		{
			id: "q1",
			type: "radio",
			prompt: "Radio?",
			options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
			default: "b",
		},
		{
			id: "q2",
			type: "checkbox",
			prompt: "Checkbox?",
			options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Z" }],
			default: ["x", "z"],
		},
		{
			id: "q3",
			type: "text",
			prompt: "Text?",
			default: "Default text",
		},
	];

	const emptyResponses: QnAResponse[] = [
		{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
		{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
		{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
	];

	it("should initialize multiple question types correctly", () => {
		const { radioAnswers, checkAnswers, textAnswers } = initializeAnswerStores(questions, emptyResponses);

		// Radio
		expect(radioAnswers.get("q1")?.value).toBe("b");

		// Checkbox
		const checkSet = checkAnswers.get("q2");
		expect(checkSet?.has("x")).toBe(true);
		expect(checkSet?.has("z")).toBe(true);
		expect(checkSet?.size).toBe(2);

		// Text
		expect(textAnswers.get("q3")).toBe("Default text");
	});

	it("should handle mixed defaults and no defaults", () => {
		const mixed: NormalizedQuestion[] = [
			{ id: "with", type: "radio", prompt: "Q1?", options: [{ value: "a", label: "A" }], default: "a" },
			{ id: "without", type: "radio", prompt: "Q2?", options: [{ value: "b", label: "B" }] },
		];

		const { radioAnswers } = initializeAnswerStores(mixed, [
			{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
			{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
		]);

		expect(radioAnswers.get("with")?.value).toBe("a");
		expect(radioAnswers.has("without")).toBe(false);
	});
});

// ============================================================================
// Edge cases
// ============================================================================

describe("TUI initialization edge cases", () => {
	it("should create empty set when q.default is undefined", () => {
		const question: NormalizedQuestion = {
			id: "q1",
			type: "checkbox",
			prompt: "Q?",
			options: [{ value: "a", label: "A" }],
		};

		const { checkAnswers } = initializeAnswerStores([question], [
			{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
		]);

		expect(checkAnswers.get("q1")).toBeDefined();
		expect(checkAnswers.get("q1")?.size).toBe(0);
	});

	it("should create empty set when q.default is null", () => {
		const question: NormalizedQuestion = {
			id: "q1",
			type: "checkbox",
			prompt: "Q?",
			options: [{ value: "a", label: "A" }],
			default: null as any,
		};

		const { checkAnswers } = initializeAnswerStores([question], [
			{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
		]);

		expect(checkAnswers.get("q1")?.size).toBe(0);
	});

	it("should handle mismatched default values (not in options)", () => {
		const question: NormalizedQuestion = {
			id: "q1",
			type: "checkbox",
			prompt: "Q?",
			options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
			default: ["nonexistent"],
		};

		const { checkAnswers } = initializeAnswerStores([question], [
			{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
		]);

		// Values not in options are still added
		expect(checkAnswers.get("q1")?.has("nonexistent")).toBe(true);
	});

	it("should handle boolean default (not string or array)", () => {
		const question: NormalizedQuestion = {
			id: "q1",
			type: "checkbox",
			prompt: "Q?",
			options: [{ value: "a", label: "A" }],
			default: false as any,
		};

		const { checkAnswers } = initializeAnswerStores([question], [
			{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
		]);

		// Boolean is not handled as default
		expect(checkAnswers.get("q1")?.size).toBe(0);
	});
});

// ============================================================================
// Tests for Issue #4: Option Descriptions
// ============================================================================

describe("TUI option description handling", () => {
	const radioQuestion: NormalizedQuestion = {
		id: "db",
		type: "radio",
		prompt: "Select a database?",
		options: [
			{ value: "postgres", label: "PostgreSQL", description: "The most advanced open source DB" },
			{ value: "mysql", label: "MySQL", description: "Popular for web apps" },
			{ value: "mongodb", label: "MongoDB", description: "NoSQL document database" },
		],
	};

	it("should preserve option descriptions", () => {
		expect(radioQuestion.options[0].description).toBe("The most advanced open source DB");
		expect(radioQuestion.options[1].description).toBe("Popular for web apps");
	});

	it("should handle mixed options (some with descriptions, some without)", () => {
		const mixed: NormalizedQuestion = {
			id: "mixed",
			type: "radio",
			prompt: "Mixed?",
			options: [
				{ value: "a", label: "A", description: "Has description" },
				{ value: "b", label: "B" },
			],
		};

		expect(mixed.options[0].description).toBe("Has description");
		expect(mixed.options[1].description).toBeUndefined();
	});
});