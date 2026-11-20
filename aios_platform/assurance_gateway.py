"""Constrained prompt and output boundary. The provider is a trusted deployment binding."""
from dataclasses import dataclass
from hashlib import sha256
import json
import re
from typing import Callable
import unicodedata
from uuid import uuid4

from aios_demo.storage import canonical

from .assurance_audit import SignedAudit, pack
from .assurance_policy import FINDINGS, SCHEMA_VERSION, Case
from .contracts import Actor

MAX_OUTPUT = 16 * 1024
REVIEW_REQUESTS = frozenset({"", "precheck", "review this case", "预审", "審核", "审核这条记录"})
SUSPECT = re.compile(r"ignore (previous|all)|system prompt|reveal|bypass|忽略.{0,7}(规则|規則|指令)|"
                     r"披露|绕过|繞過|api[_ -]?key|bearer |https?://|[a-z0-9._+\-]+@[a-z0-9.\-]+\.[a-z]{2,}",
                     re.IGNORECASE)


class GateFailure(ValueError):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code, self.status = code, status


@dataclass(frozen=True)
class ProviderBinding:
    zone: str
    provider_id: str
    invoke: Callable[[bytes, str], bytes]


def unique_object(pairs):
    output = {}
    for name, value in pairs:
        if name in output:
            raise ValueError("Duplicate JSON field")
        output[name] = value
    return output


class ReviewGateway:
    def __init__(self, audit: SignedAudit, zone: str, *, provider: ProviderBinding | None = None,
                 planner_limit: int = 60):
        if provider and (provider.zone != zone or not provider.provider_id):
            raise ValueError("Provider must be configured inside the assigned security zone")
        if not 1 <= planner_limit <= 10000:
            raise ValueError("Invalid assurance planner budget")
        self.audit, self.zone, self.provider, self.planner_limit = audit, zone, provider, planner_limit

    def check_instruction(self, actor: Actor, case: Case, run_id: str, instruction: str):
        normalized = unicodedata.normalize("NFKC", instruction)
        normalized = "".join(c for c in normalized if unicodedata.category(c) != "Cf").strip().casefold()
        suspicious = SUSPECT.search(normalized)
        if suspicious or normalized not in REVIEW_REQUESTS:
            code = "PROMPT_POLICY_BLOCKED" if suspicious else "INSTRUCTION_UNSUPPORTED"
            self.audit.append(actor, run_id, "PROMPT_BLOCKED", canonical({
                "case": case.id, "code": code, "instruction_sha256": sha256(instruction.encode()).hexdigest(),
            }).encode())
            raise GateFailure(code, 422)

    def suggestions(self, actor: Actor, case: Case, run_id: str, facts: dict) -> list[str]:
        if case.zone != self.zone:
            raise GateFailure("ZONE_MISMATCH", 403)
        if self.provider is None:
            return []
        if not self.audit.workflow.take_planner_budget(actor.tenant, self.planner_limit):
            self.audit.append(actor, run_id, "MODEL_BUDGET_BLOCKED", b"{}")
            raise GateFailure("MODEL_BUDGET_EXHAUSTED", 429)
        prompt = canonical({
            "task": "identify_review_findings", "kind": case.kind, "facts": facts,
            "allowed_findings": sorted(FINDINGS[case.kind]), "policy": SCHEMA_VERSION,
        }).encode()
        self.audit.append(actor, run_id, "MODEL_INPUT", canonical({
            "provider": self.provider.provider_id, "zone": self.zone, "payload": pack(prompt),
        }).encode())
        try:
            output = self.provider.invoke(prompt, run_id)
        except Exception as error:
            self.audit.append(actor, run_id, "MODEL_FAILED", b"{}")
            raise GateFailure("MODEL_UNAVAILABLE", 503) from error
        if not isinstance(output, bytes) or len(output) > MAX_OUTPUT:
            detail = {"reason": "invalid_type"}
            if isinstance(output, bytes):
                detail = {"reason": "too_large", "bytes": len(output), "sha256": sha256(output).hexdigest()}
            self.audit.append(actor, run_id, "MODEL_OUTPUT_UNAVAILABLE", canonical(detail).encode())
            raise GateFailure("MODEL_OUTPUT_BLOCKED", 502)
        self.audit.append(actor, run_id, "MODEL_OUTPUT", canonical({"payload": pack(output)}).encode())
        try:
            body = json.loads(output.decode("utf-8"), object_pairs_hook=unique_object)
            if not isinstance(body, dict) or set(body) != {"finding_codes"}:
                raise ValueError("Unexpected model output")
            codes = body["finding_codes"]
            allowed = FINDINGS[case.kind]
            if not isinstance(codes, list) or len(codes) > len(allowed) or any(
                not isinstance(code, str) or code not in allowed for code in codes
            ):
                raise ValueError("Unexpected finding code")
        except (ValueError, RecursionError) as error:
            self.audit.append(actor, run_id, "MODEL_OUTPUT_BLOCKED", b"{}")
            raise GateFailure("MODEL_OUTPUT_BLOCKED", 502) from error
        self.audit.append(actor, run_id, "MODEL_OUTPUT_ACCEPTED", b"{}")
        return sorted(set(codes))

    @staticmethod
    def run_id() -> str:
        return uuid4().hex
