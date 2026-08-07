"""Tabelas da plataforma de trackeamento."""

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Setting(Base):
    """Config editavel pela UI (token, pixel id, credenciais Google...).

    Guardada em key/value para nao precisar de migration a cada campo novo.
    """

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Contact(Base):
    """Uma pessoa que iniciou conversa no WhatsApp, com o rastreio de origem."""

    __tablename__ = "contacts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    wa_id: Mapped[str] = mapped_column(String(32), index=True)
    phone_e164: Mapped[str | None] = mapped_column(String(32), nullable=True)
    name: Mapped[str | None] = mapped_column(String(160), nullable=True)

    # --- atribuicao Meta (Click to WhatsApp) ---
    ctwa_clid: Mapped[str | None] = mapped_column(String(512), index=True, nullable=True)
    source_id: Mapped[str | None] = mapped_column(String(64), nullable=True)      # ad id
    source_type: Mapped[str | None] = mapped_column(String(32), nullable=True)    # "ad" | "post"
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    ad_headline: Mapped[str | None] = mapped_column(Text, nullable=True)
    ad_body: Mapped[str | None] = mapped_column(Text, nullable=True)

    # --- atribuicao Google ---
    gclid: Mapped[str | None] = mapped_column(String(255), index=True, nullable=True)
    wbraid: Mapped[str | None] = mapped_column(String(255), nullable=True)
    gbraid: Mapped[str | None] = mapped_column(String(255), nullable=True)

    utm: Mapped[dict] = mapped_column(JSON, default=dict)
    first_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    phone_number_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    messages: Mapped[list["Message"]] = relationship(back_populates="contact", cascade="all, delete-orphan")
    conversions: Mapped[list["Conversion"]] = relationship(back_populates="contact", cascade="all, delete-orphan")

    @property
    def has_attribution(self) -> bool:
        return bool(self.ctwa_clid or self.gclid or self.wbraid or self.gbraid)


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    contact_id: Mapped[int] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), index=True)
    wamid: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    direction: Mapped[str] = mapped_column(String(8), default="in")  # in | out
    msg_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    contact: Mapped["Contact"] = relationship(back_populates="messages")


class Conversion(Base):
    """Um evento de conversao registrado para um contato."""

    __tablename__ = "conversions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    contact_id: Mapped[int] = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), index=True)
    event_name: Mapped[str] = mapped_column(String(64), default="Lead")
    event_id: Mapped[str] = mapped_column(String(80), unique=True)  # dedup entre CAPI e Pixel
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    currency: Mapped[str] = mapped_column(String(8), default="BRL")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_test: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    contact: Mapped["Contact"] = relationship(back_populates="conversions")
    dispatches: Mapped[list["Dispatch"]] = relationship(
        back_populates="conversion", cascade="all, delete-orphan", order_by="Dispatch.id"
    )


class Dispatch(Base):
    """Tentativa de envio de uma conversao para um destino especifico."""

    __tablename__ = "dispatches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversion_id: Mapped[int] = mapped_column(ForeignKey("conversions.id", ondelete="CASCADE"), index=True)
    destination: Mapped[str] = mapped_column(String(32))  # meta_capi | google_ads | webhook
    status: Mapped[str] = mapped_column(String(16), default="pending")  # ok | error | skipped
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    request_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    response_body: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    conversion: Mapped["Conversion"] = relationship(back_populates="dispatches")


class WebhookLog(Base):
    """Payload cru de tudo que a Meta manda — indispensavel pra depurar tracking."""

    __tablename__ = "webhook_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
