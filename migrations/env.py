"""Run versioned SQL with the migration identity, outside the API and worker."""
from collections.abc import Mapping

from alembic import context
from sqlalchemy import String, create_engine, pool, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError

from aios_platform.service import setting


def _ensure_postgres_alembic_version(connection) -> None:
    """Widen PostgreSQL alembic_version.version_num to VARCHAR(64) before running migrations."""
    if connection.dialect.name != "postgresql":
        return
    row = connection.execute(
        text(
            "SELECT character_maximum_length "
            "FROM information_schema.columns "
            "WHERE table_schema = current_schema() "
            "AND table_name = 'alembic_version' "
            "AND column_name = 'version_num'"
        )
    ).fetchone()
    if row is None:
        connection.execute(
            text(
                "CREATE TABLE alembic_version ("
                "version_num VARCHAR(64) NOT NULL, "
                "CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
            )
        )
        return
    max_len = row["character_maximum_length"] if isinstance(row, Mapping) else row[0]
    if max_len is not None and max_len < 64:
        connection.execute(
            text("ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(64)")
        )


def _parse_migration_url(raw_dsn: str) -> URL:
    """Parse an RFC-style SQLAlchemy URL or a libpq keyword/value conninfo string."""
    try:
        url = make_url(raw_dsn)
    except ArgumentError as url_err:
        from psycopg.conninfo import conninfo_to_dict

        try:
            info = conninfo_to_dict(raw_dsn)
        except Exception as exc:
            raise url_err from exc
        if not any(key in info for key in ("dbname", "host", "hostaddr", "service", "user")):
            raise url_err
        port_raw = info.get("port")
        url = URL.create(
            "postgresql+psycopg",
            username=info.get("user") or None,
            password=info.get("password") or None,
            host=info.get("host") or None,
            port=int(port_raw) if port_raw else None,
            database=info.get("dbname") or None,
            query={
                k: str(v)
                for k, v in info.items()
                if k not in {"user", "password", "host", "port", "dbname"}
            },
        )
    if url.drivername in {"postgres", "postgresql"}:
        url = url.set(drivername="postgresql+psycopg")
    return url


def run_migrations() -> None:
    """Execute online or offline migrations with PostgreSQL revision ID length safety."""
    url = _parse_migration_url(setting("AIOS_MIGRATION_DATABASE_URL"))

    if context.is_offline_mode():
        context.configure(url=url, literal_binds=True)
        is_pg = url.get_backend_name() == "postgresql"
        if is_pg:
            migration_ctx = context.get_context()
            version_table = getattr(migration_ctx, "_version", None)
            if version_table is not None and "version_num" in version_table.c:
                version_table.c.version_num.type = String(64)
        with context.begin_transaction():
            if is_pg:
                context.execute(
                    "DO $$\n"
                    "BEGIN\n"
                    "    IF EXISTS (\n"
                    "        SELECT 1 FROM information_schema.columns\n"
                    "        WHERE table_schema = current_schema()\n"
                    "          AND table_name = 'alembic_version'\n"
                    "          AND column_name = 'version_num'\n"
                    "          AND character_maximum_length IS NOT NULL\n"
                    "          AND character_maximum_length < 64\n"
                    "    ) THEN\n"
                    "        ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(64);\n"
                    "    END IF;\n"
                    "END\n"
                    "$$"
                )
            context.run_migrations()
    else:
        engine = create_engine(url, poolclass=pool.NullPool)
        try:
            with engine.connect() as connection:
                if connection.dialect.name == "postgresql":
                    with connection.begin():
                        _ensure_postgres_alembic_version(connection)
                context.configure(connection=connection)
                with context.begin_transaction():
                    context.run_migrations()
        finally:
            engine.dispose()


if __name__ == "__main__" or getattr(context, "config", None) is not None:
    run_migrations()
