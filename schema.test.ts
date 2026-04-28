import { describe, it, expect } from "vitest";

// ============================================================================
// Schema - normalizeQuestion
// ============================================================================

describe("schema normalizeQuestion", () => {
	it("should normalize a basic radio question", () => {
		const input = {
			id: "preferred_db",
			type: "radio" as const,
			prompt: "What is your preferred database?",
			options: [
				{ value: "postgres", label: "PostgreSQL" },
				{ value: "mysql", label: "MySQL" },
			],
		};

		// Inline normalization for testing
		const result = normalizeQuestion(input, 0);

		expect(result.id).toBe("preferred_db");
		expect(result.type).toBe("radio");
		expect(result.prompt).toBe("What is your preferred database?");
		expect(result.label).toBe("Q1");
		expect(result.options).toHaveLength(2);
		expect(result.allowOther).toBe(true);
		expect(result.required).toBe(true);
	});

	it("should default allowOther to true for radio/checkbox", () => {
		const inputRadio = { id: "test", type: "radio" as const, prompt: "Question?" };
		const resultRadio = normalizeQuestion(inputRadio, 0);
		expect(resultRadio.allowOther).toBe(true);

		const inputCheckbox = { id: "test2", type: "checkbox" as const, prompt: "Question?" };
		const resultCheckbox = normalizeQuestion(inputCheckbox, 0);
		expect(resultCheckbox.allowOther).toBe(true);
	});

	it("should default allowOther to false for text", () => {
		const input = { id: "test", type: "text" as const, prompt: "Question?" };
		const result = normalizeQuestion(input, 0);
		expect(result.allowOther).toBe(false);
	});

	// NEW: Tests for Issue #1 - Checkbox default initialization
	it("should preserve default array for checkbox questions", () => {
		const input = {
			id: "colors",
			type: "checkbox" as const,
			prompt: "Select your favorite colors?",
			options: [
				{ value: "red", label: "Red" },
				{ value: "green", label: "Green" },
				{ value: "blue", label: "Blue" },
			],
			default: ["red", "blue"],
		};

		const result = normalizeQuestion(input, 0);

		expect(result.type).toBe("checkbox");
		expect(Array.isArray(result.default)).toBe(true);
		expect(result.default).toEqual(["red", "blue"]);
	});

	it("should preserve single string default for checkbox (backwards compat)", () => {
		const input = {
			id: "color",
			type: "checkbox" as const,
			prompt: "Select a color?",
			options: [
				{ value: "red", label: "Red" },
				{ value: "green", label: "Green" },
			],
			default: "red",
		};

		const result = normalizeQuestion(input, 0);

		expect(result.default).toBe("red");
	});

	it("should preserve string default for radio questions", () => {
		const input = {
			id: "db",
			type: "radio" as const,
			prompt: "Select a database?",
			options: [
				{ value: "postgres", label: "PostgreSQL" },
				{ value: "mysql", label: "MySQL" },
			],
			default: "postgres",
		};

		const result = normalizeQuestion(input, 0);

		expect(result.default).toBe("postgres");
	});

	it("should preserve string default for text questions", () => {
		const input = {
			id: "name",
			type: "text" as const,
			prompt: "What is your name?",
			default: "Anonymous",
		};

		const result = normalizeQuestion(input, 0);

		expect(result.default).toBe("Anonymous");
	});
});

// ============================================================================
// Schema - normalizeQuestions
// ============================================================================

describe("schema normalizeQuestions", () => {
	it("should normalize array of questions", () => {
		const input = [
			{ id: "q1", type: "radio" as const, prompt: "Q1?", options: [] },
			{ id: "q2", type: "text" as const, prompt: "Q2?" },
		];

		const result = normalizeQuestions(input);

		expect(result).toHaveLength(2);
		expect(result[0].id).toBe("q1");
		expect(result[1].id).toBe("q2");
	});

	it("should return empty array for non-array input", () => {
		expect(normalizeQuestions(null)).toEqual([]);
		expect(normalizeQuestions(undefined)).toEqual([]);
	});

	// NEW: Tests for Issue #4 - Option descriptions
	it("should preserve option descriptions", () => {
		const input = [
			{
				id: "q1",
				type: "radio" as const,
				prompt: "Q1?",
				options: [
					{ label: "Yes", description: "This is a positive confirmation" },
					{ label: "No", description: "This is a negative response" },
				],
			},
		];

		const result = normalizeQuestions(input);

		expect(result[0].options[0].description).toBe("This is a positive confirmation");
		expect(result[0].options[1].description).toBe("This is a negative response");
	});

	it("should handle options without descriptions", () => {
		const input = [
			{
				id: "q1",
				type: "radio" as const,
				prompt: "Q1?",
				options: [{ label: "Option A" }],
			},
		];

		const result = normalizeQuestions(input);

		expect(result[0].options[0].description).toBeUndefined();
	});
});

// ============================================================================
// Schema - normalizeOptions
// ============================================================================

