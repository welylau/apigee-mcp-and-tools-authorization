"""Caller identity for the Biscuit Coffee backend.

The Apigee proxy (Biscuit-Coffee-Shop) verifies the user's Keycloak access
token and forwards it unchanged in the `X-User-Token` header (the
`Authorization` header carries Cloud Run's Google ID token for the service
itself). This module verifies that JWT again - RS256 signature against the
realm's JWKS, issuer, audience and expiry - and is the ONLY source of the
caller's identity (email, name) and scopes. X-User-* headers are ignored.

Why verify twice: Cloud Run IAM decides who may reach the service, but any
principal holding run.invoker (or a project role that includes it) could
otherwise send forged identity headers. A forged or missing token -> 401.
"""

import logging
import os
import threading
from dataclasses import dataclass, field
from typing import FrozenSet, Optional

import jwt
from fastapi import Header, HTTPException

logger = logging.getLogger("coffee-shop-backend.auth")

KEYCLOAK_ISSUER = (
    os.getenv("KEYCLOAK_ISSUER") or "https://keycloak.YOUR_KEYCLOAK_IP.nip.io/realms/apigee-demo"
).rstrip("/")
KEYCLOAK_AUDIENCE = os.getenv("KEYCLOAK_AUDIENCE") or "biscuit-coffee"
KEYCLOAK_JWKS_URL = os.getenv("KEYCLOAK_JWKS_URL") or f"{KEYCLOAK_ISSUER}/protocol/openid-connect/certs"
JWKS_CACHE_SECONDS = 600
CLOCK_SKEW_SECONDS = 30
ALGORITHMS = ["RS256"]

SCOPE_CUSTOMER = "biscuit_coffee_customer"
SCOPE_STAFF = "biscuit_coffee_staff"
SCOPE_MANAGER = "biscuit_coffee_manager"


@dataclass(frozen=True)
class Principal:
    sub: str
    email: str  # lower-cased; "" when the token has no email claim
    name: str
    scopes: FrozenSet[str] = field(default_factory=frozenset)

    @property
    def is_manager(self) -> bool:
        return SCOPE_MANAGER in self.scopes

    @property
    def is_staff(self) -> bool:
        return bool({SCOPE_STAFF, SCOPE_MANAGER} & self.scopes)

    @property
    def is_customer(self) -> bool:
        return SCOPE_CUSTOMER in self.scopes


_jwk_client: Optional[jwt.PyJWKClient] = None
_jwk_lock = threading.Lock()


def _get_jwk_client() -> jwt.PyJWKClient:
    """JWKS client; the key set is cached for 10 minutes, unknown kids trigger a refetch."""
    global _jwk_client
    with _jwk_lock:
        if _jwk_client is None:
            _jwk_client = jwt.PyJWKClient(
                KEYCLOAK_JWKS_URL, cache_jwk_set=True, lifespan=JWKS_CACHE_SECONDS, timeout=5
            )
        return _jwk_client


def _unauthorized(reason: str) -> HTTPException:
    return HTTPException(
        status_code=401,
        detail={"message": "Missing or invalid user token"},
        headers={"WWW-Authenticate": f'Bearer error="invalid_token", error_description="{reason}"'},
    )


def verify_user_token(raw: Optional[str]) -> Principal:
    token = (raw or "").strip()
    if token[:7].lower() == "bearer ":
        token = token[7:].strip()
    if not token or token.count(".") != 2 or len(token) > 8192:
        raise _unauthorized("missing token")
    try:
        signing_key = _get_jwk_client().get_signing_key_from_jwt(token)
    except jwt.PyJWKClientConnectionError as exc:
        logger.error("JWKS fetch failed: %s", exc)
        raise HTTPException(status_code=503, detail={"message": "Identity provider unavailable"}) from exc
    except (jwt.PyJWKClientError, jwt.InvalidTokenError) as exc:
        logger.info("Token rejected (key lookup): %s", exc)
        raise _unauthorized("unknown signing key") from exc
    try:
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=ALGORITHMS,
            audience=KEYCLOAK_AUDIENCE,
            issuer=KEYCLOAK_ISSUER,
            leeway=CLOCK_SKEW_SECONDS,
            # Same checks as the gateway's JWT-VerifyToken. sub/iat are not
            # required: Keycloak can be configured to omit them.
            options={"require": ["exp", "iss", "aud"]},
        )
    except jwt.InvalidTokenError as exc:
        logger.info("Token rejected: %s", exc)
        raise _unauthorized("token verification failed") from exc

    scope = claims.get("scope")
    scopes = frozenset(scope.split()) if isinstance(scope, str) else frozenset()
    email = claims.get("email")
    name = claims.get("name") or claims.get("preferred_username") or ""
    return Principal(
        sub=str(claims.get("sub") or ""),
        email=email.strip().lower() if isinstance(email, str) else "",
        name=str(name).strip()[:80],
        scopes=scopes,
    )


def current_principal(x_user_token: Optional[str] = Header(None, alias="X-User-Token")) -> Principal:
    """FastAPI dependency: the verified caller, or 401."""
    return verify_user_token(x_user_token)
