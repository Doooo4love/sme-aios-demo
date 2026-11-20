"""Run versioned SQL with the migration identity, outside the API and worker."""
from alembic import context
from sqlalchemy import create_engine, pool
from sqlalchemy.engine import make_url

from aios_platform.service import setting

url = make_url(setting("AIOS_MIGRATION_DATABASE_URL"))
if url.drivername in {"postgres", "postgresql"}:
    url = url.set(drivername="postgresql+psycopg")

if context.is_offline_mode():
    context.configure(url=url, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    engine = create_engine(url, poolclass=pool.NullPool)
    try:
        with engine.connect() as connection:
            context.configure(connection=connection)
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()