describe("schema normalizeOptions", () => {
	it("should normalize options array", () => {
		const input = [
			{ label: "PostgreSQL", description: "Great DB" },
			{ label: "MySQL" },
			{ value: "mongo", label: "MongoDB" },
		];

		const result = normalizeOptions(input);

		expect(result).toHaveLength(3);
		expect(result[0].value).toBe("postgresql");
		expect(result[0].description).toBe("Great DB");
	});

	it("should filter out invalid options", () => {
		const input = [
			{ label: "Valid" },
			{ notLabel: "Invalid" },
			{ label: "" },
		];

		const result = normalizeOptions(input);
		expect(result).toHaveLength(1);
	});
});

// ============================================================================
// Schema - parseExtractionResult
// ============================================================================

describe("schema parseExtractionResult", () => {
	it("should parse JSON from markdown code block", () => {
		const input = `\`\`\`json
{
  "questions": [
    { "question": "What is your name?", "type": "text" }
  ]
}
\`\`\``;

		const result = parseExtractionResult(input);

		expect(result).not.toBeNull();
		expect(result!.questions).toHaveLength(1);
	});

	it("should parse plain JSON", () => {
		const input = `{"questions": [{"question": "Q1?", "type": "radio"}]}`;
		const result = parseExtractionResult(input);
		expect(result).not.toBeNull();
		expect(result!.questions).toHaveLength(1);
	});

	it("should return null for invalid JSON", () => {
		const input = "not valid json";
		const result = parseExtractionResult(input);
		expect(result).toBeNull();
	});
});

// ============================================================================
// Helpers (copied from schema.ts for testing)
// ============================================================================

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface UnifiedQuestion {
	id: string;
	type: "radio" | "checkbox" | "text";
	prompt: string;
	label?: string;
	options?: QuestionOption[];
	allowOther?: boolean;
	required?: boolean;
	placeholder?: string;
	default?: string | string[];  // NEW: Default value(s)
}

interface NormalizedQuestion extends UnifiedQuestion {
	label: string;
	options: QuestionOption[];
	allowOther: boolean;
	required: boolean;
}

interface ExtractedQuestion {
	id?: string;
	type?: "radio" | "checkbox" | "text";
	header?: string;
	question?: string;
	options?: { label: string; description?: string }[];
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

function normalizeQuestion(q: UnifiedQuestion, index: number): NormalizedQuestion {
	const prompt = q.prompt ?? "";
	const options: QuestionOption[] = (q.options ?? []).map((opt) => ({
		value: opt.value ?? opt.label,
		label: opt.label,
		description: opt.description,
	}));
	const allowOtherDefault = q.type === "text" ? false : true;
	const label = q.label ?? q.header ?? `Q${index + 1}`;

	return {
		id: q.id ?? `question_${index + 1}`,
		type: q.type ?? "text",
		prompt,
		label,
		options,
		allowOther: q.allowOther ?? allowOtherDefault,
		required: q.required ?? true,
		placeholder: q.placeholder,
		default: q.default,  // NEW: Preserve default for checkbox/radio/text
	};
}

function normalizeQuestions(questions: UnifiedQuestion[] | unknown): NormalizedQuestion[] {
	if (!Array.isArray(questions)) return [];

	return questions
		.map((q, index) => {
			const prompt = (q as UnifiedQuestion).prompt;
			if (typeof prompt !== "string" || prompt.trim().length === 0) return null;
			return normalizeQuestion(q as UnifiedQuestion, index);
		})
		.filter((q): q is NormalizedQuestion => q !== null);
}

function normalizeOptions(raw: unknown): QuestionOption[] {
	if (!Array.isArray(raw)) return [];

	return raw
		.map((option): QuestionOption | null => {
			if (!option || typeof option !== "object") return null;
			const opt = option as { value?: unknown; label?: unknown; description?: unknown };
			const label = typeof opt.label === "string" ? opt.label.trim() : null;
			if (!label) return null;
			const value = typeof opt.value === "string" ? opt.value.trim() : label.toLowerCase().replace(/\s+/g, "_");
			return {
				value,
				label,
				description: typeof opt.description === "string" ? opt.description.trim() : undefined,
			};
		})
		.filter((opt): opt is QuestionOption => opt !== null);
}

function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		let jsonStr = text;
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) jsonStr = jsonMatch[1].trim();
		const parsed = JSON.parse(jsonStr) as { questions?: unknown };
		if (!parsed || !Array.isArray(parsed.questions)) return null;

		const questions: ExtractedQuestion[] = [];
		for (const rawQuestion of parsed.questions) {
			if (!rawQuestion || typeof rawQuestion !== "object") continue;
			const q = rawQuestion as { question?: unknown; type?: unknown };
			const questionText = typeof q.question === "string" ? q.question.trim() : "";
			if (questionText.length === 0) continue;
			questions.push({ question: questionText, type: q.type as any });
		}
		return { questions };
	} catch {
		return null;
	}
}