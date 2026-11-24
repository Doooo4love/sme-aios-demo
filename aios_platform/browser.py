"""Same-origin browser session exchange for a trusted server-side OIDC client."""
from base64 import urlsafe_b64decode, urlsafe_b64encode
from dataclasses import dataclass, field
from hashlib import sha256
from hmac import compare_digest
import json
import re
import secrets
import time
from urllib.parse import urlencode, urlsplit

import httpx
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials

from aios_demo.storage import canonical

from .contracts import Actor
from .http_pool import get_http_client
from .providers import https_base

SESSION_LIFETIME = 900
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
COOKIE_VALUE = re.compile(r"([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})")


@dataclass(frozen=True)
class BrowserOIDC:
    issuer: str
    client_id: str
    client_secret: str = field(repr=False)

    def __post_init__(self):
        object.__setattr__(self, "issuer", https_base(self.issuer))
        if not self.client_id or not self.client_secret:
            raise ValueError("Configure the confidential browser OIDC client")

    def exchange(self, code, verifier, redirect_uri):
        url = self.issuer + "/protocol/openid-connect/token"
        form = {"grant_type": "authorization_code", "code": code, "code_verifier": verifier,
                "client_id": self.client_id, "client_secret": self.client_secret, "redirect_uri": redirect_uri}
        try:
            client = get_http_client("browser-oidc", timeout=5.0)
            with client.stream("POST", url, data=form) as response:
                response.raise_for_status()
                payload = bytearray()
                for chunk in response.iter_bytes(4096):
                    payload.extend(chunk)
                    if len(payload) > 65_536:
                        raise ValueError("OIDC token response too large")
            token = json.loads(payload)["access_token"]
            if not isinstance(token, str) or not 1 <= len(token) <= 24_576:
                raise ValueError("Invalid OIDC token")
            return token
        except (httpx.HTTPError, ValueError, TypeError, KeyError) as error:
            raise HTTPException(502, {"code": "OIDC_EXCHANGE_FAILED"}) from error


@dataclass(frozen=True)
class BrowserConfig:
    origin: str
    encryption_key: bytes = field(repr=False)
    demo: bool = False
    oidc: BrowserOIDC | None = None

    def __post_init__(self):
        url = urlsplit(self.origin)
        local = url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
        if (not url.hostname or url.username or url.password or url.path or url.query or url.fragment
                or (url.scheme != "https" and not (local and self.demo)) or len(self.encryption_key) != 32):
            raise ValueError("Use an exact trusted origin and a 32-byte browser-session key")

    @property
    def secure(self):
        return self.origin.startswith("https://")

    @property
    def cookie(self):
        return "__Host-aios_session" if self.secure else "aios_demo_session"


