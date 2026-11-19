"""Loopback-only demo API. The demo reviewer is a fixed simulated identity."""
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Literal
import hashlib
import time
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .parsing import parse_image
from .routing import order_payload, readers, route
from .storage import Conflict, digest_of
from .worker import Worker, services

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "aios_demo" / "web"
SAMPLES = {"standard": "harbour-po.png", "review": "harbour-review.png"}
ledger, erp = services()
previews = OrderedDict()
lock = Lock()
TTL = 900


@asynccontextmanager
async def lifespan(app):
    ledger.initialize()
    erp.initialize()
    yield


app = FastAPI(title="Wholesale Order Intake Demo", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Intake(StrictBody):
    sample: Literal["standard", "review"]


class Review(StrictBody):
    run_id: str = Field(max_length=32)
    overrides: dict[str, str] = Field(default_factory=dict, max_length=30)


class Approval(Review):
    digest: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]{64}$")
    simulate_timeout: bool = False


def evidence_for(run_id: str) -> dict:
    with lock:
        snapshot = previews.get(run_id)
    if snapshot is None or snapshot[0] + TTL < time.monotonic():
        raise HTTPException(410, "This evidence run expired. Read the source again.")
    return snapshot[1]


def checked_payload(run_id: str, overrides: dict) -> dict:
    try:
        return order_payload(evidence_for(run_id), overrides)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


@app.get("/style.css")
def style():
    return FileResponse(WEB / "style.css", media_type="text/css")


@app.get("/app.js")
def javascript():
    return FileResponse(WEB / "app.js", media_type="text/javascript")


@app.get("/sample/{sample}")
def sample_image(sample: Literal["standard", "review"]):
    return FileResponse(ROOT / "fixtures" / SAMPLES[sample], media_type="image/png")


@app.post("/api/intake")
def intake(body: Intake):
    path = ROOT / "fixtures" / SAMPLES[body.sample]
    parsed = parse_image(path)
    primary, secondary = readers(path.name)
    evidence = route(parsed, primary, secondary)
    run_id = uuid.uuid4().hex
    with lock:
        previews[run_id] = time.monotonic(), evidence
        if len(previews) > 128:
            previews.popitem(last=False)
    return {
        **evidence, "run_id": run_id,
        "artifact_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "image_width": parsed.page.width, "image_height": parsed.page.height,
        "reader_mode": "scripted vision" if primary.family.startswith("fixture-") else "live vision",
    }


@app.post("/api/preview")
def preview(body: Review):
    payload = checked_payload(body.run_id, body.overrides)
    return {"payload": payload, "digest": digest_of(payload)}


@app.post("/api/approve", status_code=202)
def approve(body: Approval):
    payload = checked_payload(body.run_id, body.overrides)
    try:
        command_id = ledger.approve(payload, body.digest, "Demo reviewer",
                                    body.overrides, body.simulate_timeout)
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"command_id": command_id}


@app.get("/api/commands/{command_id}")
def command(command_id: str):
    try:
        result = ledger.snapshot(command_id)
    except KeyError as exc:
        raise HTTPException(404, "Command not found") from exc
    key = result["business_key"]
    return {**result, "matching_erp_drafts": int(erp.lookup(key) is not None)}


@app.post("/api/worker/tick")
def tick():
    return {"worked": Worker(ledger, erp, f"manual-{uuid.uuid4().hex}").tick()}
