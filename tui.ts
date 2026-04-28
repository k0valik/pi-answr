/**
 * Unified TUI Component - The core interactive questionnaire UI
 *
 * Combines:
 * - askusertool's polished rendering (bullet indicators, cursor tracking, multi-line wrapping)
 * - answer's unique features (Ctrl+E, templates, draft autosave, confirmation page)
 *
 * Navigation:
 * - Tab / Shift+Tab: cycle forward/backward through questions (circular)
 * - Up/Down: navigate options within a question
 * - Space: toggle checkbox
 * - Enter: select radio / submit text / advance / confirm
 * - Shift+Enter: insert newline in text inputs
 * - Escape: cancel / go back
 * - Ctrl+E: append to current answer (without switching to Other)
 * - Ctrl+T: cycle templates (preview)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { NormalizedQuestion, UnifiedQuestion } from "./schema";
import { applyTemplate, type Template } from "./templates";
import type { QnAResponse } from "./drafts";

// ============================================================================
// Types
// ============================================================================

export interface FormResult {
	questions: NormalizedQuestion[];
	answers: FormAnswer[];
	cancelled: boolean;
	title?: string;
	description?: string;
}

export interface FormAnswer {
	id: string;
	type: "radio" | "checkbox" | "text";
	value: string | string[];
	wasCustom: boolean;
}

// Symbols for TUI rendering
const SYM = {
	radioOn: "◉",
	radioOff: "○",
	checkOn: "☑",
	checkOff: "☐",
	pointer: "❯",
	currentDot: "●",
	answeredCheck: "✓",
	unansweredDot: "○",
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Truncate answer text for display in confirmation page
 * From answer/index.ts:240
 */
function summarizeAnswer(text: string, maxLength: number = 60): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) {
		return singleLine;
	}
	return `${singleLine.slice(0, maxLength - 1)}…`;
}

// ============================================================================
// Component
// ============================================================================