class BrowserSessions:
    def __init__(self, workflow, config, profiles):
        self.workflow, self.config, self.profiles = workflow, config, profiles
        self.box = AESGCM(config.encryption_key)

    def origin(self, request):
        if request.headers.get("origin") != self.config.origin:
            raise HTTPException(403, {"code": "ORIGIN_REJECTED"})

    def _key(self, request):
        matched = COOKIE_VALUE.fullmatch(request.cookies.get(self.config.cookie, ""))
        if not matched or matched[1] not in self.profiles:
            return None
        return matched[1], sha256(matched[2].encode()).hexdigest()

    def _entry(self, request):
        key = self._key(request)
        if key is None:
            raise HTTPException(401, "A browser session is required")
        with self.workflow.tx(key[0], write=False, bounded=True) as run:
            row = run("SELECT encrypted FROM aios_browser_session WHERE tenant = ? AND id = ? AND expires_at > ?",
                      (*key, time.time())).fetchone()
        if row is None:
            raise HTTPException(401, "Browser session has expired")
        value = bytes(row["encrypted"])
        try:
            return key[0], json.loads(self.box.decrypt(value[:12], value[12:], canonical(key).encode()))
        except (InvalidTag, ValueError) as error:
            raise HTTPException(401, "Browser session is unavailable") from error

    def credentials(self, request):
        tenant, data = self._entry(request)
        if request.method not in SAFE_METHODS:
            self.origin(request)
            if not compare_digest(data["csrf"].encode(), request.headers.get("x-csrf-token", "").encode()):
                raise HTTPException(403, {"code": "CSRF_REJECTED"})
        return tenant, data["token"]

    def start(self, request, actor, token):
        nonce = secrets.token_bytes(12)
        cookie = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        key = actor.tenant, sha256(cookie.encode()).hexdigest()
        encrypted = nonce + self.box.encrypt(nonce, canonical({"token": token, "csrf": csrf}).encode(),
                                             canonical(key).encode())
        prior = self._key(request)
        now = time.time()
        with self.workflow.tx(actor.tenant, bounded=True) as run:
            if prior and prior[0] == actor.tenant:
                run("DELETE FROM aios_browser_session WHERE tenant = ? AND id = ?", prior)
            run("""DELETE FROM aios_browser_session WHERE tenant = ? AND id IN (
                   SELECT id FROM aios_browser_session WHERE tenant = ? AND expires_at <= ? LIMIT 100
                   )""", (actor.tenant, actor.tenant, now))
            run("INSERT INTO aios_browser_session VALUES (?, ?, ?, ?)", (*key, encrypted, now + SESSION_LIFETIME))
        if prior and prior[0] != actor.tenant:
            self.delete(request)
        return actor.tenant + "." + cookie, csrf

    @property
    def flow_cookie(self):
        return "__Host-aios_oauth" if self.config.secure else "aios_demo_oauth"

    @property
    def redirect_uri(self):
        return self.config.origin + "/v1/session/callback"

    def begin_flow(self):
        nonce = secrets.token_bytes(12)
        state = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(48)
        challenge = urlsafe_b64encode(sha256(verifier.encode()).digest()).decode().rstrip("=")
        cookie = urlsafe_b64encode(nonce + self.box.encrypt(
            nonce, canonical({"state": state, "verifier": verifier, "expires": time.time() + 300}).encode(),
            b"aios-oidc-flow-v1")).decode()
        query = urlencode({"client_id": self.config.oidc.client_id, "redirect_uri": self.redirect_uri,
                           "response_type": "code", "scope": "openid", "state": state,
                           "code_challenge_method": "S256", "code_challenge": challenge})
        return self.config.oidc.issuer + "/protocol/openid-connect/auth?" + query, cookie

    def complete_flow(self, request, state, code):
        cookie = request.cookies.get(self.flow_cookie, "")
        try:
            if len(cookie) > 2048:
                raise ValueError
            raw = urlsafe_b64decode(cookie)
            flow = json.loads(self.box.decrypt(raw[:12], raw[12:], b"aios-oidc-flow-v1"))
            if (not state or not code or len(code) > 4096 or not compare_digest(flow["state"].encode(), state.encode())
                    or flow["expires"] <= time.time()):
                raise ValueError
        except (InvalidTag, ValueError, TypeError, KeyError) as error:
            raise HTTPException(401, {"code": "OIDC_STATE_REJECTED"}) from error
        return self.config.oidc.exchange(code, flow["verifier"], self.redirect_uri)

    def delete(self, request):
        key = self._key(request)
        if key:
            with self.workflow.tx(key[0], bounded=True) as run:
                run("DELETE FROM aios_browser_session WHERE tenant = ? AND id = ?", key)


def browser_routes(sessions, authenticate, bearer, identify):
    router = APIRouter(prefix="/v1/session", tags=["Browser sessions"])

    def set_cookie(response, name, value, lifetime):
        response.set_cookie(name, value, max_age=lifetime, path="/", secure=sessions.config.secure,
                            httponly=True, samesite="lax")

    if sessions.config.oidc:
        @router.get("/login")
        def login():
            url, cookie = sessions.begin_flow()
            response = RedirectResponse(url, status_code=303)
            set_cookie(response, sessions.flow_cookie, cookie, 300)
            return response

        @router.get("/callback")
        def callback(request: Request, code: str | None = None, state: str | None = None):
            token = sessions.complete_flow(request, state, code)
            actor = identify(token)
            cookie, _csrf = sessions.start(request, actor, token)
            response = RedirectResponse("/inbox", status_code=303, headers={"Referrer-Policy": "no-referrer"})
            set_cookie(response, sessions.config.cookie, cookie, SESSION_LIFETIME)
            response.delete_cookie(sessions.flow_cookie, path="/", secure=sessions.config.secure,
                                   httponly=True, samesite="lax")
            return response

    @router.post("")
    def start(request: Request, response: Response, actor: Actor = Depends(authenticate),
              credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
        if credentials is None:
            raise HTTPException(401, "The server-side OIDC client must provide an access token")
        sessions.origin(request)
        cookie, csrf = sessions.start(request, actor, credentials.credentials)
        set_cookie(response, sessions.config.cookie, cookie, SESSION_LIFETIME)
        return {"csrf_token": csrf, "expires_in": SESSION_LIFETIME}

    @router.get("")
    def current(request: Request, actor: Actor = Depends(authenticate)):
        tenant, data = sessions._entry(request)
        if tenant != actor.tenant or request.headers.get("authorization"):
            raise HTTPException(401, "A browser session is required")
        return {"csrf_token": data["csrf"]}

    @router.delete("", status_code=204)
    def end(request: Request, actor: Actor = Depends(authenticate)):
        sessions.origin(request)
        if request.headers.get("authorization"):
            raise HTTPException(401, "A browser session is required")
        sessions.delete(request)
        reply = Response(status_code=204)
        reply.delete_cookie(sessions.config.cookie, path="/", secure=sessions.config.secure,
                            httponly=True, samesite="lax")
        return reply

    return router
