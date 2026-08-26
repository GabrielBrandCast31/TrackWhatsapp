"""Plataforma de trackeamento de WhatsApp -> conversao em campanha.

Fluxo: anuncio Click to WhatsApp -> webhook da Cloud API entrega o ctwa_clid ->
a gente guarda o lead com a atribuicao -> voce dispara o evento de conversao pro
Meta CAPI / Google Ads / webhook proprio e ve a resposta crua de cada destino.

A plataforma atende VARIOS numeros de WhatsApp ao mesmo tempo. Cada numero e uma
linha isolada — leads, CRM e destinos de conversao proprios — e o roteamento do
webhook e feito pelo `phone_number_id` que a Meta manda no payload.
"""

import logging
import os

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select

from app import numbers as numbers_service
from app.db import SessionLocal, init_db
from app.models import Contact, Conversion, Dispatch, Outreach, Prospect
from app.routers import config as config_router
from app.routers import contacts as contacts_router
from app.routers import conversions as conversions_router
from app.routers import numbers as numbers_router
from app.routers import prospecting as prospecting_router
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
app.include_router(numbers_router.router)
app.include_router(contacts_router.router)
app.include_router(conversions_router.router)
app.include_router(prospecting_router.router)
app.include_router(webhook_router.router)


@app.on_event("startup")
async def on_startup() -> None:
    await init_db()
    async with SessionLocal() as session:
        # primeira subida em multi-numero: a config antiga vira o numero #1
        await numbers_service.seed_from_global_settings(session)
    # fila de abordagem que sobrou de um restart volta a andar sozinha
    async with SessionLocal() as session:
        pending = (
            await session.execute(select(func.count(Outreach.id)).where(Outreach.status == "queued"))
        ).scalar_one()
    if pending:
        logging.getLogger(__name__).info("retomando %s abordagem(ns) na fila", pending)
        prospecting_router.start_queue_worker()


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/stats")
async def stats(number_id: int | None = Query(default=None)):
    """Numeros do topo da tela. Com `number_id`, so daquela linha."""

    def scoped(stmt, model):
        return stmt if number_id is None else stmt.where(model.wa_number_id == number_id)

    async with SessionLocal() as session:
        total_contacts = (
            await session.execute(scoped(select(func.count(Contact.id)), Contact))
        ).scalar_one()
        attributed = (
            await session.execute(
                scoped(
                    select(func.count(Contact.id)).where(
                        (Contact.ctwa_clid.is_not(None))
                        | (Contact.gclid.is_not(None))
                        | (Contact.wbraid.is_not(None))
                        | (Contact.gbraid.is_not(None))
                    ),
                    Contact,
                )
            )
        ).scalar_one()

        conv_stmt = select(func.count(Conversion.id))
        dispatch_stmt = select(Dispatch.status, func.count()).group_by(Dispatch.status)
        if number_id is not None:
            conv_stmt = conv_stmt.join(Contact, Contact.id == Conversion.contact_id).where(
                Contact.wa_number_id == number_id
            )
            dispatch_stmt = (
                dispatch_stmt.join(Conversion, Conversion.id == Dispatch.conversion_id)
                .join(Contact, Contact.id == Conversion.contact_id)
                .where(Contact.wa_number_id == number_id)
            )
        total_conversions = (await session.execute(conv_stmt)).scalar_one()
        by_status = dict((await session.execute(dispatch_stmt)).all())

        total_prospects = (
            await session.execute(scoped(select(func.count(Prospect.id)), Prospect))
        ).scalar_one()
        outreach_sent = (
            await session.execute(
                scoped(select(func.count(Outreach.id)).where(Outreach.status == "sent"), Outreach)
            )
        ).scalar_one()
        replied = (
            await session.execute(
                scoped(select(func.count(Prospect.id)).where(Prospect.replied_at.is_not(None)), Prospect)
            )
        ).scalar_one()
        numbers_count = len(await numbers_service.list_numbers(session))

    return {
        "contacts": total_contacts,
        "attributed_contacts": attributed,
        "conversions": total_conversions,
        "dispatches": by_status,
        "prospects": total_prospects,
        "outreach_sent": outreach_sent,
        "prospects_replied": replied,
        "numbers": numbers_count,
    }
