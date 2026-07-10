"""Alembic environment.

The database URL comes exclusively from the DATABASE_URL environment variable —
never from alembic.ini — so one config serves dev (docker-compose), CI (service
container), and prod. Migrations are hand-written op.* calls; the app uses raw
SQL, so there is no SQLAlchemy metadata to autogenerate from.
"""

from __future__ import annotations

import os

from alembic import context
from sqlalchemy import create_engine


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Alembic needs a Postgres URL, e.g. "
            "postgresql://postgres:postgres@localhost:5432/arceo"
        )
    # SQLAlchemy selects the psycopg3 driver via the +psycopg suffix; accept
    # plain postgresql:// URLs (the form everything else uses).
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def run_migrations_offline() -> None:
    context.configure(url=_database_url(), literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(_database_url())
    with engine.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
