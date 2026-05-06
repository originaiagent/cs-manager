# Origin AI Python Plumbing

Common library for calling `origin-ai` from Python (Streamlit/FastAPI) tools.

## Requirements

- Python 3.10+
- `httpx`
- `streamlit` (optional, for UI helpers)

## Installation

Add the following to your `requirements.txt`:

```text
httpx
# streamlit (optional)
```

And copy the `origin_ai/` directory to your project root.

## Configuration

Set the following environment variables:

| Variable | Required | Description |
|---|---|---|
| `ORIGIN_AI_URL` | ✅ | Base URL of origin-ai |
| `ORIGIN_AI_API_KEY` | ✅ | Internal API Key |
| `ORIGIN_AI_TOOL_NAME` | 任意 | Label for this tool (defaults to directory name) |
| `ORIGIN_AI_LOG_PAYLOAD`| 任意 | Set to `true` to log request/response bodies (PII Caution) |

## Usage

### 1. Chat Pattern (invoke_chat)

Used for direct user-to-AI interaction.

```python
from origin_ai import invoke_chat

try:
    result = invoke_chat("What is the status of project X?")
    print(f"AI: {result.message}")
    print(f"Trace ID: {result.trace_id}")
except Exception as e:
    print(f"Error: {e}")
```

### 2. Workflow Pattern (invoke_workflow)

Used for structured tool execution.

```python
from origin_ai import invoke_workflow

data = {
    "projectId": "123",
    "analysisType": "deep"
}

try:
    result = invoke_workflow("project-analysis", data)
    print(f"Result: {result.result}")
except Exception as e:
    print(f"Workflow failed: {e}")
```

### 3. Streamlit UI Helpers

```python
import streamlit as st
from origin_ai import origin_ai_chat_ui, origin_ai_workflow_button

# Chat UI
origin_ai_chat_ui()

# Workflow Button
origin_ai_workflow_button(
    label="Run Analysis",
    workflow_id="project-analysis",
    data={"id": "123"}
)
```

## Error Handling

All exceptions inherit from `OriginAiError`.

- `OriginAiConfigError`: Missing env vars.
- `OriginAiAuthError`: 401/403 (Invalid API Key).
- `OriginAiTimeoutError`: Request timed out (Chat: 90s, Workflow: 270s).
- `OriginAiNetworkError`: DNS/Connection issues (auto-retried 2 times).
- `OriginAiServerError`: 5xx errors (auto-retried 1 time).

## UI Resilience (v7 §2.7)

Two-layer defense for any Streamlit page that displays origin-core master data:

1. **UR-1 (SDK)** — null-safe / typed fallback in fetchers (handled by the SDK).
2. **UR-2 (UI)** — wrap render blocks with `safe_section()` (preferred) or
   `@safe_render` (small leaf widgets only).

Quick start:

```python
import streamlit as st
from origin_ai import safe_section, invoke_workflow

with safe_section("商品マスタ"):
    products = invoke_workflow("list-products", {}).result
    st.dataframe(products)  # crash here -> friendly fallback + 最新化 button
```

Why prefer `safe_section` over `@safe_render`? Streamlit lays out columns/expanders
inline. Wrapping a layout-heavy function with a decorator can leave half the layout
rendered on failure. `safe_section` scopes the boundary to a clearly delimited block.

UR-3 verification cases (orphan reference + type mismatch) live in
`tests/test_resilience.py`.

## Extension Points (Phase 7)

- **Workflow Definitions**: Structured constants for workflow IDs and payload types.
- **Agent Names**: Constants for specific agent personalities.
- **Streaming**: Support for SSE streaming in `invoke_chat`.
- **Metrics**: Exporting logs to Cloud Logging / Monitoring.