export function createQnATuiComponent(
	questions: NormalizedQuestion[],
	tui: ExtensionContext["ui"],
	done: (result: FormResult | null) => void,
	options?: {
		title?: string;
		description?: string;
		templates?: Template[];
		initialResponses?: QnAResponse[];
		onResponsesChange?: (responses: QnAResponse[]) => void;
		theme?: ExtensionContext["ui"]["theme"];
	},
) {
	const { theme } = tui;
	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("dim", s),
		selectList: {
			matchHighlight: (s) => theme.fg("accent", s),
			itemSecondary: (s) => theme.fg("muted", s),
		},
	};

	const editor = new Editor(tui as any, editorTheme);

	// State
	let currentIndex = 0;
	let cursorIdx = 0;
	let otherMode = false;
	let otherQuestionId: string | null = null;
	let editorMode = false; // For Ctrl+E append mode
	let templatePreviewMode = false;
	let showingConfirmation = false;
	let confirmPageSelection: "confirm" | "revisit" = "revisit";
	let confirmWarningShown = false;
	let templateIndex = 0;
	let cachedLines: string[] | undefined;

	// Answer stores
	const radioAnswers = new Map<string, FormAnswer>();
	const checkAnswers = new Map<string, Set<string>>();
	const checkCustom = new Map<string, string>();
	const textAnswers = new Map<string, string>();

	// Initialize responses
	const responses: QnAResponse[] = (options?.initialResponses ?? []).length > 0
		? [...options!.initialResponses!]
		: questions.map((_q, i) => ({
				selectedOptionIndex: 0,
				customText: "",
				selectionTouched: false,
				committed: false,
			}));

	// Initialize defaults from questions and draft responses
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
		// Initialize checkbox defaults from q.default (array of values) - this is the INITIAL default
		if (q.type === "checkbox") {
			const defaults = new Set<string>();
			if (Array.isArray(q.default)) {
				for (const v of q.default) defaults.add(v);
			}
			// If q.default is a single string (legacy/edge case), add it
			else if (typeof q.default === "string") {
				defaults.add(q.default);
			}
			checkAnswers.set(q.id, defaults);
			// Also initialize custom text from draft if selectionTouched
			if (r.customText && r.customText.trim()) {
				checkCustom.set(q.id, r.customText);
			}
		}
	}

	// Also restore draft state from responses (after initialization above) - only if touched
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const r = responses[i];

		// Text: restore from draft if customText exists and not already initialized
		if (q.type === "text" && r.customText) {
			// Only set if draft has content (regardless of whether default exists)
			textAnswers.set(q.id, r.customText);
		}
		// Radio: restore from draft if selectionTouched
		if (q.type === "radio" && r.selectionTouched) {
			const qOptions = q.options ?? [];
			const otherIndex = qOptions.length;
			if (r.selectedOptionIndex === otherIndex && r.customText) {
				radioAnswers.set(q.id, { id: q.id, type: "radio", value: r.customText, wasCustom: true });
			} else if (r.selectedOptionIndex < qOptions.length) {
				const opt = qOptions[r.selectedOptionIndex];
				if (opt) {
					radioAnswers.set(q.id, { id: q.id, type: "radio", value: opt.value, wasCustom: false });
				}
			}
		}
		// Checkbox: restore from draft if selectionTouched (NEW: add checkbox handling)
		if (q.type === "checkbox" && r.selectionTouched) {
			const qOptions = q.options ?? [];
			// Get or create the set
			const set = checkAnswers.get(q.id) ?? new Set<string>();
			// If "Other" is selected with custom text
			if (r.selectedOptionIndex === qOptions.length && r.customText) {
				checkCustom.set(q.id, r.customText);
			} else if (r.selectedOptionIndex < qOptions.length) {
				// Add the selected option to the set
				const opt = qOptions[r.selectedOptionIndex];
				if (opt) set.add(opt.value);
			}
			// NEW: Restore multi-select from selectedOptionIndices
			if (r.selectedOptionIndices && Array.isArray(r.selectedOptionIndices)) {
				for (const idx of r.selectedOptionIndices) {
					if (idx < qOptions.length) {
						const opt = qOptions[idx];
						if (opt) set.add(opt.value);
					}
				}
			}
			checkAnswers.set(q.id, set);
		}
	}

	// Helper functions
	const curQ = (): NormalizedQuestion | undefined => questions[currentIndex];

	const isAnswered = (q: NormalizedQuestion): boolean => {
		if (q.type === "radio") return radioAnswers.has(q.id);
		if (q.type === "checkbox") {
			const set = checkAnswers.get(q.id);
			const custom = checkCustom.get(q.id);
			return (set != null && set.size > 0) || (custom != null && custom.trim().length > 0);
		}
		if (q.type === "text") {
			return (textAnswers.get(q.id)?.trim() ?? "").length > 0;
		}
		return false;
	};

	const allRequired = (): boolean => {
		return questions.every((q) => !q.required || isAnswered(q));
	};

	const getUnansweredQuestions = (): number[] => {
		const unanswered: number[] = [];
		for (let i = 0; i < questions.length; i++) {
			if (!isAnswered(questions[i])) {
				unanswered.push(i);
			}
		}
		return unanswered;
	};

	const optionCount = (q: NormalizedQuestion): number => {
		if (q.type === "text") return 0;
		return q.options.length + (q.allowOther ? 1 : 0);
	};

	// Navigation
	const navigateTo = (index: number) => {
		if (index < 0 || index >= questions.length) return;
		saveCurrentResponse();
		currentIndex = index;
		cursorIdx = 0;
		otherMode = false;
		editorMode = false;
		templatePreviewMode = false;
		showingConfirmation = false;
		loadEditorForCurrentQuestion();
		invalidate();
	};

	const advanceTab = () => {
		if (currentIndex < questions.length - 1) {
			navigateTo(currentIndex + 1);
		} else {
			// Navigate to confirmation
			showingConfirmation = true;
			confirmWarningShown = false;
			const unanswered = getUnansweredQuestions();
			confirmPageSelection = unanswered.length > 0 ? "revisit" : "confirm";
			invalidate();
		}
	};

	const switchTab = (delta: number) => {
		const newIndex = ((currentIndex + delta) % questions.length + questions.length) % questions.length;
		navigateTo(newIndex);
	};

	// Editor handling
	const loadEditorForCurrentQuestion = () => {
		const q = curQ();
		if (!q) return;

		if (q.type === "text") {
			editor.setText(textAnswers.get(q.id) ?? "");
			return;
		}

		const otherIndex = q.options.length;
		const isOnOther = responses[currentIndex].selectedOptionIndex === otherIndex;
		const shouldUseEditor = isOnOther || editorMode;

		if (shouldUseEditor && q.allowOther) {
			// Get custom answer
			if (q.type === "radio") {
				const existing = radioAnswers.get(q.id);
				editor.setText(existing?.wasCustom ? (existing.value as string) : "");
			} else if (q.type === "checkbox") {
				editor.setText(checkCustom.get(q.id) ?? "");
			}
		} else {
			editor.setText("");
		}
	};

	const saveCurrentResponse = () => {
		const q = curQ();
		if (!q) return;

		if (q.type === "text") {
			const text = editor.getText().trim();
			if (text) textAnswers.set(q.id, text);
			else textAnswers.delete(q.id);

			if (text.trim().length > 0) {
				responses[currentIndex].selectionTouched = true;
			}
		} else if (q.type === "radio") {
			const qOptions = q.options ?? [];
			const otherIndex = qOptions.length;
			const isOnOther = responses[currentIndex].selectedOptionIndex === otherIndex;
			const shouldUseEditor = isOnOther || editorMode;

			if (shouldUseEditor && q.allowOther) {
				const custom = editor.getText().trim();
				if (custom) {
					radioAnswers.set(q.id, { id: q.id, type: "radio", value: custom, wasCustom: true });
				}
			} else {
				const selected = responses[currentIndex].selectedOptionIndex;
				if (selected < qOptions.length) {
					const opt = qOptions[selected];
					radioAnswers.set(q.id, { id: q.id, type: "radio", value: opt.value, wasCustom: false });
				}
			}

			if (responses[currentIndex].selectionTouched || editorMode) {
				responses[currentIndex].selectionTouched = true;
			}
		} else if (q.type === "checkbox") {
			// FIXED: Checkbox save logic - handle Other editor + multi-select persistence
			const isOnOther = responses[currentIndex].selectedOptionIndex === q.options.length;
			const shouldUseEditor = isOnOther || editorMode;

			if (shouldUseEditor && q.allowOther) {
				const custom = editor.getText().trim();
				if (custom) {
					checkCustom.set(q.id, custom);
				} else {
					checkCustom.delete(q.id);
				}
			}

			// NEW: Save selectedOptionIndices for multi-select checkbox persistence
			const currentSet = checkAnswers.get(q.id) ?? new Set<string>();
			const selectedIndices: number[] = [];
			for (let i = 0; i < q.options.length; i++) {
				if (currentSet.has(q.options[i].value)) {
					selectedIndices.push(i);
				}
			}
			if (selectedIndices.length > 0) {
				responses[currentIndex].selectedOptionIndices = selectedIndices;
			} else {
				delete responses[currentIndex].selectedOptionIndices;
			}

			if (responses[currentIndex].selectionTouched || editorMode) {
				responses[currentIndex].selectionTouched = true;
			}
		}

		options?.onResponsesChange?.(responses.map((r) => ({ ...r })));
	};

	const getCurrentAnswerText = (): string => {
		const q = curQ();
		if (!q) return "";

		if (q.type === "text") {
			return textAnswers.get(q.id) ?? "";
		}
		if (q.type === "radio") {
			const a = radioAnswers.get(q.id);
			return a ? (a.value as string) : "";
		}
		if (q.type === "checkbox") {
			const set = checkAnswers.get(q.id) ?? new Set<string>();
			const custom = checkCustom.get(q.id)?.trim();
			const values = [...set];
			if (custom) values.push(custom);
			return values.join(", ");
		}
		return "";
	};

	// Template preview
	const applyNextTemplate = () => {
		if (!options?.templates?.length) return;

		const q = curQ();
		if (!q) return;

		const template = options.templates[templateIndex];
		const currentAnswer = getCurrentAnswerText();

		const updated = applyTemplate(template.template, {
			question: q.prompt,
			context: q.label,
			answer: currentAnswer,
			index: currentIndex,
			total: questions.length,
		});

		editor.setText(updated);
		templatePreviewMode = true;

		templateIndex = (templateIndex + 1) % options.templates.length;
		invalidate();
	};

	// Submit
	const submit = () => {
		saveCurrentResponse();

		const answers: FormAnswer[] = [];
		for (const q of questions) {
			if (q.type === "radio") {
				const a = radioAnswers.get(q.id);
				answers.push({
					id: q.id,
					type: "radio",
					value: a?.value ?? "",
					wasCustom: a?.wasCustom ?? false,
				});
			} else if (q.type === "checkbox") {
				const set = checkAnswers.get(q.id) ?? new Set<string>();
				const custom = checkCustom.get(q.id)?.trim();
				const values = [...set];
				if (custom) values.push(custom);
				answers.push({ id: q.id, type: "checkbox", value: values, wasCustom: !!custom });
			} else {
				const t = textAnswers.get(q.id) ?? "";
				answers.push({ id: q.id, type: "text", value: t, wasCustom: true });
			}
		}

		done({
			questions,
			answers,
			cancelled: false,
			title: options?.title,
			description: options?.description,
		});
	};

	const cancel = () => {
		done(null);
	};

	// Invalidation
	const invalidate = () => {
		cachedLines = undefined;
		tui.requestRender();
	};

	// Handle input
	const handleInput = (data: string) => {
		// Confirmation page
		if (showingConfirmation) {
			if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
				confirmPageSelection = confirmPageSelection === "confirm" ? "revisit" : "confirm";
				invalidate();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (confirmPageSelection === "revisit") {
					const unanswered = getUnansweredQuestions();
					showingConfirmation = false;
					confirmWarningShown = false;
					navigateTo(unanswered.length > 0 ? unanswered[0] : 0);
					return;
				}

				// Confirm All
				const unanswered = getUnansweredQuestions();
				if (unanswered.length > 0 && !confirmWarningShown) {
					confirmWarningShown = true;
					invalidate();
					return;
				}

				// Second Enter or no unanswered - proceed
				submit();
				return;
			}

			if (matchesKey(data, Key.escape)) {
				showingConfirmation = false;
				navigateTo(questions.length - 1);
				invalidate();
				return;
			}

			if (matchesKey(data, Key.ctrl("c"))) {
				cancel();
				return;
			}

			return;
		}

		// Global cancel
		if (matchesKey(data, Key.ctrl("c"))) {
			cancel();
			return;
		}

		// FIXED: Handle Shift+Enter for newline in text inputs
		// From answer/index.ts:718
		if (matchesKey(data, Key.shift("enter"))) {
			editor.handleInput("\n");
			invalidate();
			return;
		}

		// Ctrl+T for templates
		if (matchesKey(data, Key.ctrl("t"))) {
			applyNextTemplate();
			return;
		}

		// Ctrl+E for append mode
		if (matchesKey(data, Key.ctrl("e"))) {
			const q = curQ();
			if (q && q.type !== "text" && (q.options?.length ?? 0) > 0) {
				// Keep current selection, just enable editor for appending
				const currentAnswer = getCurrentAnswerText();
				editor.setText(currentAnswer);
				editorMode = true;
				invalidate();
			}
			return;
		}

		// Escape - exit modes
		if (matchesKey(data, Key.escape)) {
			if (editorMode) {
				saveCurrentResponse();
				editorMode = false;
				editor.setText("");
				invalidate();
				return;
			}
			if (templatePreviewMode) {
				templatePreviewMode = false;
				loadEditorForCurrentQuestion();
				invalidate();
				return;
			}
			return;
		}

		// Tab navigation (circular)
		if (matchesKey(data, Key.tab)) {
			saveCurrentResponse();
			if (currentIndex < questions.length - 1) {
				navigateTo(currentIndex + 1);
			} else {
				navigateTo(0);
			}
			invalidate();
			return;
		}

		// Shift+Tab navigation (circular backward)
		if (matchesKey(data, Key.shift("tab"))) {
			saveCurrentResponse();
			if (currentIndex > 0) {
				navigateTo(currentIndex - 1);
			} else {
				navigateTo(questions.length - 1);
			}
			invalidate();
			return;
		}

		const q = curQ();
		if (!q) return;

		// In "Other" mode or editor mode
		if (otherMode || (q.type !== "text" && (editorMode || q.allowOther))) {
			const isInOther = otherMode || responses[currentIndex].selectedOptionIndex === q.options.length;

			if (q.type !== "text" && isInOther) {
				// Handle Other editor
				if (matchesKey(data, Key.enter)) {
					saveCurrentResponse();
					otherMode = false;
					editorMode = false;
					editor.setText("");
					advanceTab();
					return;
				}

				// Tab in Other mode
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
					saveCurrentResponse();
					otherMode = false;
					editorMode = false;
					switchTab(matchesKey(data, Key.shift("tab")) ? -1 : 1);
					return;
				}

				editor.handleInput(data);
				invalidate();
				return;
			}
		}

		// Text question
		if (q.type === "text") {
			if (matchesKey(data, Key.enter)) {
				saveCurrentResponse();
				advanceTab();
				return;
			}
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
				saveCurrentResponse();
				switchTab(matchesKey(data, Key.shift("tab")) ? -1 : 1);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				cancel();
				return;
			}
			editor.handleInput(data);
			invalidate();
			return;
		}

		// Arrow navigation for options
		const total = optionCount(q);
		if (matchesKey(data, Key.up)) {
			cursorIdx = Math.max(0, cursorIdx - 1);
			invalidate();
			return;
		}
		if (matchesKey(data, Key.down)) {
			cursorIdx = Math.min(total - 1, cursorIdx + 1);
			invalidate();
			return;
		}

		// Radio select with Enter
		if (q.type === "radio" && matchesKey(data, Key.enter)) {
			const isOther = q.allowOther && cursorIdx === q.options.length;
			if (isOther) {
				otherMode = true;
				otherQuestionId = q.id;
				const existing = radioAnswers.get(q.id);
				editor.setText(existing?.wasCustom ? (existing.value as string) : "");
				invalidate();
				return;
			}

			const opt = q.options[cursorIdx];
			if (opt) {
				radioAnswers.set(q.id, { id: q.id, type: "radio", value: opt.value, wasCustom: false });
				responses[currentIndex].selectedOptionIndex = cursorIdx;
				responses[currentIndex].selectionTouched = true;
				advanceTab();
			}
			return;
		}

		// FIXED: Checkbox toggle with Space (full implementation from askusertool.ts)
		if (q.type === "checkbox" && matchesKey(data, Key.space)) {
			const isOther = q.allowOther && cursorIdx === q.options.length;
			if (isOther) {
				otherMode = true;
				otherQuestionId = q.id;
				editor.setText(checkCustom.get(q.id) ?? "");
				invalidate();
				return;
			}

			const opt = q.options[cursorIdx];
			if (opt) {
				const set = checkAnswers.get(q.id) ?? new Set<string>();
				if (set.has(opt.value)) {
					set.delete(opt.value);
				} else {
					set.add(opt.value);
				}
				checkAnswers.set(q.id, set);
				// Mark as touched so we know user has interacted
				responses[currentIndex].selectionTouched = true;
				invalidate();
			}
			return;
		}

		// Checkbox Enter to advance
		if (q.type === "checkbox" && matchesKey(data, Key.enter)) {
			advanceTab();
			return;
		}

		// Typing a key selects Other and starts editor (for radio/checkbox)
		if (q.type !== "text" && data.length === 1 && data.charCodeAt(0) >= 32) {
			const totalOpts = optionCount(q);
			// Select Other option (last one)
			responses[currentIndex].selectedOptionIndex = totalOpts - 1;
			responses[currentIndex].selectionTouched = true;
			editorMode = true;
			editor.handleInput(data);
			invalidate();
			return;
		}
	};

	// Render
	const render = (width: number): string[] => {
		if (cachedLines) return cachedLines;

		const lines: string[] = [];
		const maxW = Math.min(width, 120);

		const hr = () => lines.push(theme.fg("dim", "─".repeat(maxW)));
		const add = (s: string) => lines.push(truncateToWidth(s, maxW));

		hr();

		// FIXED: Title and description (from askusertool.ts:552-558)
		if (options?.title) {
			add(` ${theme.fg("accent", theme.bold(options.title))}`);
		}
		if (options?.description) {
			add(` ${theme.fg("muted", options.description)}`);
		}
		if (options?.title || options?.description) lines.push("");

		// Progress indicators (askusertool style: ● current, ✓ answered, ○ unanswered)
		const progressParts: string[] = [];
		for (let i = 0; i < questions.length; i++) {
			const current = i === currentIndex;
			const answered = isAnswered(questions[i]);
			if (current) {
				progressParts.push(theme.fg("accent", SYM.currentDot));
			} else if (answered) {
				progressParts.push(theme.fg("success", SYM.answeredCheck));
			} else {
				progressParts.push(theme.fg("dim", SYM.unansweredDot));
			}
		}
		add(` ${progressParts.join(" ")}`);

		if (!showingConfirmation && curQ()) {
			const q = curQ()!;

			lines.push("");

			// Question label
			if (q.label) {
				add(` ${theme.fg("accent", theme.bold(q.label))}`);
			}

			// Question prompt
			const typeTag = q.type === "radio"
				? theme.fg("dim", "[single-select]")
				: q.type === "checkbox"
					? theme.fg("dim", "[multi-select]")
					: theme.fg("dim", "[text]");

			const promptLines = wrapText(q.prompt, maxW - 2);
			for (let i = 0; i < promptLines.length; i++) {
				const isLast = i === promptLines.length - 1;
				add(` ${theme.fg("text", promptLines[i])}${isLast ? ` ${typeTag}` : ""}`);
			}

			if (q.required) {
				add(` ${theme.fg("warning", "*required")}`);
			}

			lines.push("");

			// Options
			if (q.type === "radio" || q.type === "checkbox") {
				const selected = q.type === "radio" ? radioAnswers.get(q.id) : null;
				const isRadio = q.type === "radio";

				for (let i = 0; i < q.options.length; i++) {
					const opt = q.options[i];
					const isCursor = i === cursorIdx;
					let isSelected = false;

					if (isRadio && selected?.value === opt.value && !selected.wasCustom) {
						isSelected = true;
					} else if (!isRadio) {
						const set = checkAnswers.get(q.id) ?? new Set<string>();
						isSelected = set.has(opt.value);
					}

					const box = isRadio
						? (isSelected ? theme.fg("accent", SYM.radioOn) : theme.fg("dim", SYM.radioOff))
						: (isSelected ? theme.fg("accent", SYM.checkOn) : theme.fg("dim", SYM.checkOff));
					const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";

					const prefix = ` ${pointer} ${box} `;
					const prefixWidth = visibleWidth(prefix);
					const labelLines = wrapText(opt.label, Math.max(1, maxW - prefixWidth));
					const color = isCursor ? "accent" : isSelected ? "text" : "muted";

					for (let li = 0; li < labelLines.length; li++) {
						const linePrefix = li === 0 ? prefix : " ".repeat(prefixWidth);
						add(`${linePrefix}${theme.fg(color, labelLines[li])}`);
					}

					// Show descriptions for all options (like askusertool.ts)
					if (opt.description) {
						const descLines = wrapText(opt.description, Math.max(1, maxW - 6));
						for (const dl of descLines) {
							add(`      ${theme.fg("dim", dl)}`);
						}
					}
				}

				// Other option
				if (q.allowOther) {
					const isCursor = cursorIdx === q.options.length;
					const isSelected = q.type === "radio"
						? (selected?.wasCustom ?? false)
						: (!!checkCustom.get(q.id)?.trim());

					const box = isSelected
						? theme.fg("accent", isRadio ? SYM.radioOn : SYM.checkOn)
						: theme.fg("dim", isRadio ? SYM.radioOff : SYM.checkOff);
					const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";

					const customValue = q.type === "radio"
						? (selected?.wasCustom ? selected.value : "")
						: checkCustom.get(q.id);
					const label = customValue ? `Other: ${customValue}` : "Other...";

					const prefix = ` ${pointer} ${box} `;
					const prefixWidth = visibleWidth(prefix);
					const labelLines = wrapText(label, Math.max(1, maxW - prefixWidth));
					const color = isCursor ? "accent" : "muted";

					for (let li = 0; li < labelLines.length; li++) {
						const linePrefix = li === 0 ? prefix : " ".repeat(prefixWidth);
						add(`${linePrefix}${theme.fg(color, labelLines[li])}`);
					}
				}

				// Show editor for Other
				if ((otherMode || editorMode) && q.allowOther) {
					lines.push("");
					add(` ${theme.fg("muted", "  Your answer:")}`);
					for (const line of editor.render(maxW - 6)) {
						add(`   ${line}`);
					}
				}
			}

			// Text input
			if (q.type === "text") {
				if (q.placeholder && !editor.getText()) {
					add(` ${theme.fg("dim", q.placeholder)}`);
				}
				for (const line of editor.render(maxW - 4)) {
					add(`  ${line}`);
				}
			}

			lines.push("");

			// Footer hints (with Shift+Enter hint for text)
			const sep = theme.fg("dim", " · ");
			const fmt = (shortcut: string, action: string) => `${theme.bold(shortcut)} ${theme.italic(action)}`;

			const hints: string[] = [];
			hints.push(fmt("Tab", "next"));
			hints.push(fmt("⇧Tab", "prev"));
			hints.push(fmt("Enter", "select"));

			if (q.type !== "text") {
				hints.push(fmt("↑↓", "navigate"));
				hints.push(fmt("Space", "toggle"));
				hints.push(fmt("Ctrl+E", "append"));
			}
			if (q.type === "text") {
				hints.push(fmt("⇧Enter", "newline"));
				hints.push(fmt("Esc", "cancel"));
			}
			if (options?.templates?.length) {
				hints.push(fmt("Ctrl+T", templatePreviewMode ? "next" : "template"));
			}

			add(theme.fg("dim", ` ${hints.join(sep)}`));
		}

		// Confirmation page
		if (showingConfirmation) {
			lines.push("");

			const unanswered = getUnansweredQuestions();
			const hasUnanswered = unanswered.length > 0;

			if (confirmWarningShown && hasUnanswered) {
				add(theme.fg("warning", theme.bold(`⚠ ${unanswered.length} question${unanswered.length > 1 ? "s" : ""} not answered`)));
				const missingQ = unanswered.map((i) => questions[i].prompt).join(", ");
				add(theme.fg("warning", `Missing: ${truncateToWidth(missingQ, maxW - 10)}`));
				lines.push("");
			}

			add(theme.fg("accent", theme.bold("Review your answers:")));

			for (let i = 0; i < questions.length; i++) {
				const q = questions[i];
				let answerText = "";

				if (q.type === "radio") {
					const a = radioAnswers.get(q.id);
					answerText = a ? (a.value as string) : "";
				} else if (q.type === "checkbox") {
					const set = checkAnswers.get(q.id) ?? new Set<string>();
					const custom = checkCustom.get(q.id)?.trim();
					const values = [...set];
					if (custom) values.push(custom);
					answerText = values.join(", ");
				} else {
					answerText = textAnswers.get(q.id) ?? "";
				}

				const hasAnswer = answerText.trim().length > 0;
				// FIXED: Use summarizeAnswer for truncation
				const displayText = hasAnswer ? summarizeAnswer(answerText, maxW - 25) : "(no answer)";
				const marker = hasAnswer ? theme.fg("success", "●") : theme.fg("warning", "●");

				add(`  ${marker} ${theme.fg("accent", q.label || `Q${i + 1}`)}: ${displayText}`);
			}

			lines.push("");

			const confirmSelected = confirmPageSelection === "confirm";
			const revisitSelected = confirmPageSelection === "revisit";

			const marker = (selected: boolean) => selected ? theme.fg("accent", "▶") : " ";
			const label = (selected: boolean, text: string) => selected ? theme.fg("accent", theme.bold(text)) : text;

			add(`${marker(confirmSelected)} ${label(confirmSelected, "Confirm All")}`);
			add(`${marker(revisitSelected)} ${label(revisitSelected, "Revisit Questions")}`);

			lines.push("");
			add(theme.fg("dim", ` ${theme.bold("↑↓")} select · ${theme.bold("Enter")} confirm · ${theme.bold("Esc")} go back`));
		}

		hr();
		cachedLines = lines;
		return lines;
	};

	// Initialize
	loadEditorForCurrentQuestion();

	return {
		render,
		invalidate,
		handleInput,
	};
}

// Helper: simple word wrap
function wrapText(text: string, maxWidth: number): string[] {
	const words = text.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (!current) {
			current = word;
		} else if (current.length + 1 + word.length <= maxWidth) {
			current += ` ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}

	if (current) lines.push(current);
	return lines.length ? lines : [""];
}