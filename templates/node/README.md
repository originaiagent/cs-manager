# Origin-AI Node.js Plumbing

Common plumbing for invoking `origin-ai` from Node.js applications.

## Usage

### 1. Environment Variables
Add the following to your `.env`:
```env
ORIGIN_AI_URL=https://your-origin-ai-instance.vercel.app
ORIGIN_AI_API_KEY=your-internal-api-key
```

### 2. Invoke Chat (Pattern A)
```typescript
import { invokeChat } from './lib/origin-ai';

const response = await invokeChat("Hello AI!");
console.log(response.message);
```

### 3. Invoke Workflow (Pattern B)
```typescript
import { invokeWorkflow } from './lib/origin-ai';

const result = await invokeWorkflow("my-workflow-id", { inputData: "value" });
console.log(result.result);
```
