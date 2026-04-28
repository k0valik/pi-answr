## How the LLM Sees the `ask_user_question` Tool

### 1. Tool Registration (What the LLM Sees)

```markdown
Name: ask_user_question
Label: Ask User
Description:
  Ask the user one or more questions using an interactive form. Supports:
  - radio: Single-select from options
  - checkbox: Multi-select from options
  - text: Free-form text input

  Each question can include an "Other..." option for custom input.

Prompt Snippet:
  Ask the user interactive questions with radio, checkbox, or text inputs

Prompt Guidelines (hints for the LLM):
  - Use ask_user_question instead of asking questions in plain text when you need structured user input.
  - Prefer radio for single-choice, checkbox for multi-choice, text for open-ended answers.
  - Always include an 'Other' escape hatch (allowOther: true) unless the options are exhaustive.
```

---

### 2. Tool Parameters (What the LLM Must Provide)

```typescript
{
  title?: string,           // Form title (optional)
  description?: string,    // Brief context (optional)
  questions: [
    {
      id: string,              // Unique ID (required)
      type: "radio"|"checkbox"|"text"  // Question type (required)
      prompt: string,         // Question text (required)
      label?: string,         // Short label for progress (optional)
      options?: [              // For radio/checkbox (optional)
        {
          value: string,      // Return value (e.g., "postgres")
          label: string,      // Display label (e.g., "PostgreSQL")
          description?: string  // Help text (optional)
        }
      ],
      allowOther?: boolean,    // Add "Other..." option (default: true)
      required?: boolean,      // Is answer required (default: true)
      placeholder?: string,   // Placeholder for text input
      default?: string | string[]  // Pre-selected values
    }
  ]
}
```

---

### 3. Example Tool Call from LLM

```json
{
  "name": "ask_user_question",
  "parameters": {
    "title": "Project Setup",
    "questions": [
      {
        "id": "database",
        "type": "radio",
        "prompt": "Which database would you like to use?",
        "label": "Database",
        "options": [
          { "value": "postgres", "label": "PostgreSQL", "description": "Best for relational data" },
          { "value": "mongodb", "label": "MongoDB", "description": "Best for document storage" },
          { "value": "sqlite", "label": "SQLite", "description": "Lightweight file-based DB" }
        ],
        "allowOther": true
      },
      {
        "id": "languages",
        "type": "checkbox",
        "prompt": "Select all programming languages you know:",
        "label": "Languages",
        "options": [
          { "value": "typescript", "label": "TypeScript" },
          { "value": "python", "label": "Python" },
          { "value": "rust", "label": "Rust" }
        ]
      },
      {
        "id": "project_name",
        "type": "text",
        "prompt": "What is your project name?",
        "label": "Project Name",
        "placeholder": "my-awesome-project"
      }
    ]
  }
}
```

---

### 4. Return Format (What the LLM Receives)

```text
Q1: Database: postgres
Q2: Languages: typescript, rust
Q3: Project Name: my-cool-app
```

Or if user cancelled:
```text
User cancelled the form
```

---

### 5. Error Handling (Failure Modes)

| Error Condition | What LLM Receives | How User Knows |
|----------------|-------------------|---------------|
| `toolEnabled: false` in settings | Tool not registered (invisible) | N/A |
| `!ctx.hasUI` | `"Error: UI not available"` | Debug notification (if enabled) |
| `params.questions.length === 0` | `"Error: No questions provided"` | Debug notification (if enabled) |
| User presses Esc/cancels | `"User cancelled the form"` | TUI closes |

---

### 6. Guidelines for the LLM

The tool provides `promptGuidelines` hints:
- Use for structured input, not plain text questions
- Choose correct type: `radio` (single), `checkbox` (multi), `text` (free)
- Always include `allowOther: true` unless options are truly exhaustive (lets user type custom answer)