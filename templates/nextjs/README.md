# Origin-AI Wiring (Next.js)

This directory contains the common plumbing for calling `origin-ai` from Next.js tools.

## Requirements

Ensure the following environment variables are set (see `.env.example.snippet`):

- `ORIGIN_AI_URL`: Base URL of the origin-ai service.
- `ORIGIN_AI_API_KEY`: Internal API key for authentication.

## Usage

### Pattern A: Chat Invocation (User Input)

Use `invokeChat` for direct user-to-AI chat.

```tsx
import { invokeChat } from '@/lib/origin-ai';

const result = await invokeChat("Hello AI");
console.log(result.message);
```

Or use the provided component:

```tsx
import { OriginAiChatInput, OriginAiResult } from '@/components/origin-ai';

// ... in your component
const [result, setResult] = useState(null);
const [error, setError] = useState(null);

<OriginAiChatInput 
  onSuccess={setResult} 
  onError={setError} 
/>
<OriginAiResult result={result} error={error} />
```

### Pattern B: Workflow Invocation (Buttons/Events)

Use `invokeWorkflow` for structured tasks.

```tsx
import { invokeWorkflow } from '@/lib/origin-ai';

const result = await invokeWorkflow("analyze-data", { id: 123 });
console.log(result.result);
```

Or use the provided component:

```tsx
import { OriginAiButton } from '@/components/origin-ai';

<OriginAiButton 
  workflowId="analyze-data" 
  data={{ id: 123 }} 
  onSuccess={(res) => console.log(res)}
/>
```

## Error Handling

All calls throw subclasses of `OriginAiError`. 
The `OriginAiResult` component handles these errors and displays user-friendly messages.

## UI Resilience (v7 §2.7)

Two-layer defense for any subtree that displays origin-core master data
(products, users, groups, etc):

1. **UR-1 (SDK)** — null-safe / typed fallback in fetchers (handled by the SDK; out of scope here).
2. **UR-2 (UI)** — wrap render targets with `<CoreDataBoundary>` and add page-level
   `error.tsx` for App Router routes. See `components/resilience/README.md`.

Quick start:

```tsx
import { CoreDataBoundary } from '@/components/resilience';

<CoreDataBoundary sectionLabel="商品マスタ" resetKeys={[query.data?.updatedAt]}>
  <ProductMasterTable products={query.data} />
</CoreDataBoundary>
```

For App Router pages that fetch Core data in a Server Component, **also** copy
`components/resilience/error-template.tsx` into that route as `error.tsx`. Place at
the individual page level — not at the root layout (that defeats blast-radius
containment).

UR-3 verification cases (orphan reference + type mismatch) live in
`__tests__/resilience/error-boundary.test.tsx`.

## Phase 7 Extension Points

This plumbing is designed to be extended in Phase 7:
- **Streaming**: `invokeChatStream` will be added for SSE support.
- **Workflow IDs**: A central `WORKFLOW_IDS` constant will be introduced in `lib/origin-ai/index.ts`.
- **Agent Names**: A central `AGENT_NAMES` constant will be introduced for chat routing.
- **Monitoring**: `logger.ts` can be updated to send logs to external monitoring services.

## Security & Privacy

- **API Keys**: Never logged. Only the first 6 characters are shown in debug logs if necessary.
- **Payload Logging**: Disabled by default. Enable with `ORIGIN_AI_LOG_PAYLOAD=true` for development.
