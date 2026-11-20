"""Bound JSON payloads and export low-cardinality, credential-free metrics."""
import asyncio
from hmac import compare_digest
import logging
import time
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Histogram, generate_latest
from starlette.responses import JSONResponse

LOG = logging.getLogger("aios.platform")
JSON_LIMIT = 65_536
METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
BOUNDED_JSON_PATHS = (
    "/v1/actions", "/v1/intakes/", "/v1/proposals/", "/v1/operations/", "/v1/workbench/", "/v1/chat/",
)


class RequestEnvelope:
    def __init__(self, app, requests, latency):
        self.app = app
        self.requests = requests
        self.latency = latency

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request_id = uuid4().hex
        started = time.monotonic()
        method = scope["method"] if scope["method"] in METHODS else "OTHER"
        raw_path = scope["path"]
        status = 500

        async def respond(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = [*message.get("headers", []), (b"x-request-id", request_id.encode())]
                if raw_path.startswith("/v1/"):
                    headers = [(name, value) for name, value in headers if name != b"cache-control"]
                    headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": headers}
            await send(message)

        try:
            headers = dict(scope["headers"])
            content_type = headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower()
            image = content_type == b"application/octet-stream" and raw_path.startswith("/v1/intakes/") \
                and raw_path.count("/") == 3
            if method in {"POST", "PUT", "PATCH"} and not image and raw_path.startswith(BOUNDED_JSON_PATHS):
                body = bytearray()
                while True:
                    remaining = 15 - (time.monotonic() - started)
                    try:
                        async with asyncio.timeout(remaining):
                            chunk = await receive()
                    except TimeoutError:
                        reply = JSONResponse({"detail": "Request body timed out"}, status_code=408)
                        return await reply(scope, receive, respond)
                    if chunk["type"] == "http.disconnect":
                        status = 499
                        return
                    incoming = chunk.get("body", b"")
                    if len(body) + len(incoming) > JSON_LIMIT:
                        reply = JSONResponse({"detail": "Request body too large"}, status_code=413)
                        return await reply(scope, receive, respond)
                    body.extend(incoming)
                    if not chunk.get("more_body", False):
                        break
                replayed = False

                async def replay():
                    nonlocal replayed
                    if replayed:
                        return await receive()
                    replayed = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}

                return await self.app(scope, replay, respond)
            return await self.app(scope, receive, respond)
        finally:
            route = getattr(scope.get("route"), "path", "unmatched")
            if route not in {"/healthz", "/readyz", "/metrics"}:
                self.requests.labels(method, route, str(status)).inc()
                self.latency.labels(method, route).observe(time.monotonic() - started)
                LOG.info("request id=%s method=%s route=%s status=%s", request_id, method, route, status)


def instrument(app: FastAPI, token: str | None):
    registry = CollectorRegistry()
    requests = Counter("aios_http_requests", "Completed API requests", ("method", "route", "status"),
                       registry=registry)
    latency = Histogram("aios_http_duration_seconds", "API request latency", ("method", "route"),
                        registry=registry)
    app.add_middleware(RequestEnvelope, requests=requests, latency=latency)
    if token:
        if len(token) < 32:
            raise ValueError("Configure a dedicated metrics token of at least 32 characters")

        @app.get("/metrics", include_in_schema=False)
        def metrics(request: Request):
            auth = request.headers.get("authorization", "")
            if not compare_digest(auth.encode(), ("Bearer " + token).encode()):
                raise HTTPException(401, "Metrics credentials required")
            return Response(generate_latest(registry), headers={"Content-Type": CONTENT_TYPE_LATEST,
                                                                "Cache-Control": "no-store"})
