# pi-answer

Unified Q&A extension that lets LLMs ask users structured questions interactively.

- **Commands**: `/answer` extracts questions from the last assistant message; `/answer:again` restores the previous questionnaire
- **Tool**: `ask_user_question` tool lets LLMs directly request radio, checkbox, or text input
- **Auto-save**: Answers are saved automatically and can be resumed

## What This Is / What It Is Not

**What it solves:**
- LLMs cannot ask users multiple questions in one turn—they typically get one response
- This extension splits a multi-question intent into an interactive form the user can answer all at once

**Who it is for:**
- Developers using the Pi coding agent who want structured back-and-forth with the LLM
- Extension authors building tools that need user input before proceeding

**What it is not:**
- Not a general-purpose form builder
- Not a database or storage system (drafts are session-scoped only)

## Quick Start

```bash
# Install via Pi's extension manager
pi ext install pi-answr
```

Restart Pi if already running, then use:

- `/answer` — Extract and ask questions from the last assistant message
- `/answer:again` — Reopen the last questionnaire
- The `ask_user_question` tool is available to LLMs automatically when enabled

## Installation / Setup

### Prerequisites

- Pi coding agent (latest version)
- At least one model configured in `~/.pi/agent/models.json`

### Configuration

The extension reads settings from your global or project settings file:

1. **Global**: `~/.pi/agent/settings.json`
2. **Project**: `./.pi/settings.json`

Project settings override global ones. Add config under the `answer:` key:

```json
{
  "answer": {
    "toolEnabled": true,
    "debugNotifications": false
  }
}
```

See `example.config.json` for all available options.

### Enable/Disable

The tool is enabled by default. To disable the `ask_user_question` tool while keeping commands:

```json
{
  "answer": {
    "toolEnabled": false
  }
}
```

## Usage

### /answer — Extract from Assistant Message

1. The LLM sends a message with questions
2. Type `/answer`
3. The extension extracts questions and shows an interactive form
4. User answers each question
5. Answers are sent back as a chat message

### /answer:again — Resume Previous Questionnaire

1. Type `/answer:again`
2. If previous answers exist, you are asked to restore them
3. The same form reopens with your prior answers (if restored)
4. Submit new answers

### ask_user_question Tool — LLM-Initiated Questions

The LLM calls this tool directly. Example arguments:

```json
{
  "title": "Choose a color",
  "description": "Select your preferred theme color",
  "questions": [
    {
      "id": "color",
      "type": "radio",
      "prompt": "Which color do you prefer?",
      "options": [
        { "value": "blue", "label": "Blue" },
        { "value": "green", "label": "Green" }
      ]
    }
  ]
}
```

Returns formatted answers:

```
Q1: color: blue
```

The LLM sees this tool with:
- Name: `ask_user_question`
- Supports: `radio` (single-select), `checkbox` (multi-select), `text` (free-form)
- Each question needs: `id`, `type`, `prompt`

## Features

- **`/answer`** — Extract questions from the last assistant message
- **`/answer:again`** — Reopen the last questionnaire
- **`ask_user_question` tool** — LLM calls this to request user input
- **Question types** — radio, checkbox, text with options support
- **Auto-save** — Answers are saved and can be resumed
- **Draft restore** — Prompts to restore saved answers on `/answer:again`
- **Templates** — Predefined answer formats (Q&A, Concise, Numbered)

## How It Works (High-Level)

1. **Extraction** (`/answer`): The LLM's last message is sent to a selected extraction model, which returns a question schema. The extension renders these as an interactive TUI form.

2. **Tool execution** (`ask_user_question`): The LLM passes a question schema directly to the tool. The extension normalizes it and renders the form. Answers return as formatted text.

3. **Draft system**: Answers are auto-saved to a draft store. On `/answer:again`, the form reopens with saved values if the user confirms.

4. **Return format**: Answers return as `Q{number}: {label}: {value}` for easy parsing.

## Configuration

| Option | Type | Default | Description |
|--------|------|--------|-------------|
| `toolEnabled` | boolean | `true` | Enable the ask_user_question tool |
| `extractionModels` | array | GPT-5.4-mini, Copilot, Claude | Models to use for question extraction |
| `extractionTimeoutMs` | number | `30000` | Timeout for extraction in ms |
| `debugNotifications` | boolean | `false` | Show tool error notifications |
| `answerTemplates` | array | Q&A, Concise, Numbered | Answer formatting templates |
| `drafts.enabled` | boolean | `true` | Enable auto-save drafts |
| `drafts.autosaveMs` | number | `1000` | Delay before saving |
| `drafts.promptOnRestore` | boolean | `true` | Prompt before restoring drafts |

Override in `settings.json` under `answer:`. See `example.config.json` for full reference.

## Examples

### 1. LLM asks for a choice

Input (LLM calls ask_user_question):
```json
{
  "title": "Confirm deployment",
  "questions": [
    {
      "id": "env",
      "type": "radio",
      "prompt": "Which environment?",
      "options": [
        { "value": "staging", "label": "Staging" },
        { "value": "production", "label": "Production" }
      ]
    }
  ]
}
```

Output:
```
Q1: env: staging
```

### 2. User runs /answer on LLM response

LLM: "Should I add error handling? Should I add tests? Should I update docs?"

User runs `/answer` → form shows three checkboxes → user selects → answers sent as message.

### 3. Resume with /answer:again

User previously answered `/answer`, then closed. Run `/answer:again` → prompts to restore → form reopens with prior answers filled in.