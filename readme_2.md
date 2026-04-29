# pi-answr

Interactive Q&A bridge for pi-coding-agent that converts text-based questions into structured TUI forms.

* **Structured Inputs**: Replaces manual text replies with radio buttons, checkboxes, and text fields.
* **Auto-Extraction**: Uses remote LLMs to parse questions directly from your chat history.
* **Resilient Workflows**: Features automatic draft saving and session-aware questionnaire restoration.

---

### 🟢 What this is / What it is not

**What it is:**
* A productivity tool for handling complex multi-question prompts from an AI assistant.
* A bridge between unstructured chat and structured tool inputs.
* A persistent state manager for user responses within a session.

**What it is not:**
* A general-purpose UI framework for the terminal.
* An autonomous agent that answers questions for you.
* A replacement for the standard chat interface.

**Problem it solves:**
When an LLM asks five questions at once, replying manually is tedious and error-prone. **pi-answr** extracts those questions and presents a validated form, ensuring the LLM gets the exact data format it needs.

---

### ⚡ Quick Start

1. **Install** the extension:
   `pi install npm:pi-answr`
2. **Chat** with your assistant until it asks you questions.
3. **Run** the command:
   `/answer`
4. **Complete** the form and submit.

---

### 🛠️ Installation / Setup

**Prerequisites:**
* `pi-coding-agent` installed and configured.
* Valid API keys for at least one extraction provider (OpenAI, Anthropic, or GitHub Copilot).

**Step-by-step setup:**
1. Open your terminal in a `pi-coding-agent` project.
2. Run `pi install npm:pi-answr` (or use the git repository URL).
3. Ensure your `settings.json` has the necessary model provider configurations.

---

### 🚀 Usage

* **If you want to extract questions from the last message:**
  Run `/answer` in the chat. This triggers the remote extractor to build a form.
* **If you accidentally closed a form or want to change answers:**
  Run `/answer:again` to restore the last questionnaire with your progress saved.
* **If you are a developer using this as a tool:**
  The assistant can call `ask_user_question` directly to trigger the UI without manual commands.

---

### ✨ Features

* **Interactive TUI Forms**: High-performance terminal interface for fast navigation.
* **Remote Extraction**: Intelligent parsing of unstructured text into form fields.
* **Draft Autosave**: Periodically saves your input to prevent data loss during long forms.
* **Custom Templates**: Format how your answers are sent back to the assistant.
* **Multiple Input Types**: Supports radio (single-choice), checkbox (multi-choice), and free text.

---

### 🧩 How it works (high-level)

1. **Detection**: When `/answer` is called, the extension sends the last assistant message to a high-reasoning model.
2. **Parsing**: The model returns a structured JSON schema of all identified questions.
3. **Rendering**: The TUI component builds an interactive form based on that schema.
4. **Submission**: Once submitted, answers are formatted via templates and injected back into the chat as a user message.

---

### ⚙️ Configuration

Add an `answer` block to your `settings.json` (global or project-level):

```json
{
  "answer": {
    "toolEnabled": true,
    "extractionTimeoutMs": 30000,
    "drafts": {
      "enabled": true,
      "autosaveMs": 1000
    }
  }
}
```

* **toolEnabled**: Allows the LLM to trigger forms automatically.
* **autosaveMs**: Frequency of draft persistence in milliseconds.

---

### ⚠️ Limitations / Known Issues

* **Interactive Mode Only**: This extension will not function in non-interactive or "headless" environments.
* **Extraction Dependency**: The quality of `/answer` depends on the reasoning capability of the extraction model.
* **Context Size**: Very large assistant messages may occasionally be truncated during extraction.

---

### 📝 Examples

**Input (Assistant Message):**
> "I can help set up your project. Should I use PostgreSQL or MongoDB? Also, do you want me to include a Dockerfile?"

**Output (Extension Form):**
* **Database**: ( ) PostgreSQL ( ) MongoDB
* **Include Dockerfile**: [X] Yes

**Final Sent Answer:**
> Q1: Database: postgres
> Q2: Include Dockerfile: yes

---

### 🤝 Contributing
Briefly: Issues and PRs are welcome on the project repository. Please ensure all tests pass (`npm test`) before submitting changes.

### 📜 License
MIT[cite: 5, 7, 9]