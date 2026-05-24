"""B1.1 regression — custodial endpoints from the portable heritage must not
exist in this web fork.

Trading lives in the browser now (the user signs tx via viem). The server is
strictly non-custodial: no REST endpoints named ``/trade``, ``/quote`` or
``/wallet`` should be registered. This test is a safety net against accidental
re-introduction of those routes.

DoD (see ``docs/plans/backend.md`` § Phase 1 / B1.1):
* ``curl /api/v1/trade`` -> 404 (and likewise for quote/wallet).
* No private keys stored in app/worker (covered by a separate audit; here we
  only assert the URL surface).
"""

from __future__ import annotations

import pytest

from app import create_app


@pytest.fixture()
def client():
    app = create_app(test_overrides={"RATELIMIT_ENABLED": False})
    return app.test_client()


# URLs inherited from portable that must NOT exist. We test both the short and
# ``/api/v1/...`` variants so that a blueprint accidentally registered without
# its prefix is also caught.
_CUSTODIAL_URLS = [
    "/api/v1/trade",
    "/api/v1/quote",
    "/api/v1/wallet",
    "/trade",
    "/quote",
    "/wallet",
]


class TestNoCustodialRoutes:
    @pytest.mark.parametrize("url", _CUSTODIAL_URLS)
    def test_get_returns_404(self, client, url: str) -> None:
        resp = client.get(url)
        assert resp.status_code == 404, (
            f"{url} GET returned {resp.status_code}; "
            "custodial endpoint must not exist (phase 1 / B1.1)."
        )

    @pytest.mark.parametrize("url", _CUSTODIAL_URLS)
    def test_post_returns_404(self, client, url: str) -> None:
        resp = client.post(url, json={})
        assert resp.status_code == 404, (
            f"{url} POST returned {resp.status_code}; "
            "custodial endpoint must not exist (phase 1 / B1.1)."
        )


class TestNoCustodialRouteRegistration:
    """Extra safety: scan the Flask url_map for any exact match against the
    forbidden custodial routes. ``/api/v1/tokens/<token>/trades`` (trade
    history) is fine because the substring check is exact, not fuzzy.
    """

    def test_url_map_has_no_custodial_endpoints(self) -> None:
        app = create_app(test_overrides={"RATELIMIT_ENABLED": False})
        rules = [str(rule) for rule in app.url_map.iter_rules()]
        forbidden_exact = {
            "/api/v1/trade",
            "/api/v1/quote",
            "/api/v1/wallet",
            "/trade",
            "/quote",
            "/wallet",
        }
        leaked = [r for r in rules if r in forbidden_exact]
        assert not leaked, (
            f"url_map contains custodial routes: {leaked}. " "Remove the handler (see B1.1)."
        )
