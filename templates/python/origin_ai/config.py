import os
from .errors import OriginAiConfigError

def get_config():
    origin_ai_url = os.getenv("ORIGIN_AI_URL")
    origin_ai_api_key = os.getenv("ORIGIN_AI_API_KEY")
    
    if not origin_ai_url:
        raise OriginAiConfigError("ORIGIN_AI_URL is not set")
    if not origin_ai_api_key:
        raise OriginAiConfigError("ORIGIN_AI_API_KEY is not set")

    # Normalize URL: remove trailing slash
    origin_ai_url = origin_ai_url.rstrip("/")

    # Default timeouts (ms)
    chat_timeout = int(os.getenv("ORIGIN_AI_TIMEOUT_MS_CHAT", "90000"))
    workflow_timeout = int(os.getenv("ORIGIN_AI_TIMEOUT_MS_WORKFLOW", "270000"))
    
    # Tool Name estimation
    tool_name = os.getenv("ORIGIN_AI_TOOL_NAME")
    if not tool_name:
        # Fallback to current directory name or some default
        tool_name = os.path.basename(os.getcwd())

    return {
        "ORIGIN_AI_URL": origin_ai_url,
        "ORIGIN_AI_API_KEY": origin_ai_api_key,
        "TIMEOUT_MS": {
            "chat": chat_timeout,
            "workflow": workflow_timeout,
        },
        "TOOL_NAME": tool_name,
    }
