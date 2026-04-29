/**
 * pi-answer Extension - Unified Q&A Extension
 *
 * Merges the best features of pi-answer and llm_askusertool:
 * - /answer command for remote LLM extraction
 * - /answer:again to restore previous questionnaire
 * - ask_user_question tool for local LLM direct invocation
 * - Unified TUI component with askusertool rendering + answer features
 *
 * Run with:
 * - /answer - Extract questions from last assistant message
 * - /answer:again - Restore previous questionnaire
 * - (tool) ask_user_question - Called directly by local LLM
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import { BorderedLoader, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import {
	normalizeQuestions,
	parseExtractionResult,
	type UnifiedQuestion,
	type NormalizedQuestion,
} from "./schema";

import {
	DEFAULT_SYSTEM_PROMPT,
	DEFAULT_MODEL_PREFERENCES,
	DEFAULT_EXTRACTION_TIMEOUT_MS,
	selectExtractionModel,
	type ModelPreference,
} from "./extraction";

import { normalizeTemplates } from "./templates";

import {
	type Template,
} from "./templates";

import {
	type AnswerDraftSettings,
	DEFAULT_DRAFT_SETTINGS,
	createDraftStore,
	getLatestDraftForEntry,
	getInitialResponses,
	hasAnyDraftContent,
	type QnAResponse,
} from "./drafts";

import { createQnATuiComponent, type FormResult, type FormAnswer } from "./tui";

// ============================================================================
// Settings
// ============================================================================

export interface AnswerSettings {
	toolEnabled?: boolean;
	extractionModels?: ModelPreference[];
	extractionTimeoutMs?: number;
	debugNotifications?: boolean;
	answerTemplates?: (string | { label?: string; template: string })[];
	drafts?: AnswerDraftSettings;
}

interface SettingsWithDefaults {
	toolEnabled: boolean;
	extractionModels: ModelPreference[];
	extractionTimeoutMs: number;
	debugNotifications: boolean;
	answerTemplates: Template[];
	drafts: Required<AnswerDraftSettings>;
}

// Module-level settings cache (Issue #2 fix)
let cachedSettings: SettingsWithDefaults | null = null;

// ============================================================================
// Settings Loading
// ============================================================================

async function readSettingsFile(
	filePath: string,
	// @ts-expect-error - ui exists at runtime
	ctx: { hasUI: boolean; ui: ExtensionAPI["ui"] },
): Promise<Record<string, unknown> | null> {
	try {
		const contents = await fs.readFile(filePath, "utf8");
		return JSON.parse(contents) as Record<string, unknown>;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return null;
		if (ctx.hasUI) {
			ctx.ui.notify(`Failed to read ${filePath}: ${err.message ?? "unknown error"}`, "warning");
		}
		return null;
	}
}

function getAnswerSettingsPaths(cwd: string): { globalPath: string; projectPath: string } {
	// Guard: ensure getAgentDir returns a valid path
	let agentDir = getAgentDir();
	if (!agentDir || typeof agentDir !== "string") {
		agentDir = process.env.HOME || "/home/" + (process.env.USER || "");
	}
	return {
		globalPath: path.join(agentDir, "settings.json"),
		projectPath: path.join(cwd, ".pi", "settings.json"),
	};
}

async function loadAnswerSettings(
	// @ts-expect-error - hasUI, ui, cwd exist at runtime
	ctx: { cwd: string; hasUI: boolean; ui: ExtensionAPI["ui"] },
	forceRefresh = false,
): Promise<SettingsWithDefaults> {
	// Return cached settings if available (Issue #2 fix)
	if (!forceRefresh && cachedSettings) {
		return cachedSettings;
	}

	const { globalPath, projectPath } = getAnswerSettingsPaths(ctx.cwd);

	const [globalSettings, projectSettings] = await Promise.all([
		readSettingsFile(globalPath, ctx),
		readSettingsFile(projectPath, ctx),
	]);

	const global = (globalSettings?.answer as AnswerSettings | undefined) ?? {};
	const project = (projectSettings?.answer as AnswerSettings | undefined) ?? {};

	return cachedSettings = {
		toolEnabled: project.toolEnabled ?? global.toolEnabled ?? true,
		extractionModels: project.extractionModels ?? global.extractionModels ?? DEFAULT_MODEL_PREFERENCES,
		extractionTimeoutMs: project.extractionTimeoutMs ?? global.extractionTimeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS,
		debugNotifications: project.debugNotifications ?? global.debugNotifications ?? false,
		answerTemplates: normalizeTemplates(project.answerTemplates ?? global.answerTemplates),
		drafts: {
			enabled: project.drafts?.enabled ?? global.drafts?.enabled ?? DEFAULT_DRAFT_SETTINGS.enabled,
			autosaveMs: project.drafts?.autosaveMs ?? global.drafts?.autosaveMs ?? DEFAULT_DRAFT_SETTINGS.autosaveMs,
			promptOnRestore: project.drafts?.promptOnRestore ?? global.drafts?.promptOnRestore ?? DEFAULT_DRAFT_SETTINGS.promptOnRestore,
		},
	};
}

// ============================================================================
// Tool Schema
// ============================================================================

const OptionSchema = Type.Object({
	value: Type.String({ description: "Value returned when selected (required)" }),
	label: Type.String({ description: "Display label shown to user (required)" }),
	description: Type.Optional(Type.String({ description: "Help text shown below the label" })),
}, {
	description: "Each option needs { label: string, value: string }. Example: { label: \"Yes\", value: \"yes\" }",
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	type: Type.Unsafe<"radio" | "checkbox" | "text">({
		type: "string",
		enum: ["radio", "checkbox", "text"],
		description: "Question type: radio (single-select), checkbox (multi-select), or text (free input)",
	}),
	prompt: Type.String({ description: "The question text to display" }),
	label: Type.Optional(Type.String({ description: "Short label for progress display" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for radio/checkbox types" })),
	allowOther: Type.Optional(Type.Boolean({ description: "Add an 'Other...' option (default: true for radio/checkbox)" })),
	required: Type.Optional(Type.Boolean({ description: "Whether an answer is required (default: true)" })),
	placeholder: Type.Optional(Type.String({ description: "Placeholder for text inputs" })),
	default: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Default value(s). String for radio/text, string[] for checkbox",
		}),
	)
});

const AskUserQuestionParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Form title displayed at the top" })),
	description: Type.Optional(Type.String({ description: "Brief context shown under the title" })),
	questions: Type.Array(QuestionSchema, { description: "Questions to ask" }),
});

// ============================================================================
// Extension Entry
// ============================================================================

// Default settings until loaded
const DEFAULT_SETTINGS: SettingsWithDefaults = {
	toolEnabled: true,
	extractionModels: DEFAULT_MODEL_PREFERENCES,
	extractionTimeoutMs: DEFAULT_EXTRACTION_TIMEOUT_MS,
	debugNotifications: false,
	answerTemplates: [],
	drafts: DEFAULT_DRAFT_SETTINGS,
};

let currentSettings = DEFAULT_SETTINGS;

export default function (pi: ExtensionAPI) {
	// ========================================================================
	// Load settings async after registration (don't block factory)
	// ========================================================================
	loadAnswerSettings({ cwd: pi.cwd, hasUI: pi.hasUI, ui: pi.ui })
		.then((settings) => {
			currentSettings = settings;
		})
		.catch(() => {});
	// Register ask_user_question tool (only if enabled in settings)
	// ========================================================================

	if (currentSettings.toolEnabled) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		description: `Ask the user one or more questions using an interactive form. Supports:
- **radio**: Single-select from options
- **checkbox**: Multi-select from options  
- **text**: Free-form text input

Each question can include an "Other..." option for custom input.`,
		promptSnippet: "Ask the user interactive questions with radio, checkbox, or text inputs",
		promptGuidelines: [
			"Use ask_user_question instead of asking questions in plain text when you need structured user input.",
			"Prefer radio for single-choice, checkbox for multi-choice, text for open-ended answers.",
			"Always include an 'Other' escape hatch (allowOther: true) unless the options are exhaustive.",
		],
		parameters: AskUserQuestionParams as any,

		// Auto-fill value from label if not provided
		prepareArguments(args) {
			if (!args.questions) return args;
			return {
				...args,
				questions: args.questions.map((q: any) => ({
					...q,
					options: q.options?.map((o: any) => ({
						...o,
						value: o.value ?? o.label ?? o.description,
					})),
				})),
			};
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!ctx.hasUI) {
				debugNotify("tool ask_user_question failed: UI not available");
				return {
					content: [{ type: "text", text: "Error: UI not available" }],
					details: { questions: [], answers: [], cancelled: true },
				};
			}

			if (!params.questions.length) {
				debugNotify("tool ask_user_question failed: no questions provided");
				return {
					content: [{ type: "text", text: "Error: No questions provided" }],
					details: { questions: [], answers: [], cancelled: true },
				};
			}

			// Load settings for templates
			const settings = await loadAnswerSettings(ctx);
			const normalizedQuestions = normalizeQuestions(params.questions as UnifiedQuestion[]);

			const result = await ctx.ui.custom<FormResult>((tui, theme, _kb, done) => {
				const component = createQnATuiComponent(normalizedQuestions, { ui: tui, theme }, done, {
					title: params.title,
					description: params.description,
					templates: settings.answerTemplates,
					theme,
				});
				return component as any;
			});

			if (!result || result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the form" }],
					details: result ?? { questions: normalizedQuestions, answers: [], cancelled: true },
				};
			}

			// Format result
			const answerLines: string[] = [];
			for (let idx = 0; idx < result.answers.length; idx++) {
				const a = result.answers[idx];
				const q = normalizedQuestions.find((q) => q.id === a.id);
				const label = q?.label ?? a.id;

				if (a.type === "radio") {
					const prefix = a.wasCustom ? "(wrote) " : "";
					answerLines.push(`Q${idx + 1}: ${label}: ${prefix}${a.value}`);
				} else if (a.type === "checkbox") {
					const values = Array.isArray(a.value) ? a.value : [a.value];
					answerLines.push(`Q${idx + 1}: ${label}: ${values.length ? values.join(", ") : "(none)"}`);
				} else {
					answerLines.push(`Q${idx + 1}: ${label}: ${a.value || "(empty)"}`);
				}
			}

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as any[]) || [];
			const title = args.title as string | undefined;
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			if (title) text += theme.fg("accent", title) + " ";
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as FormResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines = details.answers.map((a) => {
				const q = details.questions.find((q) => q.id === a.id);
				const prompt = q?.prompt ?? a.id;
				const label = q?.label || a.id;

				if (a.type === "radio") {
					const prefix = a.wasCustom ? theme.fg("dim", "(wrote) ") : "";
					return `${theme.fg("success", "✓")} ${theme.fg("accent", label)}: ${prefix}${a.value}\n${theme.fg("dim", `  → ${prompt}`)}`;
				}
				if (a.type === "checkbox") {
					const values = Array.isArray(a.value) ? a.value : [a.value];
					const display = values.length ? values.join(", ") : theme.fg("dim", "(none)");
					return `${theme.fg("success", "✓")} ${theme.fg("accent", label)}: ${display}\n${theme.fg("dim", `  → ${prompt}`)}`;
				}
				return `${theme.fg("success", "✓")} ${theme.fg("accent", label)}: ${a.value || theme.fg("dim", "(empty)")}\n${theme.fg("dim", `  → ${prompt}`)}`;
			});

			return new Text(lines.join("\n"), 0, 0);
		},
	});
	
	// Close tool registration conditional
	}

	// ========================================================================
	// Cache for /answer:again
	// ========================================================================

	let cachedExtraction: {
		questions: UnifiedQuestion[];
		sourceEntryId: string;
		lastAssistantEntryId: string;
		timestamp: number;
	} | null = null;

	// Type guard for validating cache data (Issue #1 fix)
	function isValidCacheData(data: unknown): data is { questions: UnifiedQuestion[]; sourceEntryId: string; lastAssistantEntryId: string; timestamp: number } {
		return (
			data !== null &&
			typeof data === "object" &&
			"questions" in data &&
			Array.isArray((data as any).questions) &&
			"sourceEntryId" in data &&
			typeof (data as any).sourceEntryId === "string"
		);
	}

	// Type guard for message details
	function isValidMessageDetails(data: unknown): data is { questions: UnifiedQuestion[]; sourceEntryId: string; lastAssistantEntryId?: string; timestamp: number } {
		return (
			data !== null &&
			typeof data === "object" &&
			"questions" in data &&
			Array.isArray((data as any).questions) &&
			"sourceEntryId" in data &&
			typeof (data as any).sourceEntryId === "string"
		);
	}

	// Persist cache to session
	const persistCache = () => {
		if (!cachedExtraction) return;
		pi.appendEntry("answer:again", {
			questions: cachedExtraction.questions,
			sourceEntryId: cachedExtraction.sourceEntryId,
			lastAssistantEntryId: cachedExtraction.lastAssistantEntryId,
			timestamp: cachedExtraction.timestamp,
		});
	};

	// Reconstruct cache from session
	const reconstructCache = (ctx: { sessionManager: ExtensionAPI["sessionManager"] }) => {
		const entries = ctx.sessionManager.getEntries();

		// Check for persisted answer:again entry
		let latestCache: typeof cachedExtraction | null = null;
		let latestTime = 0;

		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === "answer:again") {
				const cache = entry.data as typeof cachedExtraction;
				if (isValidCacheData(cache)) {
					const entryTime = cache.timestamp ?? 0;
					if (entryTime > latestTime) {
						latestCache = cache;
						latestTime = entryTime;
					}
				}
			}
		}

		if (latestCache) {
			cachedExtraction = latestCache;
			return;
		}

		// Also check message details
		let latestMessageTime = 0;
		let latestMessageCache: typeof cachedExtraction | null = null;

		for (const entry of entries) {
			if (entry.type === "message" && "customType" in entry.message && entry.message.customType === "answers") {
				const details = (entry.message as any).details;
				// Use type guard (Issue #1 fix)
				if (isValidMessageDetails(details)) {
					const entryTime = details.timestamp ?? 0;
					if (entryTime > latestMessageTime) {
						latestMessageCache = {
							questions: details.questions,
							sourceEntryId: details.sourceEntryId,
							lastAssistantEntryId: details.lastAssistantEntryId ?? details.sourceEntryId,
							timestamp: entryTime,
						};
						latestMessageTime = entryTime;
					}
				}
			}
		}

		if (latestMessageCache) {
			cachedExtraction = latestMessageCache;
		}
	};

	// Register session start to restore cache
	pi.on("session_start", (_event, ctx) => reconstructCache(ctx));
	pi.on("session_tree", (_event, ctx) => reconstructCache(ctx));

	// ========================================================================
	// /answer Command Handler
	// ========================================================================

	const answerHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("answer requires interactive mode", "error");
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const settings = await loadAnswerSettings(ctx);
		const templates = settings.answerTemplates;
		const draftSettings = settings.drafts;

		// Find last assistant message
		const branch = ctx.sessionManager.getBranch();
		let lastAssistantText: string | undefined;
		let lastAssistantEntryId: string | undefined;

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message") {
				const msg = entry.message;
				if ("role" in msg && msg.role === "assistant") {
					if (msg.stopReason !== "stop") {
						ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
						return;
					}
					const textParts = msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text);
					if (textParts.length > 0) {
						lastAssistantText = textParts.join("\n");
						lastAssistantEntryId = entry.id;
						break;
					}
				}
			}
		}

		if (!lastAssistantText || !lastAssistantEntryId) {
			ctx.ui.notify("No assistant messages found", "error");
			return;
		}

		// Select extraction model
		const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry, settings.extractionModels);

		// Extract questions
		const extractionResult = await ctx.ui.custom<{ questions: { question: string; header?: string; options?: { label: string; description?: string }[]; type?: string }[] } | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
			loader.onAbort = () => done(null);

			const doExtract = async () => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
				if (!auth.ok) throw new Error(auth.error);

				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: lastAssistantText! }],
					timestamp: Date.now(),
				};

				const response = await complete(
					extractionModel,
					{ systemPrompt: DEFAULT_SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
				);

				if (response.stopReason === "aborted") return null;

				const responseText = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return parseExtractionResult(responseText);
			};

			doExtract()
				.then((result) => done(result))
				.catch((err) => {
					// Store error message for user feedback
					(done as { error?: string }).error = err.message ?? "Extraction failed";
					done(null);
				});
			return loader;
		});

		if (!extractionResult) {
			// Check if there was an extraction error or user cancelled
			const errorMsg = (extractionResult as { error?: string })?.error;
			if (errorMsg) {
				ctx.ui.notify(`Extraction failed: ${errorMsg} - try again`, "warning");
			} else {
				ctx.ui.notify("Extraction cancelled - no questions extracted", "info");
			}
			return;
		}

		if (extractionResult.questions.length === 0) {
			ctx.ui.notify("No questions found in the last message", "info");
			return;
		}

		// Convert extraction format to unified format
	const unifiedQuestions: UnifiedQuestion[] = extractionResult.questions.map((eq, index): UnifiedQuestion => ({
			id: eq.id ?? `question_${index + 1}`,
			type: (eq.type as "radio" | "checkbox" | "text") ?? (eq.options?.length ? "radio" : "text"),
			prompt: eq.question ?? "",
			label: eq.header,
			options: eq.options?.map((opt) => ({
				value: opt.label.toLowerCase().replace(/\s+/g, "_"),
				label: opt.label,
				description: opt.description,
			})),
		}));

		const normalizedQuestions = normalizeQuestions(unifiedQuestions);

		// Create draft store
		const draftStore = createDraftStore(
			pi,
			{ sourceEntryId: lastAssistantEntryId, questions: unifiedQuestions },
			draftSettings,
		);

		let initialResponses = getInitialResponses(unifiedQuestions, null);
		draftStore.seed(initialResponses);

		// Run TUI
		const result = await ctx.ui.custom<FormResult>((tui, theme, _kb, done) => {
			const component = createQnATuiComponent(normalizedQuestions, { ui: tui, theme }, done, {
				title: "Questions",
				templates,
				initialResponses,
				onResponsesChange: (responses) => draftStore.schedule(responses),
				theme,
			});
			return component as any;
		});

		if (!result) {
			draftStore.flush();
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		// Format answers for display
		const answerLines: string[] = [];
		for (let i = 0; i < result.answers.length; i++) {
			const a = result.answers[i];
			const q = normalizedQuestions[i];
			const label = q?.label ?? `Q${i + 1}`;

			let value: string;
			if (a.type === "checkbox" && Array.isArray(a.value)) {
				value = a.value.join(", ");
			} else {
				value = String(a.value);
			}

			answerLines.push(`Q${i + 1}: ${label}: ${value}`);
		}

		// Send answers
		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions in the following way:\n\n" + answerLines.join("\n"),
				display: true,
				details: {
					sourceEntryId: lastAssistantEntryId,
					lastAssistantEntryId,
					questions: unifiedQuestions,
				},
			},
			{ triggerTurn: true },
		);

		// Update cache for /answer:again
		cachedExtraction = {
			questions: unifiedQuestions,
			sourceEntryId: lastAssistantEntryId,
			lastAssistantEntryId,
			timestamp: Date.now(),
		};
		persistCache();
	};

	// ========================================================================
	// /answer:again Command Handler
	// ========================================================================

	const answerAgainHandler = async (ctx: ExtensionContext) => {
		if (!cachedExtraction) {
			reconstructCache(ctx);
		}

		if (!cachedExtraction) {
			ctx.ui.notify("No previous questionnaire found - use /answer first, then /answer:again", "info");
			return;
		}

		const settings = await loadAnswerSettings(ctx);
		const templates = settings.answerTemplates;
		const draftSettings = settings.drafts;

		const normalizedQuestions = normalizeQuestions(cachedExtraction.questions);

		// Try to restore draft
		const entries = ctx.sessionManager.getEntries();
		const previousDraft = getLatestDraftForEntry(
			entries as { type: string; customType?: string; data?: any }[],
			cachedExtraction.sourceEntryId,
		);

		let initialResponses = getInitialResponses(cachedExtraction.questions, previousDraft);

		if (previousDraft && hasAnyDraftContent(cachedExtraction.questions, initialResponses)) {
			const resume = await ctx.ui.confirm(
				"Resume previous answers?",
				"Saved answers were found. Restore them?",
			);
			if (!resume) {
				initialResponses = getInitialResponses(cachedExtraction.questions, null);
			}
		}

		const draftStore = createDraftStore(
			pi,
			{ sourceEntryId: cachedExtraction.sourceEntryId, questions: cachedExtraction.questions },
			draftSettings,
		);

		draftStore.seed(initialResponses);

		const result = await ctx.ui.custom<FormResult>((tui, theme, _kb, done) => {
			const component = createQnATuiComponent(normalizedQuestions, { ui: tui, theme }, done, {
				title: "Questions (Again)",
				templates,
				initialResponses,
				onResponsesChange: (responses) => draftStore.schedule(responses),
				theme,
			});
			return component as any;
		});

		if (!result) {
			draftStore.flush();
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		// Format answers
		const answerLines: string[] = [];
		for (let i = 0; i < result.answers.length; i++) {
			const a = result.answers[i];
			const q = normalizedQuestions[i];
			const label = q?.label ?? `Q${i + 1}`;

			let value: string;
			if (a.type === "checkbox" && Array.isArray(a.value)) {
				value = a.value.join(", ");
			} else {
				value = String(a.value);
			}

			answerLines.push(`Q${i + 1}: ${label}: ${value}`);
		}

		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions in the following way:\n\n" + answerLines.join("\n"),
				display: true,
				details: {
					sourceEntryId: cachedExtraction.sourceEntryId,
					lastAssistantEntryId: cachedExtraction.lastAssistantEntryId,
					questions: cachedExtraction.questions,
				},
			},
			{ triggerTurn: true },
		);

		cachedExtraction = {
			...cachedExtraction,
			timestamp: Date.now(),
		};
		persistCache();
	};

	// ========================================================================
	// Register Commands
	// ========================================================================

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerCommand("answer:again", {
		description: "Reopen the last Q&A questionnaire without re-extracting",
		handler: (_args, ctx) => answerAgainHandler(ctx),
	});
}