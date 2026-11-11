"""Tela de super admin: todos os clientes num lugar so + relatorio no WhatsApp.

O include em app.main ja exige `auth.require_super` em tudo daqui.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app import superadmin
from app.db import get_session

router = APIRouter(prefix="/api/superadmin", tags=["superadmin"])


class SettingsIn(BaseModel):
    report_phone: str | None = None
    sender_number_id: int | None = None
    daily_enabled: bool | None = None
    daily_time: str | None = None
    alert_on_disconnect: bool | None = None


@router.get("/overview")
async def get_overview(session: AsyncSession = Depends(get_session)):
    return await superadmin.overview(session)


@router.get("/settings")
async def get_settings(session: AsyncSession = Depends(get_session)):
    return await superadmin.load_settings(session)


@router.put("/settings")
async def put_settings(payload: SettingsIn, session: AsyncSession = Depends(get_session)):
    # exclude_unset: `sender_number_id: null` enviado de proposito volta pro automatico
    try:
        return await superadmin.save_settings(session, payload.model_dump(exclude_unset=True))
    except superadmin.ReportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/report/preview")
async def preview_report(session: AsyncSession = Depends(get_session)):
    """O texto exato que sairia agora, sem enviar nada."""
    return {"text": superadmin.build_report(await superadmin.overview(session))}


@router.post("/report/send")
async def send_report(session: AsyncSession = Depends(get_session)):
    try:
        result = await superadmin.send_report(session)
    except superadmin.ReportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {**result, "settings": await superadmin.load_settings(session)}
