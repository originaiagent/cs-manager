import pytest
from unittest.mock import patch, MagicMock
import httpx
from origin_ai import (
    invoke_chat,
    invoke_workflow,
    OriginAiAuthError,
    OriginAiTimeoutError,
    OriginAiServerError,
)

@pytest.fixture
def mock_env(monkeypatch):
    monkeypatch.setenv("ORIGIN_AI_URL", "https://api.example.com")
    monkeypatch.setenv("ORIGIN_AI_API_KEY", "test-key")

def test_invoke_chat_success(mock_env):
    mock_response = MagicMock()
    mock_response.is_success = True
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "message": "Hello from AI",
        "structuredOutput": {"foo": "bar"},
        "skillUsed": {"name": "test_skill"}
    }
    
    with patch("origin_ai.client._get_client") as mock_client_factory:
        mock_client = mock_client_factory.return_value.__enter__.return_value
        mock_client.request.return_value = mock_response
        
        result = invoke_chat("Hi")
        
        assert result.message == "Hello from AI"
        assert result.structured_output == {"foo": "bar"}
        assert result.skill_used == {"name": "test_skill"}
        assert result.trace_id is not None

def test_invoke_chat_auth_error(mock_env):
    mock_response = MagicMock()
    mock_response.is_success = False
    mock_response.status_code = 401
    mock_response.text = "Unauthorized"
    
    with patch("origin_ai.client._get_client") as mock_client_factory:
        mock_client = mock_client_factory.return_value.__enter__.return_value
        mock_client.request.return_value = mock_response
        
        with pytest.raises(OriginAiAuthError):
            invoke_chat("Hi")

def test_invoke_chat_timeout(mock_env):
    with patch("origin_ai.client._get_client") as mock_client_factory:
        mock_client = mock_client_factory.return_value.__enter__.return_value
        mock_client.request.side_effect = httpx.TimeoutException("Timeout")
        
        with pytest.raises(OriginAiTimeoutError):
            invoke_chat("Hi")

def test_invoke_workflow_success(mock_env):
    mock_response = MagicMock()
    mock_response.is_success = True
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "result": "Workflow result",
        "sessionId": "session-123"
    }
    
    with patch("origin_ai.client._get_client") as mock_client_factory:
        mock_client = mock_client_factory.return_value.__enter__.return_value
        mock_client.request.return_value = mock_response
        
        result = invoke_workflow("test-wf", {"input": "data"})
        
        assert result.result == "Workflow result"
        assert result.session_id == "session-123"
        
        # Verify request body
        args, kwargs = mock_client.request.call_args
        assert kwargs["json"] == {"workflow_id": "test-wf", "data": {"input": "data"}}

def test_invoke_retry_on_500(mock_env):
    mock_response_500 = MagicMock()
    mock_response_500.is_success = False
    mock_response_500.status_code = 500
    mock_response_500.text = "Internal Server Error"
    
    mock_response_200 = MagicMock()
    mock_response_200.is_success = True
    mock_response_200.status_code = 200
    mock_response_200.json.return_value = {"message": "Success after retry"}
    
    with patch("origin_ai.client._get_client") as mock_client_factory:
        mock_client = mock_client_factory.return_value.__enter__.return_value
        # First call returns 500, second returns 200
        mock_client.request.side_effect = [mock_response_500, mock_response_200]
        
        with patch("origin_ai.client._sleep_with_backoff") as mock_sleep:
            result = invoke_chat("Hi")
            assert result.message == "Success after retry"
            assert mock_sleep.call_count == 1
