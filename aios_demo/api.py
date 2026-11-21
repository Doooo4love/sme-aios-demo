"""Loopback-only demo API. The demo reviewer is a fixed simulated identity."""
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from io import BytesIO
import subprocess
import uuid

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .extract_po import analyze_upload, extraction_result
from .parsing import MAX_UPLOAD_BYTES, parse_page, read_image
from .routing import RuleBlocked, configured_vision, order_payload, readers, route
from .storage import Conflict, digest_of
from .worker import Worker, services

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "aios_demo" / "web"
SAMPLES = {"standard": "harbour-po.png", "review": "harbour-review.png", "shorthand": "harbour-shorthand.png"}
Sample = Literal["standard", "review", "shorthand"]
ledger, erp = services()


@asynccontextmanager
async def lifespan(app):
    ledger.initialize()
    erp.initialize()
    yield


app = FastAPI(title="Wholesale Order Intake Demo", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "127.0.0.2", "localhost", "testserver"])
app.mount("/fonts", StaticFiles(directory=WEB / "fonts"), name="fonts")


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Intake(StrictBody):
    sample: Sample


class Review(StrictBody):
    run_id: str = Field(max_length=32)
    overrides: dict[Annotated[str, Field(max_length=40)], Annotated[str, Field(max_length=40)]] = Field(
        default_factory=dict, max_length=155,
    )
    mappings: dict[Annotated[str, Field(max_length=40)], Annotated[str, Field(max_length=40)]] = Field(
        default_factory=dict, max_length=30,
    )


class Preview(Review):
    remember: bool = False


class Approval(Review):
    digest: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]{64}$")
    simulate_timeout: bool = False


@app.get("/api/intakes")
def recent_intakes():
    return ledger.recent_intakes()


@app.get("/api/intakes/{run_id}")
def evidence_for(run_id: str):
    try:
        evidence = ledger.intake(run_id)
    except KeyError as error:
        raise HTTPException(404, "Intake not found") from error
    return {**evidence, "run_id": run_id, "source_url": f"/api/intakes/{run_id}/source"}


@app.get("/api/intakes/{run_id}/source")
def documents_source(run_id: str):
    try:
        data = ledger.intake_source(run_id)
    except KeyError as error:
        raise HTTPException(404, "Intake not found") from error
    return Response(data, media_type="image/png", headers={"Cache-Control": "no-store"})


def save_intake(filename: str, evidence: dict, page) -> dict:
    source = BytesIO()
    page.save(source, format="PNG")
    return evidence_for(ledger.create_intake(filename, evidence, source.getvalue()))


def checked_payload(body: Review) -> dict:
    try:
        return order_payload(evidence_for(body.run_id), body.overrides, body.mappings)
    except RuleBlocked as exc:
        ledger.record_rule_block(body.run_id)
        raise HTTPException(422, str(exc)) from exc
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
def sample_image(sample: Sample):
    return FileResponse(ROOT / "fixtures" / SAMPLES[sample], media_type="image/png")


@app.post("/api/intake")
def intake(body: Intake):
    path = ROOT / "fixtures" / SAMPLES[body.sample]
    data = path.read_bytes()
    try:
        parsed = parse_page(read_image(data))
    except (OSError, subprocess.SubprocessError) as error:
        raise HTTPException(503, "Local OCR is unavailable") from error
    primary, secondary = readers(path.name)
    evidence = extraction_result(data, parsed, route(parsed, primary, secondary, memory=ledger.sku_memory()), "demo")
    evidence["reader_mode"] = "scripted vision" if primary.family.startswith("fixture-") else "live vision"
    return save_intake(path.name, evidence, parsed.page)


@app.post("/api/intakes/upload", status_code=201)
async def upload(
    request: Request,
    filename: str = Query(min_length=1, max_length=180),
    mode: Literal["ocr", "vision-on-demand"] = "ocr",
):
    # Restrict this upload to same-origin browser requests or explicit HTTP clients.
    if request.headers.get("content-type") != "application/octet-stream":
        raise HTTPException(415, "Send PNG/JPEG bytes as application/octet-stream")
    origin = request.headers.get("origin")
    if origin is not None and origin != f"{request.url.scheme}://{request.url.netloc}":
        raise HTTPException(403, "Cross-origin upload is disabled")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Image exceeds 8 MB")
        data.extend(chunk)
    try:
        reader = configured_vision() if mode == "vision-on-demand" else None
    except ValueError as error:
        raise HTTPException(503, str(error)) from error
    try:
        memory = await run_in_threadpool(ledger.sku_memory)
        evidence, parsed = await run_in_threadpool(analyze_upload, bytes(data), reader, memory=memory)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except (OSError, subprocess.SubprocessError) as error:
        raise HTTPException(503, "Local OCR is unavailable") from error
    safe_name = filename.replace("\\", "/").rsplit("/", 1)[-1].strip() or "purchase-order"
    return await run_in_threadpool(save_intake, safe_name, evidence, parsed.page)


@app.post("/api/preview")
def preview(body: Preview, feedback: bool = False):
    try:
        payload = checked_payload(body)
    except HTTPException as error:
        # Interactive edits receive a rule verdict. Existing API clients keep 422.
        if feedback and error.status_code == 422:
            return {"blocked": True, "detail": error.detail}
        raise
    result = {"payload": payload, "digest": digest_of(payload), "overrides": body.overrides,
              "mappings": body.mappings}
    memories = {}
    if body.remember:
        for index, item in enumerate(payload["items"], 1):
            if f"line.{index}.sku" in body.mappings:
                key = payload["buyer"], item["source_sku"]
                item_mapping = item["sku"], item["erp_quantity"] // item["source_quantity"]
                if key in memories and memories[key] != item_mapping:
                    raise HTTPException(422, "Select one ERP SKU per customer alias")
                memories[key] = item_mapping
    try:
        ledger.save_preview(body.run_id, result, memories=memories)
    except Conflict as error:
        raise HTTPException(409, str(error)) from error
    return result


@app.post("/api/demo/reset")
def reset_demo_memory():
    return {"cleared": ledger.reset_memory()}


@app.post("/api/approve", status_code=202)
def approve(body: Approval):
    payload = checked_payload(body)
    try:
        command_id = ledger.approve(payload, body.digest, "Demo reviewer",
                                    body.overrides, body.simulate_timeout, intake_id=body.run_id)
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"command_id": command_id}


@app.get("/api/commands/{command_id}")
def command(command_id: str, run_id: str | None = None):
    try:
        result = ledger.snapshot(command_id)
        metrics = ledger.command_metrics(command_id, run_id)
    except KeyError as exc:
        raise HTTPException(404, "Command not found") from exc
    record = erp.lookup(result["business_key"])
    matches = (record is not None and record["status"] == "DRAFT"
               and digest_of(record["payload"]) == result["digest"])
    return {**result, "metrics": metrics, "matching_erp_drafts": int(matches),
            "verified_payload": record["payload"] if matches and result["status"] == "COMMITTED" else None}


@app.post("/api/worker/tick")
def tick():
    return {"worked": Worker(ledger, erp, f"manual-{uuid.uuid4().hex}").tick()}
