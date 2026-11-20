"""Local demo principals and verified Keycloak/OIDC access tokens."""
from hmac import compare_digest
from typing import Protocol

import jwt
from pydantic import ValidationError

from .contracts import Actor


class Identity(Protocol):
    def authenticate(self, token: str) -> Actor: ...


class DemoIdentity:
    PEOPLE = {
        "viewer": ("harbour", "viewer", ["HK01"]),
        "operator": ("harbour", "operator", ["HK01"]),
        "manager": ("harbour", "manager", ["HK01"]),
        "admin": ("harbour", "admin", ["HK01"]),
        "other-manager": ("harbour", "manager", ["HK02"]),
        "island-manager": ("island", "manager", ["HK01"]),
        "finance": ("harbour", "viewer", ["HK01"]),
        "quality": ("harbour", "viewer", ["HK01"]),
        "legal": ("harbour", "viewer", ["HK01"]),
        "executive": ("harbour", "manager", ["HK01", "HK02"]),
    }

    def __init__(self, secret: str):
        if len(secret) < 32 or "." in secret:
            raise ValueError("Use a random demo secret of at least 32 characters without periods")
        self.secret = secret

    def known_subject(self, tenant: str, subject: str) -> bool:
        return subject in self.PEOPLE and self.PEOPLE[subject][0] == tenant

    def authenticate(self, token: str) -> Actor:
        secret, _, name = token.partition(".")
        if not compare_digest(secret.encode(), self.secret.encode()):
            raise ValueError("Invalid access token")
        if name not in self.PEOPLE:
            raise ValueError("Invalid access token")
        tenant, role, warehouses = self.PEOPLE[name]
        grants = {"chat.use", "mail.read"}
        if name == "finance":
            grants.update(("finance.read", "assurance.finance", "assurance.purchase"))
        elif name == "quality":
            grants.update(("assurance.quality", "assurance.incoming"))
        elif name == "legal":
            grants.update(("assurance.legal", "assurance.contract"))
        elif name == "executive":
            grants.add("decision.read")
        else:
            grants.add("shipment.read")
            if role != "viewer":
                grants.update(("shipment.reschedule", "order.work"))
            if role in {"manager", "admin"}:
                grants.update(("operations.manage", "decision.read"))
        if name in {"operator", "manager", "admin", "other-manager", "island-manager"}:
            grants.update(("assurance.purchase", "assurance.incoming", "assurance.contract"))
        if name in {"manager", "admin", "other-manager", "island-manager"}:
            grants.add("assurance.procurement")
        if name == "admin":
            grants.add("assurance.audit")
        return Actor(subject=name, tenant=tenant, role=role, warehouses=warehouses, grants=grants)


class OIDCIdentity:
    def __init__(self, issuer: str, audience: str):
        from .providers import https_base

        self.issuer = https_base(issuer)
        self.audience = audience
        self.keys = jwt.PyJWKClient(self.issuer + "/protocol/openid-connect/certs", timeout=5)

    def authenticate(self, token: str) -> Actor:
        try:
            key = self.keys.get_signing_key_from_jwt(token)
            claims = jwt.decode(token, key.key, algorithms=["RS256"],
                                issuer=self.issuer, audience=self.audience,
                                options={"require": ["iss", "sub", "aud", "exp"]})
            if claims.get("typ") != "Bearer" or not isinstance(claims.get("aios_warehouses"), list):
                raise ValueError("An AIOS access token is required")
            grants = claims.get("aios_grants", [])
            if not isinstance(grants, list):
                raise ValueError("Invalid workbench grants")
            return Actor(subject=claims["sub"], tenant=claims["aios_tenant"],
                         role=claims["aios_role"], warehouses=claims["aios_warehouses"], grants=grants)
        except (KeyError, jwt.PyJWTError, ValidationError) as error:
            raise ValueError("Invalid access token") from error
