import uuid
from typing import Dict
from .config import get_config

def get_auth_headers(trace_id: str | None = None) -> Dict[str, str]:
    config = get_config()
    
    headers = {
        "X-Internal-API-Key": config["ORIGIN_AI_API_KEY"],
        "X-Tool-Name": config["TOOL_NAME"],
        "X-Request-Id": trace_id or str(uuid.uuid4()),
        "Content-Type": "application/json",
    }
    
    return headers
