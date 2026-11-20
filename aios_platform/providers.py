"""Bounded HTTP and model adapters. Language output is data for the action gateway."""
import asyncio
import json
import re
from typing import Protocol
from urllib.parse import urlsplit

import httpx

from .contracts import INTENT, Actor, Clarify, Intent, Plan


def https_base(value: str) -> str:
    url = urlsplit(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Configure a fixed HTTPS service URL")
    return value.rstrip("/")


def post_json(url: str, payload: dict, headers: dict | None = None, *, timeout: float = 8) -> dict:
    with httpx.Client(follow_redirects=False, timeout=timeout, trust_env=False) as client:
        with client.stream("POST", url, json=payload, headers=headers) as response:
            response.raise_for_status()
            chunks = bytearray()
            for chunk in response.iter_bytes(8192):
                chunks.extend(chunk)
                if len(chunks) > 65_536:
                    raise ValueError("Provider response exceeded the size limit")
    data = json.loads(chunks)
    if not isinstance(data, dict):
        raise ValueError("Expected a provider response object")
    return data


class Planner(Protocol):
    def plan(self, text: str) -> Intent: ...


def checked_intent(value: dict) -> Intent:
    try:
        return INTENT.validate_python(value)
    except (TypeError, ValueError):
        return Clarify(action="clarify", question="Provide a supported action, reference, and date if needed.")


class DemoPlanner:
    def plan(self, text: str) -> Intent:
        ref = r"([A-Za-z0-9_-]{1,64})"
        patterns = (
            (rf"(?:show|check|track) shipment {ref}", "shipment.read", ("shipment_id",)),
            (rf"(?:reschedule|move) shipment {ref} to (\d{{4}}-\d{{2}}-\d{{2}})",
             "shipment.reschedule", ("shipment_id", "delivery_date")),
            (rf"create draft for intake {ref}", "sales_order.create_draft", ("intake_id",)),
            (rf"(?:查询|查看)\s*(?:运单|運單)\s*{ref}", "shipment.read", ("shipment_id",)),
            (rf"将\s*(?:运单|運單)\s*{ref}\s*改到\s*(\d{{4}}-\d{{2}}-\d{{2}})",
             "shipment.reschedule", ("shipment_id", "delivery_date")),
            (rf"为\s*{ref}\s*创建销售草稿", "sales_order.create_draft", ("intake_id",)),
        )
        for pattern, action, keys in patterns:
            match = re.fullmatch(pattern, text.strip(), re.IGNORECASE)
            if match:
                return checked_intent({"action": action, **dict(zip(keys, match.groups()))})
        return Clarify(action="clarify", question="Which shipment, or verified purchase-order intake, should I use?")


class CompatiblePlanner:
    def __init__(self, base_url: str, model: str, secret: str):
        self.url = https_base(base_url) + "/chat/completions"
        self.model = model
        self.secret = secret

    def plan(self, text: str) -> Intent:
        schema = json.dumps(INTENT.json_schema(), separators=(",", ":"))
        result = post_json(self.url, {"model": self.model, "messages": [
            {"role": "system", "content": (
                "Return one JSON object matching this intent schema: " + schema
                + ". Interpret only the user's sentence. Ask for missing dates or IDs using clarify. "
                "Do not invent references. You have no executable tools."
            )},
            {"role": "user", "content": text},
        ]}, {"Authorization": "Bearer " + self.secret})
        content = result["choices"][0]["message"]["content"]
        return checked_intent(json.loads(content))


def can_use_action(actor: Actor, action: str) -> bool:
    if action == "shipment.read":
        return "shipment.read" in actor.grants
    if actor.role not in {"operator", "manager", "admin"}:
        return False
    if action == "shipment.reschedule":
        return {"shipment.read", "shipment.reschedule"} <= actor.grants
    return action == "sales_order.create_draft" and "order.work" in actor.grants


def allowed(actor: Actor, action: str, warehouse: str) -> bool:
    return warehouse in actor.warehouses and can_use_action(actor, action)


def can_approve(actor: Actor, requester: str, plan: Plan) -> bool:
    return actor.tenant == plan.tenant and actor.subject != requester and allowed(actor, plan.action, plan.warehouse) \
        and actor.role in {"manager", "admin"}


class OPA:
    """Optional additional deny gate. An outage or undefined result denies."""
    def __init__(self, url: str):
        base = urlsplit(url)
        if base.hostname in {"localhost", "127.0.0.1", "::1"} and base.scheme == "http" and not (
            base.username or base.password or base.query or base.fragment
        ):
            self.url = url.rstrip("/")
        else:
            self.url = https_base(url)

    def permits(self, actor: Actor, plan: Plan, requester: str, stage: str) -> bool:
        try:
            result = post_json(self.url + "/v1/data/aios/allow", {"input": {
                "actor": actor.model_dump(mode="json"),
                "plan": {"tenant": plan.tenant, "warehouse": plan.warehouse, "action": plan.action},
                "requester": requester, "stage": stage,
            }})
            return result.get("result") is True
        except (ValueError, httpx.HTTPError):
            return False


class PydanticPlanner:
    """Optional Pydantic AI harness, with typed output and no executable tools."""
    def __init__(self, base_url: str, model: str, secret: str):
        self.base_url = https_base(base_url)
        self.model = model
        self.secret = secret

    def plan(self, text: str) -> Intent:
        from openai import AsyncOpenAI, OpenAIError
        from pydantic_ai import Agent, UsageLimits, exceptions
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        async def interpret() -> Intent:
            async with httpx.AsyncClient(timeout=8, trust_env=False, follow_redirects=False) as transport:
                client = AsyncOpenAI(base_url=self.base_url, api_key=self.secret, http_client=transport,
                                     max_retries=0)
                agent = Agent(
                    OpenAIChatModel(self.model, provider=OpenAIProvider(openai_client=client)),
                    output_type=Intent,
                    instructions=(
                        "Map the user's sentence to a supported operation. Ask for missing identifiers "
                        "or dates. Never infer authorization. You have no executable tools."
                    ),
                    retries=0,
                )
                result = await agent.run(text, usage_limits=UsageLimits(request_limit=1),
                                         model_settings={"max_tokens": 450})
                return result.output

        try:
            return asyncio.run(interpret())
        except (exceptions.AgentRunError, OpenAIError) as error:
            raise ValueError("Planner could not produce a validated intent") from error
