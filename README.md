# pi-answr

Interactive Q&A bridge for the Pi coding agent that converts unstructured questions from LLMs into structured TUI forms.

## Overview

When an LLM sends a message containing multiple questions, traditional chat requires manual text replies that are error-prone and tedious. pi-answr extracts those questions and renders an interactive terminal form, ensuring the LLM receives exactly the data format it needs.

## Features

- **Question Extraction** — Uses remote LLMs to parse unstructured text into structured question schemas
- **Interactive TUI Forms** — Terminal UI with keyboard navigation for radio, checkbox, and text inputs
- **Draft Autosave** — Responses are persisted automatically to prevent data loss during long forms
- **Questionnaire Restoration** — Reopen the last questionnaire with `/answer:again`
- **Tool Integration** — LLMs can trigger forms directly via the `ask_user_question` tool
- **Template System** — Configurable answer formatting templates

## Installation

```bash
pi install git:https://github.com/k0valik/pi-answr
```

Restart Pi if already running.

## Commands

### `/answer`

Extracts questions from the last assistant message and displays an interactive form.

1. Finds the most recent assistant message in the session branch
2. Sends the message to an extraction model (configured in settings)
3. Parses the JSON response into a question schema
4. Renders the TUI form
5. On submit, formats answers and sends back to the chat

Implemented in `index.ts`:
- `answerHandler()` — Main command handler (lines ~295-380)
- `selectExtractionModel()` from `extraction.ts` — Model selection logic

### `/answer:again`

Reopens the last questionnaire without re-extracting. Prompts to restore previous answers if drafts exist.

1. Attempts to reconstruct cache from session entries
2. Prompts user to restore saved answers
3. Re-renders the form with prior responses filled in

Implemented in `index.ts`:
- `answerAgainHandler()` — Lines ~420-510

## Tool: `ask_user_question`

LLMs can invoke this tool directly to request structured user input. Registered only if `toolEnabled: true` in settings.

### Parameters

| Field | Type | Description |
|-------|------|-------------|
| `title` | string? | Form title |
| `description` | string? | Brief context |
| `questions` | array | Array of question objects |

### Question Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `type` | "radio" / "checkbox" / "text" | Input type |
| `prompt` | string | Question text |
| `label` | string? | Short label for progress |
| `options` | array? | For radio/checkbox |
| `allowOther` | boolean? | Add "Other..." option |
| `required` | boolean? | Is answer required |
| `placeholder` | string? | Placeholder for text input |
| `default` | string / string[]? | Pre-selected values |

### Option Object

```json
{
  "value": "postgres",
  "label": "PostgreSQL",
  "description": "Best for relational data"
}
```

### Return Format

Answers are returned as formatted text:

```
Q1: Database: postgres
Q2: Languages: typescript, rust
Q3: Project Name: my-cool-app
```

Or if cancelled: `User cancelled the form`

Implemented in `index.ts`:
- Tool registration — `pi.registerTool()` block (lines ~175-290)
- `execute()` function — Form rendering and result formatting
- Input schema defined via `AskUserQuestionParams` (lines ~140-155)

## Configuration

- See example.config.json

Add an `answer` block to your `settings.json`:

