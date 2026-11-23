"""Strict local workspace jail preventing path traversal, symlink escape, and sensitive file access."""
from __future__ import annotations

import os
from pathlib import Path


class SandboxViolationError(PermissionError):
    """Raised when a path escapes the workspace sandbox or violates containment policy."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class SensitivePathError(SandboxViolationError):
    """Raised when a path targets secrets, system directories, credentials, or sealed files."""


_SENSITIVE_FILENAMES = frozenset({
    ".env",
    ".reviewer-pass.local.json",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    "authorized_keys",
    "known_hosts",
    "id_rsa",
    "id_rsa.pub",
    "id_dsa",
    "id_dsa.pub",
    "id_ecdsa",
    "id_ecdsa.pub",
    "id_ed25519",
    "id_ed25519.pub",
    "soul.md",
    "store.sqlite",
    "erp.sqlite",
    "ledger.sqlite",
})

_SENSITIVE_DIR_NAMES = frozenset({
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    ".git",
})

_SENSITIVE_SUFFIXES = (
    ".sqlite",
    ".sqlite3",
    ".db",
    ".sqlite-wal",
    ".sqlite-shm",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".kdbx",
)

_FORBIDDEN_SYSTEM_PREFIXES = (
    "/etc",
    "/var/lib/aios",
    "/opt/aios",
    "/proc",
    "/sys",
    "/root",
)


def _is_sensitive_segment(segment: str) -> bool:
    lower = segment.lower()
    if lower in _SENSITIVE_FILENAMES or lower in _SENSITIVE_DIR_NAMES:
        return True
    if lower.startswith(".env."):
        return True
    if any(lower.endswith(suffix) for suffix in _SENSITIVE_SUFFIXES):
        return True
    return False


def _matches_forbidden_system_prefix(raw_or_real: str) -> bool:
    normalized = raw_or_real.replace("\\", "/").rstrip("/").lower()
    for prefix in _FORBIDDEN_SYSTEM_PREFIXES:
        if normalized == prefix or normalized.startswith(f"{prefix}/"):
            return True
    return False


class WorkspaceSandbox:
    """Path jail strictly confined to `root_dir` using canonical `os.path.realpath` checks."""

    def __init__(self, root_dir: str | Path) -> None:
        raw_root = os.fspath(root_dir)
        if not raw_root or "\x00" in raw_root:
            raise ValueError("Workspace root directory must be a valid non-empty path.")
        resolved = Path(os.path.realpath(raw_root))
        if not resolved.exists():
            raise FileNotFoundError(f"Workspace root directory does not exist: {resolved}")
        if not resolved.is_dir():
            raise NotADirectoryError(f"Workspace root path is not a directory: {resolved}")
        self.root_dir: Path = resolved
        self._real_root_str: str = str(resolved)

    def _check_sensitive_components(self, raw_path: str, resolved_path: Path) -> None:
        if _matches_forbidden_system_prefix(raw_path) or _matches_forbidden_system_prefix(
            str(resolved_path)
        ):
            raise SensitivePathError(
                "SENSITIVE_SYSTEM_PATH",
                f"Access denied to protected system path: {raw_path}",
            )

        for part in Path(raw_path).parts:
            if _is_sensitive_segment(part):
                raise SensitivePathError(
                    "SENSITIVE_FILE_BLOCKED",
                    f"Access denied to sensitive file or directory: {part}",
                )

        try:
            rel_parts = resolved_path.relative_to(self.root_dir).parts
        except ValueError:
            rel_parts = resolved_path.parts

        for part in rel_parts:
            if _is_sensitive_segment(part):
                raise SensitivePathError(
                    "SENSITIVE_FILE_BLOCKED",
                    f"Access denied to sensitive file or directory: {part}",
                )

    def _ensure_within_root(self, candidate_real: str, raw_display: str) -> None:
        try:
            common = os.path.commonpath([self._real_root_str, candidate_real])
        except ValueError as exc:
            raise SandboxViolationError(
                "SANDBOX_DRIVE_MISMATCH",
                f"Path is on a different drive/root outside workspace: {raw_display}",
            ) from exc
        if common != self._real_root_str:
            raise SandboxViolationError(
                "SANDBOX_ESCAPE",
                f"Path resolves outside workspace sandbox: {raw_display}",
            )

    def resolve_path(
        self,
        candidate: str | Path,
        *,
        allow_nonexistent: bool = False,
    ) -> Path:
        """Resolve `candidate` strictly inside `root_dir`, rejecting traversal, symlink escape, and sensitive files."""
        raw = os.fspath(candidate).strip()
        if not raw:
            raise SandboxViolationError("EMPTY_PATH", "Path must not be empty.")
        if "\x00" in raw or any(ord(ch) < 32 for ch in raw):
            raise SandboxViolationError(
                "INVALID_PATH_CHARS",
                "Path contains forbidden control or NUL characters.",
            )

        raw_posix = raw.replace("\\", "/")
        raw_parts = Path(raw_posix).parts
        if ".." in raw_parts:
            raise SandboxViolationError(
                "PATH_TRAVERSAL",
                f"Parent directory traversal ('..') is forbidden: {raw}",
            )

        if _matches_forbidden_system_prefix(raw_posix):
            raise SensitivePathError(
                "SENSITIVE_SYSTEM_PATH",
                f"Access denied to protected system path: {raw}",
            )

        candidate_path = Path(raw_posix)
        joined = candidate_path if candidate_path.is_absolute() else (self.root_dir / candidate_path)

        # Reject symlink chains that point outside `root_dir`, even if dangling.
        cur = self.root_dir if not candidate_path.is_absolute() else Path(joined.anchor or "/")
        rel_check_parts = (
            candidate_path.parts
            if not candidate_path.is_absolute()
            else joined.parts[1:]
        )
        for part in rel_check_parts:
            if part in ("", "."):
                continue
            cur = cur / part
            if os.path.islink(cur):
                link_real = os.path.realpath(cur)
                self._ensure_within_root(link_real, raw)

        real_target_str = os.path.realpath(joined)
        self._ensure_within_root(real_target_str, raw)
        resolved = Path(real_target_str)

        self._check_sensitive_components(raw_posix, resolved)

        if not allow_nonexistent and not resolved.exists():
            raise FileNotFoundError(f"Workspace path does not exist: {raw}")

        return resolved

    def relative_posix(self, resolved_path: Path) -> str:
        """Return clean POSIX relative path inside `root_dir`."""
        return resolved_path.relative_to(self.root_dir).as_posix() or "."

    def read_text(self, path: str | Path, *, max_bytes: int = 1_048_576) -> str:
        resolved = self.resolve_path(path, allow_nonexistent=False)
        if not resolved.is_file():
            raise IsADirectoryError(f"Expected a file inside workspace: {path}")
        raw_bytes = resolved.read_bytes()
        if len(raw_bytes) > max_bytes:
            raise ValueError(f"File exceeds max readable byte cap ({max_bytes} bytes).")
        return raw_bytes.decode("utf-8", errors="replace")

    def write_text(
        self,
        path: str | Path,
        content: str,
        *,
        overwrite: bool = True,
    ) -> Path:
        resolved = self.resolve_path(path, allow_nonexistent=True)
        if resolved == self.root_dir:
            raise SandboxViolationError("INVALID_FILE_TARGET", "Cannot overwrite workspace root.")
        if resolved.exists() and not overwrite:
            raise FileExistsError(f"Target file already exists: {path}")
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text(content, encoding="utf-8")
        return resolved

    def write_bytes(
        self,
        path: str | Path,
        data: bytes,
        *,
        overwrite: bool = True,
    ) -> Path:
        resolved = self.resolve_path(path, allow_nonexistent=True)
        if resolved == self.root_dir:
            raise SandboxViolationError("INVALID_FILE_TARGET", "Cannot overwrite workspace root.")
        if resolved.exists() and not overwrite:
            raise FileExistsError(f"Target file already exists: {path}")
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_bytes(data)
        return resolved

    def list_files(self, subdir: str | Path = ".", *, max_entries: int = 200) -> list[str]:
        base = self.resolve_path(subdir, allow_nonexistent=False)
        if not base.is_dir():
            raise NotADirectoryError(f"Expected a directory inside workspace: {subdir}")
        results: list[str] = []
        for root, dirnames, filenames in os.walk(base, followlinks=False):
            # Prune sensitive directories and symlinks pointing outside jail.
            safe_dirs: list[str] = []
            for d in sorted(dirnames):
                if _is_sensitive_segment(d):
                    continue
                candidate_dir = Path(root) / d
                if os.path.islink(candidate_dir):
                    try:
                        self._ensure_within_root(os.path.realpath(candidate_dir), d)
                    except SandboxViolationError:
                        continue
                safe_dirs.append(d)
            dirnames[:] = safe_dirs

            for fname in sorted(filenames):
                if _is_sensitive_segment(fname):
                    continue
                candidate_file = Path(root) / fname
                if os.path.islink(candidate_file):
                    try:
                        self._ensure_within_root(os.path.realpath(candidate_file), fname)
                    except SandboxViolationError:
                        continue
                results.append(candidate_file.relative_to(self.root_dir).as_posix())
                if len(results) >= max_entries:
                    return results
        return results
