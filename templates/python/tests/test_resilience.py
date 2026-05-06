"""
UR-3 verification test cases for v7 §2.7 Streamlit-side resilience boundary.

Two mandatory scenarios:
  1. Orphan reference  — business UI references a deleted Core record (None / KeyError).
  2. Type mismatch     — SDK returns a payload with unexpected/missing fields.

Both must localize the failure via `safe_section` / `safe_render` instead of crashing
the Streamlit script run.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from origin_ai import OriginAiServerError, safe_render, safe_section


@pytest.fixture(autouse=True)
def fake_streamlit():
    """Patch the streamlit module used inside resilience.py with a recording mock."""
    with patch("origin_ai.resilience.st") as mock_st:
        mock_st.error = MagicMock()
        mock_st.caption = MagicMock()
        mock_st.button = MagicMock(return_value=False)
        mock_st.rerun = MagicMock()
        yield mock_st


def test_safe_section_orphan_reference_does_not_propagate(fake_streamlit):
    """Past data references a Core product that has been deleted -> None.value access raises."""
    deleted_product = None  # Core record removed; UR-1 SDK fallback missing

    with safe_section("商品名"):
        # Naive business code; UR-1 should normally prevent this, but UR-2 must catch it too.
        _ = deleted_product.name  # type: ignore[attr-defined]

    # Crash must NOT propagate; fallback must have been rendered.
    fake_streamlit.error.assert_called_once()
    rendered = fake_streamlit.error.call_args[0][0]
    assert "Core データの表示に失敗しました" in rendered
    assert "商品名" in rendered


def test_safe_section_type_mismatch_does_not_propagate(fake_streamlit):
    """SDK returned a payload missing the `cost` field — KeyError must be caught."""
    sdk_payload = {"id": "p-1", "name": "Item"}  # `cost` missing

    with safe_section("価格"):
        _ = sdk_payload["cost"]["value"]  # KeyError

    fake_streamlit.error.assert_called_once()
    assert "価格" in fake_streamlit.error.call_args[0][0]


def test_safe_section_origin_ai_error_uses_fetch_failure_message(fake_streamlit):
    with safe_section("商品マスタ"):
        raise OriginAiServerError("upstream 500", 500, "trace-abc")

    rendered = fake_streamlit.error.call_args[0][0]
    assert "Core データの取得に失敗しました" in rendered
    fake_streamlit.caption.assert_called_with("Trace ID: trace-abc")


def test_safe_render_decorator_catches_and_returns_none(fake_streamlit):
    @safe_render(section_label="残高")
    def show_balance(user_id: str) -> str:
        raise AttributeError(f"deleted user: {user_id}")

    result = show_balance("u-deleted")

    assert result is None  # caught, fallback rendered
    fake_streamlit.error.assert_called_once()
    assert "残高" in fake_streamlit.error.call_args[0][0]


def test_safe_render_passes_through_when_no_error(fake_streamlit):
    @safe_render(section_label="balance")
    def show_balance() -> int:
        return 42

    assert show_balance() == 42
    fake_streamlit.error.assert_not_called()


def test_safe_section_does_not_swallow_systemexit(fake_streamlit):
    with pytest.raises(SystemExit):
        with safe_section("critical"):
            raise SystemExit(1)

    fake_streamlit.error.assert_not_called()


def test_retry_key_is_stable_across_calls_for_same_label(fake_streamlit):
    """Stability matters: a click triggers a Streamlit rerun, and the retry
    button must keep the same `key` across runs for the click signal to land.
    """
    with safe_section("商品マスタ"):
        raise KeyError("missing")

    first_key = fake_streamlit.button.call_args_list[0].kwargs["key"]

    fake_streamlit.button.reset_mock()
    fake_streamlit.error.reset_mock()
    fake_streamlit.caption.reset_mock()

    # Simulate a rerun: same section_label, same failure
    with safe_section("商品マスタ"):
        raise KeyError("missing")

    second_key = fake_streamlit.button.call_args_list[0].kwargs["key"]
    assert first_key == second_key, "retry key must be stable across reruns"


def test_explicit_retry_key_in_loop_disambiguates(fake_streamlit):
    """The documented escape hatch: pass retry_key=f'...-{i}' in loops."""
    for i in range(3):
        with safe_section("Row", retry_key=f"row-retry-{i}"):
            raise KeyError("missing")

    keys = [kwargs["key"] for _, kwargs in fake_streamlit.button.call_args_list]
    assert keys == ["row-retry-0", "row-retry-1", "row-retry-2"]


def test_duplicate_label_without_explicit_key_does_not_crash(fake_streamlit):
    """Regression for the original DuplicateWidgetID risk:
    two sections with the same label and default key must not raise — the
    second retry button is suppressed gracefully via _safe_retry_button."""
    # First button call succeeds, second raises DuplicateWidgetID-like
    fake_streamlit.button.side_effect = [False, RuntimeError("DuplicateWidgetID")]

    for _ in range(2):
        with safe_section("History"):
            raise KeyError("missing")

    # Both errors must still be rendered (no crash propagated)
    assert fake_streamlit.error.call_count == 2
    # Both button calls were attempted
    assert fake_streamlit.button.call_count == 2


def test_safe_render_explicit_retry_key_in_loop(fake_streamlit):
    """Per-iteration retry_key keeps each leaf widget's button addressable."""

    def make_decorated(i: int):
        @safe_render(section_label="row", retry_key=f"row-{i}")
        def show_row() -> None:
            raise AttributeError("boom")

        return show_row

    for i in range(3):
        make_decorated(i)()

    keys = [kwargs["key"] for _, kwargs in fake_streamlit.button.call_args_list]
    assert keys == ["row-0", "row-1", "row-2"]
