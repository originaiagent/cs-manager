import typing as t

class OriginAiError(Exception):
    """Base exception for all Origin AI errors."""
    def __init__(
        self,
        message: str,
        code: str = "unknown_error",
        status: int | None = None,
        trace_id: str | None = None,
        response_body: str | None = None,
    ):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.trace_id = trace_id
        self.response_body = response_body

class OriginAiConfigError(OriginAiError):
    """Raised when environment variables are missing or invalid."""
    def __init__(self, message: str):
        super().__init__(message, code="config_error")

class OriginAiAuthError(OriginAiError):
    """Raised on 401/403 errors."""
    def __init__(self, message: str, status: int, trace_id: str | None = None, response_body: str | None = None):
        super().__init__(message, code="auth_error", status=status, trace_id=trace_id, response_body=response_body)

class OriginAiTimeoutError(OriginAiError):
    """Raised when the request times out."""
    def __init__(self, message: str, trace_id: str | None = None):
        super().__init__(message, code="timeout_error", trace_id=trace_id)

class OriginAiNetworkError(OriginAiError):
    """Raised on network-level issues (DNS, connection refused, etc.)."""
    def __init__(self, message: str, trace_id: str | None = None):
        super().__init__(message, code="network_error", trace_id=trace_id)

class OriginAiServerError(OriginAiError):
    """Raised on 5xx errors."""
    def __init__(self, message: str, status: int, trace_id: str | None = None, response_body: str | None = None):
        super().__init__(message, code="server_error", status=status, trace_id=trace_id, response_body=response_body)

class OriginAiClientError(OriginAiError):
    """Raised on 4xx errors other than 401/403."""
    def __init__(self, message: str, status: int, trace_id: str | None = None, response_body: str | None = None):
        super().__init__(message, code="client_error", status=status, trace_id=trace_id, response_body=response_body)

class OriginAiUnknownError(OriginAiError):
    """Raised for any other unexpected errors."""
    def __init__(self, message: str, trace_id: str | None = None):
        super().__init__(message, code="unknown_error", trace_id=trace_id)
