import time
import httpx
import random
from typing import Any, Dict, Optional
from dataclasses import dataclass

from .config import get_config
from .auth import get_auth_headers
from .errors import (
    OriginAiAuthError,
    OriginAiTimeoutError,
    OriginAiNetworkError,
    OriginAiServerError,
    OriginAiClientError,
    OriginAiUnknownError,
)
from .logger import log_api_call

@dataclass
class ChatResult:
    message: str
    structured_output: Optional[Dict[str, Any]]
    skill_used: Optional[Dict[str, str]]
    trace_id: str
    duration_ms: float

@dataclass
class WorkflowResult:
    result: str
    session_id: Optional[str]
    trace_id: str
    duration_ms: float

def _get_client():
    return httpx.Client()

def _request_with_retry(
    method: str,
    url: str,
    headers: Dict[str, str],
    json_data: Any,
    timeout_ms: int,
    pattern: str,
) -> httpx.Response:
    max_network_retries = 2
    max_5xx_retries = 1
    
    network_retry_count = 0
    server_retry_count = 0
    
    trace_id = headers.get("X-Request-Id")
    tool_name = headers.get("X-Tool-Name")
    
    start_time = time.time()
    
    while True:
        try:
            with _get_client() as client:
                response = client.request(
                    method,
                    url,
                    headers=headers,
                    json=json_data,
                    timeout=timeout_ms / 1000.0,
                )
            
            duration_ms = (time.time() - start_time) * 1000
            
            if response.is_success:
                log_api_call(pattern, url, "success", duration_ms, trace_id, tool_name)
                return response
            
            # Handle Errors
            status_code = response.status_code
            if status_code in (401, 403):
                log_api_call(pattern, url, "error", duration_ms, trace_id, tool_name, "auth_error")
                raise OriginAiAuthError("Authentication failed", status=status_code, trace_id=trace_id, response_body=response.text)
            
            if 500 <= status_code < 600:
                if server_retry_count < max_5xx_retries:
                    server_retry_count += 1
                    _sleep_with_backoff(server_retry_count)
                    continue
                log_api_call(pattern, url, "error", duration_ms, trace_id, tool_name, "server_error")
                raise OriginAiServerError(f"Server error: {status_code}", status=status_code, trace_id=trace_id, response_body=response.text)
            
            # Other 4xx
            log_api_call(pattern, url, "error", duration_ms, trace_id, tool_name, "client_error")
            raise OriginAiClientError(f"Client error: {status_code}", status=status_code, trace_id=trace_id, response_body=response.text)

        except httpx.TimeoutException:
            duration_ms = (time.time() - start_time) * 1000
            log_api_call(pattern, url, "error", duration_ms, trace_id, tool_name, "timeout_error")
            raise OriginAiTimeoutError("Request timed out", trace_id=trace_id)
        
        except httpx.NetworkError as e:
            if network_retry_count < max_network_retries:
                network_retry_count += 1
                _sleep_with_backoff(network_retry_count)
                continue
            duration_ms = (time.time() - start_time) * 1000
            log_api_call(pattern, url, "error", duration_ms, trace_id, tool_name, "network_error")
            raise OriginAiNetworkError(f"Network error: {str(e)}", trace_id=trace_id)
        
        except Exception as e:
            if isinstance(e, (OriginAiAuthError, OriginAiTimeoutError, OriginAiNetworkError, OriginAiServerError, OriginAiClientError)):
                raise
            duration_ms = (time.time() - start_time) * 1000
            log_api_call(pattern, url, "error", duration_ms, trace_id, tool_name, "unknown_error")
            raise OriginAiUnknownError(f"Unexpected error: {str(e)}", trace_id=trace_id)

def _sleep_with_backoff(retry_count: int):
    # 1s -> 2s (exponential) + jitter ±200ms
    base_delay = 2 ** (retry_count - 1)
    jitter = random.uniform(-0.2, 0.2)
    time.sleep(max(0, base_delay + jitter))

def invoke_chat(
    message: str,
    *,
    timeout_ms: Optional[int] = None,
    trace_id: Optional[str] = None,
    user_id: Optional[str] = None,
) -> ChatResult:
    """
    Pattern A: Chat invocation. ユーザー文字列をそのまま origin-ai に送る。

    Phase 7 契約依存:
      - endpoint path (/api/chat/sync) と payload shape ({ message }) は
        bf9cc6e2 (origin-ai 大掃除) 完了後に最終確認・調整が必要。
      - SSE streaming 対応は Phase 7 で invoke_chat_stream として追加予定。
    """
    config = get_config()
    headers = get_auth_headers(trace_id)
    url = f"{config['ORIGIN_AI_URL']}/api/chat/sync"

    payload: Dict[str, Any] = {"message": message}
    # user_id は X-User-Id ヘッダで送る (起動規約: payload は加工しない)
    if user_id:
        headers["X-User-Id"] = user_id

    start_time = time.time()
    response = _request_with_retry(
        "POST",
        url,
        headers=headers,
        json_data=payload,
        timeout_ms=timeout_ms or config["TIMEOUT_MS"]["chat"],
        pattern="chat",
    )
    duration_ms = (time.time() - start_time) * 1000

    data = response.json()
    return ChatResult(
        message=data.get("message", ""),
        structured_output=data.get("structured_output") or data.get("structuredOutput"),
        skill_used=data.get("skill_used") or data.get("skillUsed"),
        trace_id=headers["X-Request-Id"],
        duration_ms=duration_ms,
    )

def invoke_workflow(
    workflow_id: str,
    data: Dict[str, Any],
    *,
    timeout_ms: Optional[int] = None,
    trace_id: Optional[str] = None,
) -> WorkflowResult:
    """
    Pattern B: Workflow invocation. ワークフローID + 構造化 JSON を送る。

    Phase 7 契約依存:
      - endpoint path (/api/managed-agent/run) と payload shape は
        bf9cc6e2 完了後に最終確認・調整が必要。
    """
    config = get_config()
    headers = get_auth_headers(trace_id)
    url = f"{config['ORIGIN_AI_URL']}/api/managed-agent/run"

    payload = {
        "workflow_id": workflow_id,
        "data": data,
    }

    start_time = time.time()
    response = _request_with_retry(
        "POST",
        url,
        headers=headers,
        json_data=payload,
        timeout_ms=timeout_ms or config["TIMEOUT_MS"]["workflow"],
        pattern="workflow",
    )
    duration_ms = (time.time() - start_time) * 1000

    resp_data = response.json()
    return WorkflowResult(
        result=resp_data.get("result", ""),
        session_id=resp_data.get("session_id") or resp_data.get("sessionId"),
        trace_id=headers["X-Request-Id"],
        duration_ms=duration_ms,
    )
