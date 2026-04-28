import { describe, it, expect } from "vitest";

// ============================================================================
// Templates
// ============================================================================

interface Template {
	label: string;
	template: string;
}

interface ApplyTemplateData {
	question: string;
	context?: string;
	answer: string;
	index: number;
	total: number;
}

function normalizeTemplates(templates?: (string | { label?: string; template: string })[]): Template[] {
	if (!templates || templates.length === 0) return [];

	return templates
		.map((template, index) => {
			if (typeof template === "string") {
				return { label: `Template ${index + 1}`, template };
			}
			return {
				label: template.label?.trim() || `Template ${index + 1}`,
				template: template.template,
			};
		})
		.filter((t) => t.template.trim().length > 0);
}

function applyTemplate(template: string, data: ApplyTemplateData): string {
	const replacements: Record<string, string> = {
		question: data.question,
		context: data.context ?? "",
		answer: data.answer,
		index: String(data.index + 1),
		total: String(data.total),
	};

	return template.replace(/\{\{(question|context|answer|index|total)\}\}/g, (_match, key: string) => {
		return replacements[key] ?? "";
	});
}

function getNextTemplateIndex(currentIndex: number, templateCount: number): number {
	if (templateCount === 0) return 0;
	return (currentIndex + 1) % templateCount;
}

// ============================================================================
// Tests
// ============================================================================

describe("normalizeTemplates", () => {
	it("should normalize string templates", () => {
		const input = ["{{answer}}", "Q: {{question}} A: {{answer}}"];
		const result = normalizeTemplates(input);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ label: "Template 1", template: "{{answer}}" });
	});

	it("should normalize object templates", () => {
		const input = [{ label: "My Template", template: "{{answer}}" }];
		const result = normalizeTemplates(input);
		expect(result[0].label).toBe("My Template");
	});

	it("should filter out empty templates", () => {
		const input = ["{{answer}}", "", { label: "Empty", template: "   " }];
		const result = normalizeTemplates(input);
		expect(result).toHaveLength(1);
	});

	it("should return empty array for null/undefined", () => {
		expect(normalizeTemplates(null)).toEqual([]);
		expect(normalizeTemplates(undefined)).toEqual([]);
	});
});

describe("applyTemplate", () => {
	it("should replace question placeholder", () => {
		const template = "Q: {{question}}";
		const data = { question: "What is your name?", context: "", answer: "John", index: 0, total: 1 };
		const result = applyTemplate(template, data);
		expect(result).toBe("Q: What is your name?");
	});

	it("should replace answer placeholder", () => {
		const template = "Answer: {{answer}}";
		const data = { question: "What?", context: "", answer: "John", index: 0, total: 1 };
		const result = applyTemplate(template, data);
		expect(result).toBe("Answer: John");
	});

	it("should replace index placeholder", () => {
		const template = "Q{{index}}: {{question}}";
		const data = { question: "What?", context: "", answer: "A", index: 2, total: 5 };
		const result = applyTemplate(template, data);
		expect(result).toBe("Q3: What?");
	});

	it("should replace total placeholder", () => {
		const template = "{{index}}/{{total}}";
		const data = { question: "What?", context: "", answer: "A", index: 1, total: 10 };
		const result = applyTemplate(template, data);
		expect(result).toBe("2/10");
	});
});

describe("getNextTemplateIndex", () => {
	it("should cycle forward", () => {
		expect(getNextTemplateIndex(0, 3)).toBe(1);
		expect(getNextTemplateIndex(1, 3)).toBe(2);
		expect(getNextTemplateIndex(2, 3)).toBe(0);
	});

	it("should stay at 0 for empty templates", () => {
		expect(getNextTemplateIndex(0, 0)).toBe(0);
	});

	it("should handle single template", () => {
		expect(getNextTemplateIndex(0, 1)).toBe(0);
	});
});