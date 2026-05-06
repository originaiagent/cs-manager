import json
import logging
import os
import time
from typing import Any

class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        log_record = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "message": record.getMessage(),
            "module": record.module,
            "funcName": record.funcName,
        }
        if hasattr(record, "extra_fields"):
            log_record.update(record.extra_fields)
        
        # PII Protection: mask origin_ai_api_key if accidentally passed
        if "origin_ai_api_key" in log_record:
            key = log_record["origin_ai_api_key"]
            if key and len(key) > 6:
                log_record["origin_ai_api_key"] = f"{key[:6]}..."
            else:
                log_record["origin_ai_api_key"] = "***"

        return json.dumps(log_record, ensure_ascii=False)

def get_logger(name: str = "origin_ai") -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    return logger

logger = get_logger()

def log_api_call(
    pattern: str,
    endpoint: str,
    status: str,
    duration_ms: float,
    trace_id: str | None = None,
    tool_name: str | None = None,
    error_code: str | None = None,
    payload: Any | None = None,
):
    extra = {
        "pattern": pattern,
        "endpoint": endpoint,
        "status": status,
        "duration_ms": round(duration_ms, 2),
        "trace_id": trace_id,
        "tool_name": tool_name,
        "error_code": error_code,
    }
    
    # 機微情報の取扱: ORIGIN_AI_LOG_PAYLOAD=true の時のみペイロードを記録
    if os.getenv("ORIGIN_AI_LOG_PAYLOAD") == "true" and payload is not None:
        extra["payload"] = payload

    logger.info(f"Origin AI API {pattern} call {status}", extra={"extra_fields": extra})