```json
{
  "answer": {
    "toolEnabled": true,
    "extractionModels": [
      { "provider": "openai-codex", "id": "gpt-5.4-mini" },
      { "provider": "github-copilot", "id": "gpt-5.4-mini" },
      { "provider": "anthropic", "id": "claude-haiku-4-5" }
    ],
    "extractionTimeoutMs": 30000,
    "debugNotifications": false,
    "answerTemplates": [
      { "label": "Q&A", "template": "Q{{index}}: {{question}}\nA: {{answer}}" },
      { "label": "Concise", "template": "{{question}}: {{answer}}" }
    ],
    "drafts": {
      "enabled": true,
      "autosaveMs": 1000,
      "promptOnRestore": true
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `toolEnabled` | boolean | `true` | Enable the ask_user_question tool |
| `extractionModels` | array | (see below) | Models used for extraction, sensible defaults below, doesn't break main conversation prompt cache |
| `extractionTimeoutMs` | number | `30000` | Extraction timeout in ms |
| `debugNotifications` | boolean | `false` | Show tool error notifications |
| `answerTemplates` | array | [] | Custom answer formatting templates |
| `drafts.enabled` | boolean | `true` | Enable draft autosave |
| `drafts.autosaveMs` | number | `1000` | Autosave delay in ms |
| `drafts.promptOnRestore` | boolean | `true` | Prompt before restoring drafts |

Default extraction models (`DEFAULT_MODEL_PREFERENCES` in `extraction.ts`):

```typescript
[
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "github-copilot", "id": "gpt-5.4-mini" },
  { provider: "anthropic", id: "claude-haiku-4-5" }
]
```

Settings are read from (in order of precedence):

1. Project: `./.pi/agent/settings.json`
2. Global: `~/.pi/agent/settings.json`

Implemented in `index.ts`:
- `loadAnswerSettings()` — Settings loading with caching (lines ~95-130)
- `getAnswerSettingsPaths()` — Path resolution

## Architecture

### Modules

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, commands, tool registration |
| `extraction.ts` | LLM extraction logic, model selection |
| `schema.ts` | Question schemas, normalization, parsing |
| `templates.ts` | Answer formatting templates |
| `drafts.ts` | Auto-save draft persistence |
| `tui.ts` | Terminal UI component |

### Extraction Flow

1. User runs `/answer`
2. `answerHandler()` finds the last assistant message
3. `selectExtractionModel()` picks an available model from preferences
4. Message sent to model with `DEFAULT_SYSTEM_PROMPT` (extraction.ts)
5. Model returns JSON with question schema
6. `parseExtractionResult()` parses JSON (schema.ts)
7. Questions normalized via `normalizeQuestions()` (schema.ts)
8. TUI form rendered
9. Answers formatted and sent as chat message

### Schema Normalization

`schema.ts` provides the core data model:

- `UnifiedQuestion` — Raw question from extraction or tool params
- `NormalizedQuestion` — Fully typed question for TUI
- `normalizeQuestions()` — Converts raw input to normalized form
- `parseExtractionResult()` — Parses LLM JSON response

### Draft System

Implemented in `drafts.ts`:

- `createDraftStore()` — Creates a draft persistence store
- `getLatestDraftForEntry()` — Retrieves saved draft
- `getInitialResponses()` — Restores responses from draft
- `deriveAnswersFromResponses()` — Converts TUI responses to answer strings

Drafts are stored as session entries with type `answer:draft`.

## Summary Tab / Confirmation Flow

When a user completes all questions and presses `Tab` once more, they reach the Summary tab (the final position in the tab order).

The Summary page displays:

1. **All answers reviewed** — Shows every question with its answer (or "(no answer)" if unanswered)
2. **Two selection options**:
   - "Confirm All" — Submit the form
   - "Revisit Questions" — Go back to a specific unanswered question

### Unanswered Question Detection

Before submission, the form checks for unanswered questions with `getUnansweredQuestions()` (tui.ts). If questions are marked `required: true` and left blank:

1. First press of `Enter` shows a warning banner: `⚠ X question(s) not answered`
2. Second press of `Enter` proceeds with submission anyway
3. Pressing `Up/Down` to select "Revisit Questions" navigates directly to the first unanswered question

The progress indicator shows:
- `[●]` — Current question
- `[✓]` — Answered and confirmed (pressed Enter)
- `[○]` — Answered (selected but not confirmed)
- `[ ]` — Unanswered

Navigation in Summary:
- `↑/↓` — Toggle between Confirm All and Revisit Questions
- `Enter` — Confirm selection
- `Esc` — Go back to last question
- `Esc Esc` — Direct jump to first unanswered question
- `Tab` — Cycle back to first question

Implemented in `tui.ts`:
- `showingConfirmation` state variable
- `confirmPageSelection` — "confirm" or "revisit"
- `confirmWarningShown` — controls warning display
- `getUnansweredQuestions()` (lines ~170-177) — scans for required-but-empty questions
- `submit()` (lines ~310-330) — final submission handler

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Next question (wraps to first) |
| `Shift+Tab` | Previous question (wraps to last) |
| `Up/Down` | Cycle through options |
| `Enter` | Confirm / Submit (two-step) |
| `Ctrl+T` | Cycle answer templates |
| `Escape` | Go back |
| `Space`  | Select checkbox |
| `Ctrl+C` or `Escape twice` | Cancel form |

## Templates

Answer templates use variable substitution:

| Variable | Description |
|----------|-------------|
| `{{question}}` | Question text |
| `{{context}}` | Optional context/header |
| `{{answer}}` | User's answer |
| `{{index}}` | Question number (1-based) |
| `{{total}}` | Total questions |

Example template:

```
{{index}}. {{question}}
   Answer: {{answer}}
```

Renders as:

```
1. Which color do you prefer?
   Answer: blue
```

Implemented in `templates.ts`:
- `normalizeTemplates()` — Parses template configuration
- `applyTemplate()` — Variable substitution

## Error Handling

| Condition | LLM Receives |
|------------|--------------|
| UI not available | `"Error: UI not available"` |
| No questions provided | `"Error: No questions provided"` |
| User cancels | `"User cancelled the form"` |

## Requirements

- Pi coding agent (latest version)
- At least one model configured in `~/.pi/agent/models.json`