"""Loopback-only demo API. The demo reviewer is a fixed simulated identity."""
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from io import BytesIO
import subprocess
import uuid

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .extract_po import analyze_upload, extraction_result
from .parsing import MAX_UPLOAD_BYTES, parse_page, read_image
from .routing import configured_vision, order_payload, readers, route
from .storage import Conflict, digest_of, matches_erp_draft
from .worker import Worker, services

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "aios_demo" / "web"
SAMPLES = {"standard": "harbour-po.png", "review": "harbour-review.png"}
ledger, erp = services()


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
    overrides: dict[Annotated[str, Field(max_length=40)], Annotated[str, Field(max_length=40)]] = Field(
        default_factory=dict, max_length=155,
    )


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
    data = path.read_bytes()
    parsed = parse_page(read_image(data))
    primary, secondary = readers(path.name)
    evidence = extraction_result(data, parsed, route(parsed, primary, secondary), "demo")
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
        evidence, parsed = await run_in_threadpool(analyze_upload, bytes(data), reader)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except (OSError, subprocess.SubprocessError) as error:
        raise HTTPException(503, "Local OCR is unavailable") from error
    safe_name = filename.replace("\\", "/").rsplit("/", 1)[-1].strip() or "purchase-order"
    return await run_in_threadpool(save_intake, safe_name, evidence, parsed.page)


@app.post("/api/preview")
def preview(body: Review):
    payload = checked_payload(body.run_id, body.overrides)
    result = {"payload": payload, "digest": digest_of(payload), "overrides": body.overrides}
    try:
        ledger.save_preview(body.run_id, result)
    except Conflict as error:
        raise HTTPException(409, str(error)) from error
    return result


@app.post("/api/approve", status_code=202)
def approve(body: Approval):
    payload = checked_payload(body.run_id, body.overrides)
    try:
        command_id = ledger.approve(payload, body.digest, "Demo reviewer",
                                    body.overrides, body.simulate_timeout, intake_id=body.run_id)
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"command_id": command_id}


@app.get("/api/commands/{command_id}")
def command(command_id: str):
    try:
        result = ledger.snapshot(command_id)
    except KeyError as exc:
        raise HTTPException(404, "Command not found") from exc
    record = erp.lookup(result["business_key"])
    committed = result["status"] == "COMMITTED"
    matches = matches_erp_draft(record, result) and (not committed or record["id"] == result["erp_id"])
    return {
        **result,
        "matching_erp_drafts": int(matches),
        "verified_payload": record["payload"] if committed and matches else None,
    }


@app.post("/api/worker/tick")
def tick():
    return {"worked": Worker(ledger, erp, f"manual-{uuid.uuid4().hex}").tick()}
