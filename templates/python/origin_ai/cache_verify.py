"""Sidecar FastAPI app for v7 nightly cache-purge verification.

Streamlit has no native HTTP route handler, so each tool exposes this sub-app
on a separate port (see README). Cloud Run / FastAPI tools can mount it under
``/_test`` with ``app.mount("/", cache_verify.app)`` instead.

The adapter contract: tools must override ``CacheVerifyAdapter.fetch_masters``
so the verify endpoint reads through the same cache the user-facing app uses.
"""

from __future__ import annotations

import hmac
import logging
import os
from dataclasses import dataclass
from typing import Awaitable, Callable, Iterable, Optional

from fastapi import FastAPI, Header, HTTPException, Response

logger = logging.getLogger(__name__)

CACHE_TAGS: tuple[str, ...] = (
    "products",
    "product-groups",
    "product-costs",
    "product-mall-settings",
    "mall-identifiers",
    "malls",
)


@dataclass(frozen=True)
class FixtureRow:
    master: str
    id: object  # int for INTEGER masters, str for the one TEXT master
    updated_at: Optional[str]
    fixture_owner_tool: str

    def to_dict(self) -> dict:
        return {
            "master": self.master,
            "id": self.id,
            "updated_at": self.updated_at,
            "fixture_owner_tool": self.fixture_owner_tool,
        }


# Tools must register an adapter via register_adapter() at startup.
AdapterFn = Callable[[str], Awaitable[Iterable[FixtureRow]]]
_adapter: Optional[AdapterFn] = None


def register_adapter(fn: AdapterFn) -> None:
    """Register the tool's cache-aware fetch function.

    The function receives ``tool_name`` and must return the cached state for
    every master row matching ``is_test_fixture = true`` AND
    ``fixture_owner_tool = tool_name`` (six rows total, one per master). Tools
    should read through their actual cache layer (st.cache_data / Redis / etc.)
    so the test catches real regressions.

    Identification is by the ``is_test_fixture`` + ``fixture_owner_tool``
    columns, not slug prefixes — Core master id columns are mostly INTEGER and
    a prefix scheme is not portable.
    """
    global _adapter
    _adapter = fn


def _check_auth(provided: Optional[str]) -> bool:
    expected = os.getenv("INTERNAL_API_KEY")
    if not expected or not provided:
        return False
    return hmac.compare_digest(provided, expected)


app = FastAPI(title="cache-verify-sidecar")


@app.get("/_test/cache-verify")
async def cache_verify(
    response: Response,
    x_internal_api_key: Optional[str] = Header(default=None, alias="X-Internal-API-Key"),
) -> dict:
    if not _check_auth(x_internal_api_key):
        logger.warning(
            "[cache-verify] auth_failed; returning 404. "
            "Triage: verify INTERNAL_API_KEY env and X-Internal-API-Key header."
        )
        raise HTTPException(status_code=404, detail="Not Found")

    tool_name = (
        os.getenv("TOOL_NAME")
        or os.getenv("NEXT_PUBLIC_APP_NAME")
        or os.getenv("ORIGIN_AI_TOOL_NAME")
    )
    if not tool_name:
        logger.error("[cache-verify] missing_config TOOL_NAME or ORIGIN_AI_TOOL_NAME")
        raise HTTPException(status_code=404, detail="Not Found")

    if _adapter is None:
        logger.error(
            "[cache-verify] no_adapter_registered; "
            "call register_adapter(fn) at startup so verification reflects the real cache."
        )
        raise HTTPException(status_code=502, detail="adapter_not_registered")

    try:
        rows = await _adapter(tool_name)
    except Exception:  # noqa: BLE001 — surface any adapter error as 502
        logger.exception("[cache-verify] adapter_error")
        raise HTTPException(status_code=502, detail="upstream_error") from None

    response.headers["Cache-Control"] = "no-store"
    return {"tool": tool_name, "fixtures": [r.to_dict() for r in rows]}


@app.post("/api/internal/revalidate")
async def revalidate(
    payload: dict,
    x_internal_api_key: Optional[str] = Header(default=None, alias="X-Internal-API-Key"),
) -> dict:
    """Stub: tools using ``st.cache_data`` should override this to call ``.clear()``.

    Default behaviour: 404 (not configured). Override by importing this module
    and registering a real handler in your app, e.g.::

        from origin_ai import cache_verify

        @cache_verify.app.post("/api/internal/revalidate", response_model=None)
        async def my_revalidate(payload, x_internal_api_key=Header(...)):
            ...
    """
    if not _check_auth(x_internal_api_key):
        raise HTTPException(status_code=404, detail="Not Found")
    raise HTTPException(
        status_code=501,
        detail="revalidate handler not configured; tool must override.",
    )
