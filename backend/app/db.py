"""Conexao com o banco.

Por padrao usa SQLite (arquivo local) para rodar sem docker.
No compose, DATABASE_URL aponta para o Postgres.
"""

import os

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./tracker.db")


class Base(DeclarativeBase):
    pass


engine = create_async_engine(DATABASE_URL, echo=False, future=True, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session():
    async with SessionLocal() as session:
        yield session


async def init_db() -> None:
    from app import models  # noqa: F401  (registra as tabelas no metadata)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
