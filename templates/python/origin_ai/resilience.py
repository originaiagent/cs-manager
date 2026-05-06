"""
v7 §2.7 UR-2 — Streamlit UI resilience boundary.

Layered defense:
  - UR-1 (SDK side):   null-safe / typed fallback when fetching Core data.
  - UR-2 (this module): localize render-time crashes that slip past UR-1
                        (orphan refs, unexpected response shapes, KeyError, etc).

Use `safe_section()` as a context manager around any Core-data display block. Use
`safe_render()` only for small leaf widgets — wrapping a layout-heavy function with a
decorator can leave Streamlit's column/expander state half-rendered on failure.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from functools import wraps
from typing import Any, Callable, Iterator, Optional, TypeVar

import streamlit as st

from .errors import OriginAiError

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])

# Errors that should be caught and rendered as a friendly fallback. Anything else
# (KeyboardInterrupt, SystemExit) propagates.
_CAUGHT = (
    OriginAiError,
    KeyError,
    AttributeError,
    TypeError,
    ValueError,
    IndexError,
)


def _make_retry_key(prefix: str, label: Optional[str]) -> str:
    """Stable retry-button key derived from the section label.

    Stability matters: when the user clicks the retry button, Streamlit triggers
    a rerun. The widget must keep the same `key` across that rerun for Streamlit
    to deliver the click signal to the new render.

    For uniqueness in loops or duplicated labels, callers should pass an explicit
    `retry_key` (or `key_suffix`). Otherwise the fallback's retry button on the
    second occurrence is suppressed gracefully — the error message still renders.
    """
    return f"{prefix}-{label or 'unnamed'}"


def _safe_retry_button(key: str) -> bool:
    """Render the retry button, swallowing DuplicateWidgetID from collisions.

    A duplicate-key clash inside the resilience fallback would re-introduce the
    whole-page crash UR-2 is meant to prevent. So if the same key has already
    been used in this run, we log and skip the button rather than throw.
    The user still sees the error message; only the retry control is hidden.
    """
    try:
        return bool(st.button("最新化", key=key))
    except Exception as exc:  # noqa: BLE001 - intentional last-resort guard
        logger.warning(
            "retry button suppressed (key=%s, reason=%s); "
            "pass an explicit retry_key in loops/duplicate labels",
            key,
            exc,
        )
        return False


def _render_fallback(
    error: BaseException,
    section_label: Optional[str],
    retry_key: str,
) -> None:
    """Render the user-visible fallback for a failed Core data section."""
    is_origin_ai = isinstance(error, OriginAiError)
    heading = (
        "Core データの取得に失敗しました"
        if is_origin_ai
        else "Core データの表示に失敗しました"
    )
    if section_label:
        heading = f"{heading}（{section_label}）"

    detail = (
        "一時的な問題の可能性があります。少し待ってから再試行してください。"
        if is_origin_ai
        else "データ形式が想定外でした。最新化ボタンで再取得を試してください。"
    )

    # Default fallback exposes raw `error` for internal B2B operators. If a tool
    # is user-facing, override `_render_fallback` or pass a custom message via a
    # higher-level wrapper to avoid leaking implementation details.
    st.error(f"{heading}\n\n{detail}\n\n{error}")

    trace_id = getattr(error, "trace_id", None)
    if trace_id:
        st.caption(f"Trace ID: {trace_id}")

    # Requires Streamlit >= 1.27 (st.rerun). Older callers should use
    # st.experimental_rerun via a custom fallback.
    if _safe_retry_button(retry_key):
        st.rerun()


@contextmanager
def safe_section(
    section_label: Optional[str] = None,
    *,
    retry_key: Optional[str] = None,
    log_traceback: bool = True,
) -> Iterator[None]:
    """
    Context manager wrapping a Core-data display section. On a caught error,
    renders a localized fallback with a retry button instead of crashing the page.

    The default `retry_key` is stable per `section_label` so that a click survives
    Streamlit's rerun cycle. For loops or pages with duplicated labels, pass an
    explicit `retry_key=f"...-{i}"` to keep each retry button addressable.

    Example:
        with safe_section("商品マスタ"):
            products = fetch_products()        # may raise OriginAiError
            st.dataframe(render_table(products))
    """
    key = retry_key or _make_retry_key("safe-section-retry", section_label)
    try:
        yield
    except _CAUGHT as error:
        if log_traceback:
            logger.exception("safe_section caught error in %s", section_label)
        else:
            logger.error("safe_section caught %s in %s", type(error).__name__, section_label)
        _render_fallback(error, section_label, key)


def safe_render(
    func: Optional[F] = None,
    *,
    section_label: Optional[str] = None,
    retry_key: Optional[str] = None,
    log_traceback: bool = True,
) -> Any:
    """
    Decorator for SMALL leaf widgets. Prefer `safe_section()` for anything that lays out
    columns/expanders — wrapping a layout-heavy function leaves the layout state in a
    partial render on failure.

    The default retry-button key is stable across reruns. When calling a decorated
    function in a loop where multiple instances may fail, pass an explicit
    `retry_key=...` per call site (or live with retry buttons silently suppressed
    on duplicates after the first).

    Example:
        @safe_render(section_label="残高サマリ")
        def show_balance(user_id: str) -> None:
            data = fetch_balance(user_id)
            st.metric("Balance", data.amount)
    """

    def _decorator(fn: F) -> F:
        @wraps(fn)
        def _wrapped(*args: Any, **kwargs: Any) -> Any:
            label = section_label or fn.__name__
            try:
                return fn(*args, **kwargs)
            except _CAUGHT as error:
                if log_traceback:
                    logger.exception("safe_render caught error in %s", label)
                else:
                    logger.error("safe_render caught %s in %s", type(error).__name__, label)
                key = retry_key or _make_retry_key("safe-render-retry", label)
                _render_fallback(error, label, key)
                return None

        return _wrapped  # type: ignore[return-value]

    if func is not None and callable(func):
        # Used as @safe_render without parens
        return _decorator(func)
    return _decorator


__all__ = ["safe_section", "safe_render"]
