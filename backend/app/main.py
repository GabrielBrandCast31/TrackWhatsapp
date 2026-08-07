"""Plataforma de trackeamento de WhatsApp -> conversao em campanha.

Fluxo: anuncio Click to WhatsApp -> webhook da Cloud API entrega o ctwa_clid ->
a gente guarda o lead com a atribuicao -> voce dispara o evento de conversao pro
Meta CAPI / Google Ads / webhook proprio e ve a resposta crua de cada destino.
"""

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select

from app.db import SessionLocal, init_db
from app.models import Contact, Conversion, Dispatch
from app.routers import config as config_router
from app.routers import contacts as contacts_router
from app.routers import conversions as conversions_router
from app.routers import webhook as webhook_router

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

app = FastAPI(title="WhatsApp Conversion Tracker", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(config_router.router)
app.include_router(contacts_router.router)
app.include_router(conversions_router.router)
app.include_router(webhook_router.router)


@app.on_event("startup")
async def on_startup() -> None:
    await init_db()


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/stats")
async def stats():
    async with SessionLocal() as session:
        total_contacts = (await session.execute(select(func.count(Contact.id)))).scalar_one()
        attributed = (
            await session.execute(
                select(func.count(Contact.id)).where(
                    (Contact.ctwa_clid.is_not(None))
                    | (Contact.gclid.is_not(None))
                    | (Contact.wbraid.is_not(None))
                    | (Contact.gbraid.is_not(None))
                )
            )
        ).scalar_one()
        total_conversions = (await session.execute(select(func.count(Conversion.id)))).scalar_one()
        by_status = dict(
            (
                await session.execute(select(Dispatch.status, func.count()).group_by(Dispatch.status))
            ).all()
        )
    return {
        "contacts": total_contacts,
        "attributed_contacts": attributed,
        "conversions": total_conversions,
        "dispatches": by_status,
    }
