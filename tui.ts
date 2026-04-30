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
 * - Ctrl+Shift+Enter: insert newline in text inputs
 * - Escape: cancel / go back
 * - Ctrl+E: append to current answer (without switching to Other)
 * - Ctrl+T: cycle templates (preview)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, visibleWidth, type TUI, type Theme } from "@mariozechner/pi-tui";
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
	ctx: { ui: TUI; theme?: { fg: (color: string, text: string) => string; bold?: (text: string) => string } },
	done: (result: FormResult | null) => void,
	options?: {
		title?: string;
		description?: string;
		templates?: Template[];
		initialResponses?: QnAResponse[];
		onResponsesChange?: (responses: QnAResponse[]) => void;
	},
) {
	const tui = ctx.ui;
	const theme = ctx.theme!;
	if (!theme) {
		throw new Error("theme is required in ctx.theme");
	}
	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("dim", s),
		selectList: {
		// @ts-expect-error - matchHighlight is a custom property not in pi-tui types
	matchHighlight: (s) => theme.fg("accent", s),
			itemSecondary: (s) => theme.fg("muted", s),
		},
	};

	const editor = new Editor(tui as any, editorTheme);
	editor.disableSubmit = true;
	editor.onChange = () => {
		saveCurrentResponse();
		invalidate();
		tui.requestRender();
	};

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
	let lastEscapeTime = 0;
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

	// Should use editor for current question (from legacy answer/index.ts)
	const shouldUseEditor = (): boolean => {
		const q = curQ();
		if (!q) return false;
		if (q.type === "text") return true;
		const options = q.options ?? [];
		const otherIndex = options.length;
		// Check both selected index AND cursor position (for Other option handling)
		const isOnOther = responses[currentIndex].selectedOptionIndex === otherIndex || cursorIdx === otherIndex;
		return isOnOther || editorMode;
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
		// If on last question, go to confirmation
		if (currentIndex < questions.length - 1) {
			navigateTo(currentIndex + 1);
		} else if (!showingConfirmation) {
			// Navigate to confirmation page
			showingConfirmation = true;
			confirmWarningShown = false;
			const unanswered = getUnansweredQuestions();
			confirmPageSelection = unanswered.length > 0 ? "revisit" : "confirm";
			 invalidate();
		} else {
			// Already on confirmation, cycle back to first question
			showingConfirmation = false;
			navigateTo(0);
		}
	};

	const switchTab = (delta: number) => {
		// Position: questions are 0..N-1, Summary is at position N
		const currentPos = showingConfirmation ? questions.length : currentIndex;
		let newIndex = currentPos + delta;
		
		// Total positions: 0..questions.length (questions + Summary)
		const totalTabs = questions.length + 1;
		if (newIndex < 0) {
			newIndex = totalTabs - 1; // Wrap to Summary
		} else if (newIndex >= totalTabs) {
			newIndex = 0; // Wrap to Q1
		}
		
		// Navigate based on position
		if (newIndex >= questions.length) {
			// Going to Summary
			showingConfirmation = true;
			confirmWarningShown = false;
			const unanswered = getUnansweredQuestions();
			confirmPageSelection = unanswered.length > 0 ? "revisit" : "confirm";
			// Save current response if we were on a question
			if (currentPos < questions.length) {
				saveCurrentResponse();
			}
			invalidate();
			return;
		}
		
		// Navigating to a question
		if (showingConfirmation) {
			saveCurrentResponse();
		}
		showingConfirmation = false;
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
		// Restore editor mode if there was a custom answer OR if was in editor mode
		let shouldRestoreEditor = editorMode;
		if (!shouldRestoreEditor && q.allowOther) {
			// Check if previous answer was custom
			if (q.type === "radio") {
				const existing = radioAnswers.get(q.id);
				shouldRestoreEditor = existing?.wasCustom ?? false;
			} else if (q.type === "checkbox") {
				const customText = checkCustom.get(q.id);
				shouldRestoreEditor = !!customText?.trim();
			}
		}

		if (shouldRestoreEditor && q.allowOther) {
			// Get custom answer
			if (q.type === "radio") {
				const existing = radioAnswers.get(q.id);
				editor.setText(existing?.wasCustom ? (existing.value as string) : "");
			} else if (q.type === "checkbox") {
				editor.setText(checkCustom.get(q.id) ?? "");
			}
			// Restore editor mode so the editor is shown
			editorMode = true;
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
			// Only save if user explicitly selected (touched)
			if (responses[currentIndex].selectionTouched) {
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
			}
			// Mark as touched if user pressed enter or moved selection
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
			const values = Array.from(set);
			if (custom) values.push(custom);
			return values.join(", ");
		}
		return "";
	};

	// Get labels (for display) instead of values (for API)
	const getCurrentAnswerLabels = (): string => {
		const q = curQ();
		if (!q) return "";

		if (q.type === "text") {
			return textAnswers.get(q.id) ?? "";
		}
		if (q.type === "radio") {
			const a = radioAnswers.get(q.id);
			if (a) {
				const opt = q.options.find(o => o.value === a.value);
				return opt?.label ?? (a.value as string);
			}
			return "";
		}
		if (q.type === "checkbox") {
			const set = checkAnswers.get(q.id) ?? new Set<string>();
			const custom = checkCustom.get(q.id)?.trim();
			const labels = Array.from(set).map(v => {
				const opt = q.options.find(o => o.value === v);
				return opt?.label ?? v;
			});
			if (custom) labels.push(custom);
			return labels.join(", ");
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
				const values = Array.from(set);
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
		(tui as { requestRender?: () => void }).requestRender?.();
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
				const now = Date.now();
				// Double escape within 500ms goes to Revisit Questions
				if (now - lastEscapeTime < 500) {
					const unanswered = getUnansweredQuestions();
					showingConfirmation = false;
					confirmWarningShown = false;
					navigateTo(unanswered.length > 0 ? unanswered[0] : 0);
					lastEscapeTime = 0;
					invalidate();
					return;
				}
				lastEscapeTime = now;
				showingConfirmation = false;
				navigateTo(questions.length - 1);
				invalidate();
				return;
			}

			// Tab cycling in confirmation page - allow cycling through summary
			if (matchesKey(data, Key.tab)) {
				switchTab(1);
				invalidate();
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				switchTab(-1);
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

		// Ctrl+Shift+Enter for newline (linux terminal default)
		if (matchesKey(data, Key.ctrlShift("enter")) || matchesKey(data, Key.altShift("enter")) || matchesKey(data, Key.shift("enter"))) {
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
				// Get labels for display (for Ctrl+E append feature)
				let currentAnswer = getCurrentAnswerLabels();
				if (!currentAnswer) {
					// Use current cursor position as fallback (use label, not value)
					const opt = q.options[cursorIdx];
					if (opt) currentAnswer = opt.label;
				}
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

		// Tab navigation - cycle through questions AND summary
		if (matchesKey(data, Key.tab)) {
			saveCurrentResponse();
			switchTab(1);
			invalidate();
			return;
		}

		// Shift+Tab navigation - cycle backward including summary
		if (matchesKey(data, Key.shift("tab"))) {
			saveCurrentResponse();
			switchTab(-1);
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

				// Escape in Other mode - exit editor
				if (matchesKey(data, Key.escape)) {
					saveCurrentResponse();
					otherMode = false;
					editorMode = false;
					editor.setText("");
					invalidate();
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
			// Shift+Enter handled globally above with shouldUseEditor check

			if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
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
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const prevIdx = cursorIdx;
			if (matchesKey(data, Key.up)) {
				cursorIdx = Math.max(0, cursorIdx - 1);
			} else {
				cursorIdx = Math.min(total - 1, cursorIdx + 1);
			}
			// Mark as touched if user moved from default position
			if (prevIdx !== cursorIdx) {
				if (prevIdx === 0) {
					responses[currentIndex].selectedOptionIndex = cursorIdx;
				}
				responses[currentIndex].selectionTouched = true;
			}
			invalidate();
			return;
		}

		// Shift+Enter for newline - MUST check before Enter handlers
		if (matchesKey(data, Key.shift("enter"))) {
			editor.handleInput("\n");
			invalidate();
			return;
		}

		// Radio select with Enter
		if (q.type === "radio" && matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
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
				// Update selectedOptionIndices for persistence
				const selectedIndices: number[] = [];
				for (let i = 0; i < q.options.length; i++) {
					if (set.has(q.options[i].value)) {
						selectedIndices.push(i);
					}
				}
				if (selectedIndices.length > 0) {
					responses[currentIndex].selectedOptionIndices = selectedIndices;
				} else {
					delete responses[currentIndex].selectedOptionIndices;
				}
				invalidate();
			}
			return;
		}

		// Checkbox Enter to advance
		if (q.type === "checkbox" && matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			saveCurrentResponse();
			advanceTab();
			return;
		}

		// Typing a key selects Other and starts editor (for radio/checkbox)
		// @ts-expect-error - intentional guard for non-text types
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
		// Use full terminal width (capped at 120 for very wide terminals)
		const maxW = Math.min(width, 120);

		// Box width: match terminal but cap at 120
		const boxWidth = Math.min(width - 4, 120);
		const contentWidth = boxWidth - 4;

		const horizontalLine = (count: number) => "─".repeat(count);

		// Strip trailing ellipsis from text (for user input display)
		const stripEllipsis = (s: string) => s.replace(/\.{3,} *$/, "");

		// Boxed container helpers (from legacy answer)
		const boxLine = (content: string, leftPad: number = 2): string => {
			// Truncate content first to prevent breaking the box
			const safeContent = truncateToWidth(content, contentWidth);
			const paddedContent = " ".repeat(leftPad) + safeContent;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return theme.fg("dim", "│") + paddedContent + " ".repeat(rightPad) + theme.fg("dim", "│");
		};

		const emptyBoxLine = (): string => {
			return theme.fg("dim", "│") + " ".repeat(boxWidth - 2) + theme.fg("dim", "│");
		};

		// Simple add helper for flexible content
		const add = (s: string) => {
			lines.push(boxLine(truncateToWidth(s, contentWidth)));
		};

		// Boxed container - TOP
		lines.push(theme.fg("dim", `╭${horizontalLine(boxWidth - 2)}╮`));

		// Title
		if (options?.title) {
			const title = `${options.title} ${theme.fg("dim", `(${currentIndex + 1}/${questions.length})`)}`;
			lines.push(boxLine(title));
			lines.push(theme.fg("dim", `├${horizontalLine(boxWidth - 2)}┤`));
		}

		// Progress indicators with brackets and delimiter
		const progressParts: string[] = [];
		for (let i = 0; i < questions.length; i++) {
			const current = !showingConfirmation && i === currentIndex;
			const answered = isAnswered(questions[i]);
			const committed = responses[i].committed;
			if (current) {
				// Current question - cyan
				progressParts.push(theme.fg("accent", "[●]"));
			} else if (committed) {
				// Committed (submitted with Enter) - green checkmark
				progressParts.push(theme.fg("success", "[✓]"));
			} else if (answered) {
				// Answered but not submitted - green
				progressParts.push(theme.fg("success", "[●]"));
			} else {
				// Unanswered - dim/yellow
				progressParts.push(theme.fg("dim", "[○]"));
			}
		}
		// Add Summary tab
		if (showingConfirmation) {
			progressParts.push(theme.fg("accent", theme.bold("[Summary]")));
		} else {
			progressParts.push(theme.fg("dim", "[Summary]"));
		}

		// Join with middle dot delimiter
		const withDelim = progressParts.join(theme.fg("dim", " · "));
		lines.push(boxLine(withDelim));

		if (!showingConfirmation && curQ()) {
			const q = curQ()!;

			lines.push(emptyBoxLine());

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

			lines.push(emptyBoxLine());

				// Options with numbered labels (from legacy answer)
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
						: (isSelected ? theme.fg("success", SYM.checkOn) : theme.fg("dim", SYM.checkOff));
					const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";

					// Add numbered prefix (1. Option A)
					const optionPrefix = `${pointer} ${box} ${i + 1}. `;
					const prefixWidth = visibleWidth(optionPrefix);
					const labelLines = wrapText(opt.label, Math.max(1, contentWidth - prefixWidth));
					const color = isCursor ? "accent" : isSelected ? "text" : "muted";

					for (let li = 0; li < labelLines.length; li++) {
						const linePrefix = li === 0 ? optionPrefix : " ".repeat(prefixWidth);
						lines.push(boxLine(`${linePrefix}${theme.fg(color, labelLines[li])}`));
					}

					// Show description only when selected (from legacy answer)
				if (isSelected && opt.description && opt.description.trim().length > 0) {
						const descriptionIndent = " ".repeat(prefixWidth);
						const descLines = wrapText(opt.description, Math.max(10, contentWidth - prefixWidth));
						for (const dl of descLines) {
							lines.push(boxLine(`${descriptionIndent}${theme.fg("dim", dl)}`));
						}
					}
				}

				// Other option
				if (q.allowOther) {
					const isCursor = cursorIdx === q.options.length;
					// Checkbox Other is selected if cursor is on it OR has custom text
					const hasCustom = q.type === "checkbox" ? (!!checkCustom.get(q.id)?.trim() || isCursor) : (selected?.wasCustom ?? false);
					const isSelected = isCursor || hasCustom;

					// Use success for checkbox selected, accent for radio
					const checkColor = isSelected ? "success" : "dim";
					const box = isSelected
						? theme.fg(checkColor, isRadio ? SYM.radioOn : SYM.checkOn)
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
					lines.push(emptyBoxLine());
					add(theme.fg("muted", "  Your answer:"));
					for (const line of editor.render(maxW - 6)) {
						add(`   ${stripEllipsis(line)}`);
					}
				}
			}

			// Text input
			if (q.type === "text") {
				if (q.placeholder && !editor.getText()) {
					add(` ${theme.fg("dim", q.placeholder)}`);
				}
				for (const line of editor.render(maxW - 4)) {
					add(`  ${stripEllipsis(line)}`);
				}
			}

			lines.push(emptyBoxLine());

			// Footer hints (with all keybindings)
			const sep = theme.fg("dim", " · ");
			const fmt = (shortcut: string, action: string) => `${theme.bold(shortcut)} ${theme.italic(action)}`;

			const hints: string[] = [];
			hints.push(fmt("Tab", "next"));
			hints.push(fmt("⇧Tab", "prev"));
			hints.push(fmt("Enter", "select"));
			hints.push(fmt("↑↓", "navigate"));

			if (q.type !== "text") {
				hints.push(fmt("Space", "toggle"));
				hints.push(fmt("Ctrl+E", "append"));
			}
			if (q.type === "text") {
				hints.push(fmt("Ctrl+⇧Enter", "newline"));
			}
			hints.push(fmt("Esc", "cancel"));
			hints.push(fmt("Ctrl+C", "exit"));

			if (options?.templates?.length) {
				hints.push(fmt("Ctrl+T", templatePreviewMode ? "next" : "template"));
			}

			add(theme.fg("dim", ` ${hints.join(sep)}`));
		}

		// Confirmation page
		if (showingConfirmation) {
			lines.push(emptyBoxLine());

			const unanswered = getUnansweredQuestions();
			const hasUnanswered = unanswered.length > 0;

			if (confirmWarningShown && hasUnanswered) {
				add(theme.fg("warning", theme.bold(`⚠ ${unanswered.length} question${unanswered.length > 1 ? "s" : ""} not answered`)));
				const missingQ = unanswered.map((i) => questions[i].prompt).join(", ");
				add(theme.fg("warning", `Missing: ${truncateToWidth(missingQ, maxW - 10)}`));
				lines.push(emptyBoxLine());
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
					const values = Array.from(set);
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

			lines.push(emptyBoxLine());

			const confirmSelected = confirmPageSelection === "confirm";
			const revisitSelected = confirmPageSelection === "revisit";

			const marker = (selected: boolean) => selected ? theme.fg("accent", "▶") : " ";
			const label = (selected: boolean, text: string) => selected ? theme.fg("accent", theme.bold(text)) : text;

			add(`${marker(confirmSelected)} ${label(confirmSelected, "Confirm All")}`);
			add(`${marker(revisitSelected)} ${label(revisitSelected, "Revisit Questions")}`);

			lines.push(emptyBoxLine());
			add(theme.fg("dim", ` ${theme.bold("↑↓")} select · ${theme.bold("Enter")} confirm · ${theme.bold("Esc")} go back · ${theme.bold("Esc Esc")} revisit`));
		}

		// Boxed container - BOTTOM
		lines.push(theme.fg("dim", `╰${horizontalLine(boxWidth - 2)}╯`));

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