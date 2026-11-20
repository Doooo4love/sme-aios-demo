"""Encrypted provider transcripts and signed, independently verifiable hash chaining."""
import argparse
from base64 import b64decode, b64encode
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
from time import time_ns

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from aios_demo.storage import canonical, digest_of

GENESIS = "0" * 64


def pack(value: bytes) -> str:
    return b64encode(value).decode("ascii")


def unpack(value: str) -> bytes:
    return b64decode(value, validate=True)


@dataclass(frozen=True)
class AuditKeys:
    signer: Ed25519PrivateKey
    encryption: AESGCM

    @classmethod
    def from_file(cls, path: Path):
        if path.stat().st_mode & 0o077:
            raise ValueError("Assurance demo key file must be private (0600)")
        contents = json.loads(path.read_text())
        return cls(Ed25519PrivateKey.from_private_bytes(unpack(contents["signing"])),
                   AESGCM(unpack(contents["encryption"])))

    @property
    def key_id(self) -> str:
        return sha256(self.signer.public_key().public_bytes_raw()).hexdigest()


class SignedAudit:
    def __init__(self, workflow, keys: AuditKeys):
        self.workflow, self.keys = workflow, keys
        self.key_id = keys.key_id

    def append(self, actor, run_id: str, event: str, payload: bytes, *, transaction=None):
        if transaction is not None:
            return self._append(transaction, actor, run_id, event, payload)
        with self.workflow.tx(actor.tenant) as run:
            return self._append(run, actor, run_id, event, payload)

    def _append(self, run, actor, run_id: str, event: str, payload: bytes):
        run("""INSERT INTO aios_assurance_head (tenant, tip_seq, tip_hash) VALUES (?, 0, ?)
               ON CONFLICT (tenant) DO NOTHING""", (actor.tenant, GENESIS))
        lock = " FOR UPDATE" if self.workflow.db.dsn else ""
        tip = run("SELECT tip_seq, tip_hash FROM aios_assurance_head WHERE tenant = ?" + lock,
                  (actor.tenant,)).fetchone()
        header = {"version": 1, "tenant": actor.tenant, "seq": tip["tip_seq"] + 1,
                  "previous": tip["tip_hash"], "subject": actor.subject, "run_id": run_id,
                  "event": event, "time_ns": time_ns(), "key_id": self.key_id}
        nonce = os.urandom(12)
        encrypted = self.keys.encryption.encrypt(nonce, payload, canonical(header).encode())
        envelope = {**header, "nonce": pack(nonce), "ciphertext": pack(encrypted)}
        digest = digest_of(envelope)
        signature = pack(self.keys.signer.sign(bytes.fromhex(digest)))
        run("INSERT INTO aios_assurance_audit VALUES (?, ?, ?, ?, ?)",
            (actor.tenant, header["seq"], canonical(envelope), digest, signature))
        run("UPDATE aios_assurance_head SET tip_seq = ?, tip_hash = ? WHERE tenant = ?",
            (header["seq"], digest, actor.tenant))
        return {"seq": header["seq"], "hash": digest}

    def checkpoint(self, tenant: str) -> dict:
        with self.workflow.tx(tenant, write=False) as run:
            tip = run("SELECT tip_seq, tip_hash FROM aios_assurance_head WHERE tenant = ?", (tenant,)).fetchone()
        body = {"type": "aios-assurance-checkpoint-v1", "tenant": tenant,
                "seq": tip["tip_seq"] if tip else 0, "hash": tip["tip_hash"] if tip else GENESIS,
                "key_id": self.key_id}
        return {**body, "signature": pack(self.keys.signer.sign(canonical(body).encode()))}


def decrypt_envelope(envelope: dict, encryption: AESGCM) -> bytes:
    header = {k: v for k, v in envelope.items() if k not in {"nonce", "ciphertext"}}
    return encryption.decrypt(unpack(envelope["nonce"]), unpack(envelope["ciphertext"]), canonical(header).encode())


def verify_chain(rows, tenant: str, trusted_keys: dict[str, Ed25519PublicKey], checkpoint: dict) -> dict:
    """Verify an ordered export against an independently retained signed checkpoint."""
    previous, seq = GENESIS, 0
    try:
        anchor = {key: value for key, value in checkpoint.items() if key != "signature"}
        if anchor["type"] != "aios-assurance-checkpoint-v1" or anchor["tenant"] != tenant or (
            type(anchor["seq"]) is not int or anchor["seq"] < 0
        ):
            raise ValueError("Invalid checkpoint")
        trusted_keys[anchor["key_id"]].verify(unpack(checkpoint["signature"]), canonical(anchor).encode())
        anchored = anchor["seq"] == 0 and anchor["hash"] == GENESIS
        for row in rows:
            seq += 1
            envelope = json.loads(row["envelope"])
            digest = digest_of(envelope)
            if (envelope["tenant"], row["seq"], envelope["seq"], envelope["previous"], row["digest"]) != (
                tenant, seq, seq, previous, digest,
            ) or envelope["version"] != 1:
                raise ValueError("Ledger mismatch")
            trusted_keys[envelope["key_id"]].verify(unpack(row["signature"]), bytes.fromhex(digest))
            if seq == anchor["seq"]:
                anchored = digest == anchor["hash"]
            previous = digest
        if not anchored:
            raise ValueError("Checkpoint not present")
    except (InvalidSignature, KeyError, TypeError, ValueError) as error:
        raise ValueError("Assurance audit verification failed") from error
    return {"seq": seq, "hash": previous}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    keygen = commands.add_parser("keygen", help="Generate private synthetic-demo keys")
    keygen.add_argument("path", type=Path)
    keygen.add_argument("--public-out", type=Path)
    check = commands.add_parser("verify", help="Verify ordered JSON Lines and an independent checkpoint")
    check.add_argument("tenant")
    check.add_argument("--ledger", type=Path, required=True)
    check.add_argument("--checkpoint", type=Path, required=True)
    check.add_argument("--public-key", type=Path, action="append", required=True)
    args = parser.parse_args()
    if args.action == "verify":
        trusted = {}
        for path in args.public_key:
            entry = json.loads(path.read_text())
            raw = unpack(entry["public_key"])
            if sha256(raw).hexdigest() != entry["key_id"]:
                raise ValueError("Public key fingerprint mismatch")
            trusted[entry["key_id"]] = Ed25519PublicKey.from_public_bytes(raw)
        anchor = json.loads(args.checkpoint.read_text())
        with args.ledger.open() as source:
            result = verify_chain((json.loads(line) for line in source), args.tenant, trusted, anchor)
        print(canonical(result))
        return
    signer = Ed25519PrivateKey.generate()
    with os.fdopen(os.open(args.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump({"signing": pack(signer.private_bytes_raw()), "encryption": pack(os.urandom(32))}, output)
    if args.public_out:
        with args.public_out.open("x") as output:
            json.dump({"key_id": sha256(signer.public_key().public_bytes_raw()).hexdigest(),
                       "public_key": pack(signer.public_key().public_bytes_raw())}, output)


if __name__ == "__main__":
    main()
