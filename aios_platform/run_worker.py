"""Consume approvals as a separate process using the ERP write identity."""
import argparse
import os
import time

from .contracts import Identifier
from .service import services, setting
from .workflow import tick
from pydantic import TypeAdapter


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    runtime = services(worker=True)
    configured = os.getenv("AIOS_WORKER_TENANTS", "harbour,island") if runtime.demo else setting("AIOS_CONNECTOR_TENANT")
    tenants = tuple(TypeAdapter(Identifier).validate_python(value.strip()) for value in configured.split(","))
    while True:
        worked = [tick(runtime.workflow, runtime.erp, tenant) for tenant in tenants]
        if args.once:
            return
        if not any(worked):
            time.sleep(0.5)


if __name__ == "__main__":
    main()
