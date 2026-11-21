"""Local Tesseract.js fallback for hosts without the native Tesseract CLI."""
from pathlib import Path
import shutil
import subprocess


def wasm_tsv(encoded: bytes, segmentation: str = "6", whitelist: str = "") -> bytes:
    node = shutil.which("node")
    if node is None:
        raise OSError("Install Tesseract with English data or Node with tesseract.js")
    script = Path(__file__).with_name("tesseract.cjs")
    result = subprocess.run([node, str(script), segmentation, whitelist], input=encoded, capture_output=True,
                            check=True, timeout=30)
    return result.stdout

