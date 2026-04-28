/**
 * Templates module - Answer templates for auto-filling responses
 *
 * Provides template functionality for the Q&A form:
 * - Template normalization (string or object format)
 * - Template application with variable substitution
 */

import type { UnifiedQuestion } from "./schema";

// ============================================================================
// Types
// ============================================================================

export interface Template {
	label: string;
	template: string;
}

// ============================================================================
// Template Normalization
// ============================================================================

/**
 * Normalize templates from raw configuration
 * Supports both string format and { label?, template } object format
 */
export function normalizeTemplates(templates?: (string | { label?: string; template: string })[]): Template[] {
	if (!templates || templates.length === 0) {
		return [];
	}

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
		.filter((template) => template.template.trim().length > 0);
	}

// ============================================================================
// Template Application
// ============================================================================

interface ApplyTemplateData {
	question: string;
	context?: string;
	answer: string;
	index: number;
	total: number;
}

/**
 * Apply a template string with variable substitution
 *
 * Variables:
 * - {{question}} - The question text
 * - {{context}} - Optional context/header
 * - {{answer}} - Current answer text
 * - {{index}} - Question index (1-based)
 * - {{total}} - Total number of questions
 */
export function applyTemplate(template: string, data: ApplyTemplateData): string {
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

// ============================================================================
// Default Templates
// ============================================================================

export const DEFAULT_TEMPLATES: Template[] = [
	{
		label: "Just Question",
		template: "{{question}}",
	},
	{
		label: "Question + Context",
		template: "{{context}} {{question}}",
	},
	{
		label: "Question with Answer",
		template: "{{question}} - {{answer}}",
	},
];