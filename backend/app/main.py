"""Plataforma de rastreamento de WhatsApp -> conversao em campanha.

Fluxo: anuncio Click to WhatsApp -> a pessoa manda mensagem -> a **Evolution API**
entrega a mensagem crua no nosso webhook, com o `ctwaClid` do anuncio -> o lead
fica gravado com a atribuicao -> quando o ATENDENTE responde com a palavra-chave
configurada, o evento sai pro Meta com o valor certo.

Duas superficies:

* tela principal — conectar a instancia da Evolution, informar Pixel + token da
  Conversions API e cadastrar as regras de palavra-chave (com simulador);
* area de admin — prospeccao no mapa, CRM global, abordagem ativa, Cloud API e
  destinos extras (Google Ads, webhook generico), so pra perfil admin.

O painel inteiro fica atras de login (JWT; veja app.auth): sem token valido, /api
responde 401. Publicos so o /api/health, o /api/auth/login e os /webhook/*, que a
Evolution e a Meta chamam e que se autenticam por conta propria.

A plataforma atende VARIAS linhas ao mesmo tempo: cada linha e uma instancia da
Evolution com Pixel, token e regras proprios.
"""

import logging
import os

from fastapi import Depends, FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select

from app import auth
from app import numbers as numbers_service
from app.db import SessionLocal, init_db
from app.models import Contact, Conversion, Dispatch, KeywordRule, Outreach, Prospect
from app.routers import auth as auth_router
from app.routers import config as config_router
from app.routers import contacts as contacts_router
from app.routers import conversions as conversions_router
from app.routers import crm as crm_router
from app.routers import evolution as evolution_router
from app.routers import numbers as numbers_router
from app.routers import prospecting as prospecting_router
from app.routers import rules as rules_router
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

# A protecao mora aqui, no include: qualquer rota nova desses routers ja nasce
# fechada, sem depender de alguem lembrar de decorar a funcao.
_logged_in = [Depends(auth.require_user)]
_admin_only = [Depends(auth.require_admin)]

# login: as unicas rotas de /api que respondem sem token (o proprio router fecha
# /me, /password e o cadastro de usuarios)
app.include_router(auth_router.router)

# --- rastreamento: o que a tela principal usa, pra qualquer usuario logado ---
app.include_router(evolution_router.router, dependencies=_logged_in)
app.include_router(rules_router.router, dependencies=_logged_in)
app.include_router(crm_router.router, dependencies=_logged_in)
app.include_router(contacts_router.router, dependencies=_logged_in)
app.include_router(conversions_router.router, dependencies=_logged_in)

# --- so admin (prospeccao, Cloud API, destinos extras) ---
app.include_router(config_router.router, dependencies=_admin_only)
app.include_router(numbers_router.router, dependencies=_admin_only)
app.include_router(prospecting_router.router, dependencies=_admin_only)

# --- publico: quem chama e a Evolution/Meta, autenticando pelo token da URL ou
# pela assinatura do payload ---
app.include_router(webhook_router.router)


@app.on_event("startup")
async def on_startup() -> None:
    await init_db()
    async with SessionLocal() as session:
        # base nova (ou vinda da versao sem login) precisa de alguem pra entrar
        await auth.ensure_bootstrap_user(session)
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


@app.get("/api/stats", dependencies=_logged_in)
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
        numbers_count = len(await numbers_service.list_numbers(session, channel="evolution"))
        rules_count = (await session.execute(select(func.count(KeywordRule.id)))).scalar_one()
        rule_conversions = (
            await session.execute(
                scoped(
                    select(func.count(Conversion.id))
                    .join(Contact, Contact.id == Conversion.contact_id)
                    .where(Conversion.source == "rule"),
                    Contact,
                )
            )
        ).scalar_one()

    return {
        "contacts": total_contacts,
        "attributed_contacts": attributed,
        "conversions": total_conversions,
        "dispatches": by_status,
        "prospects": total_prospects,
        "outreach_sent": outreach_sent,
        "prospects_replied": replied,
        "numbers": numbers_count,
        "rules": rules_count,
        "rule_conversions": rule_conversions,
    }
