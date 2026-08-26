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


class WaNumber(Base):
    """Um numero de WhatsApp gerido pela plataforma.

    Cada numero e uma linha independente: credenciais proprias da Cloud API e,
    opcionalmente, destinos de conversao proprios (`overrides`). O que nao for
    sobrescrito aqui cai na configuracao global de `settings`.

    Todo lead, prospect e abordagem carrega o numero de onde veio — e assim que
    a plataforma atende varios clientes sem misturar base.
    """

    __tablename__ = "wa_numbers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    label: Mapped[str] = mapped_column(String(120))                      # "Clinica X", "Loja Centro"
    phone_number_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    business_account_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    access_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    app_secret: Mapped[str | None] = mapped_column(String(255), nullable=True)
    verify_token: Mapped[str | None] = mapped_column(String(255), nullable=True)
    graph_version: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # cache do ultimo /status — evita bater na Graph API so pra desenhar a lista
    display_phone_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    verified_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    quality_rating: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)

    # subconjunto das chaves de settings_store.DEFAULTS. Chave ausente = herda o global.
    overrides: Mapped[dict] = mapped_column(JSON, default=dict)

    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
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
    # por qual linha esse lead entrou. O mesmo wa_id falando com dois numeros
    # gera dois contatos — cada um com a atribuicao da sua campanha.
    wa_number_id: Mapped[int | None] = mapped_column(
        ForeignKey("wa_numbers.id", ondelete="SET NULL"), index=True, nullable=True
    )

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
    phone_number_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    wa_number_id: Mapped[int | None] = mapped_column(
        ForeignKey("wa_numbers.id", ondelete="SET NULL"), index=True, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ---------------------------------------------------------------------------
# CRM de prospeccao ativa: varredura no mapa (Apify) -> prospect -> abordagem
# no WhatsApp -> quando responde, vira Contact e entra no fluxo de conversao.
# ---------------------------------------------------------------------------

# Etapas do funil. A ordem aqui e a ordem que a UI mostra.
STAGES = ("novo", "contatado", "respondeu", "qualificado", "ganho", "perdido")


class ProspectSearch(Base):
    """Uma varredura por raio: o que rodou no Apify e o que voltou dela."""

    __tablename__ = "prospect_searches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    label: Mapped[str] = mapped_column(String(240))
    wa_number_id: Mapped[int | None] = mapped_column(
        ForeignKey("wa_numbers.id", ondelete="SET NULL"), index=True, nullable=True
    )
    terms: Mapped[list] = mapped_column(JSON, default=list)          # ["clinica odontologica"]
    center_lat: Mapped[float] = mapped_column(Float)
    center_lng: Mapped[float] = mapped_column(Float)
    radius_km: Mapped[float] = mapped_column(Float)
    location_label: Mapped[str | None] = mapped_column(Text, nullable=True)  # endereco digitado
    max_per_term: Mapped[int] = mapped_column(Integer, default=50)

    actor: Mapped[str] = mapped_column(String(120), default="compass/crawler-google-places")
    apify_run_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    dataset_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    apify_input: Mapped[dict] = mapped_column(JSON, default=dict)

    # queued -> running -> succeeded | failed. `imported` = resultado ja virou prospect.
    status: Mapped[str] = mapped_column(String(16), default="queued")
    imported: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    items_found: Mapped[int] = mapped_column(Integer, default=0)
    prospects_new: Mapped[int] = mapped_column(Integer, default=0)
    prospects_dupe: Mapped[int] = mapped_column(Integer, default=0)
    prospects_skipped: Mapped[int] = mapped_column(Integer, default=0)  # fora do raio / sem telefone
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    prospects: Mapped[list["Prospect"]] = relationship(back_populates="search")


class Prospect(Base):
    """Um potencial cliente achado no mapa. E o registro do CRM."""

    __tablename__ = "prospects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # a varredura e so a procedencia: apagar a busca nao apaga o lead do CRM.
    search_id: Mapped[int | None] = mapped_column(
        ForeignKey("prospect_searches.id", ondelete="SET NULL"), index=True, nullable=True
    )
    place_id: Mapped[str | None] = mapped_column(String(120), index=True, nullable=True)
    # de quem e esse lead. O dedupe por place_id/telefone acontece DENTRO do numero:
    # dois clientes podem prospectar a mesma empresa sem se atrapalhar.
    wa_number_id: Mapped[int | None] = mapped_column(
        ForeignKey("wa_numbers.id", ondelete="SET NULL"), index=True, nullable=True
    )

    name: Mapped[str] = mapped_column(String(240))
    category: Mapped[str | None] = mapped_column(String(160), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    city: Mapped[str | None] = mapped_column(String(120), nullable=True)
    state: Mapped[str | None] = mapped_column(String(120), nullable=True)

    phone_e164: Mapped[str | None] = mapped_column(String(32), index=True, nullable=True)
    phone_raw: Mapped[str | None] = mapped_column(String(48), nullable=True)
    phone_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)  # mobile | landline | unknown
    website: Mapped[str | None] = mapped_column(Text, nullable=True)
    email: Mapped[str | None] = mapped_column(String(240), nullable=True)

    rating: Mapped[float | None] = mapped_column(Float, nullable=True)
    reviews_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    distance_km: Mapped[float | None] = mapped_column(Float, nullable=True)
    maps_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    stage: Mapped[str] = mapped_column(String(16), default="novo", index=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # preenchido quando o prospect responde no WhatsApp — amarra o CRM ao tracking.
    contact_id: Mapped[int | None] = mapped_column(
        ForeignKey("contacts.id", ondelete="SET NULL"), index=True, nullable=True
    )
    last_outreach_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    replied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    raw: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    search: Mapped["ProspectSearch | None"] = relationship(back_populates="prospects")
    outreaches: Mapped[list["Outreach"]] = relationship(
        back_populates="prospect", cascade="all, delete-orphan", order_by="Outreach.id"
    )


class Outreach(Base):
    """Uma tentativa de abordagem ativa no WhatsApp, com request e response crus."""

    __tablename__ = "outreaches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    prospect_id: Mapped[int] = mapped_column(ForeignKey("prospects.id", ondelete="CASCADE"), index=True)
    wa_number_id: Mapped[int | None] = mapped_column(
        ForeignKey("wa_numbers.id", ondelete="SET NULL"), index=True, nullable=True
    )

    kind: Mapped[str] = mapped_column(String(16), default="template")  # template | text
    template_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    template_language: Mapped[str | None] = mapped_column(String(16), nullable=True)
    body_preview: Mapped[str | None] = mapped_column(Text, nullable=True)

    to_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    wamid: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # queued -> sent | failed. `skipped` = barrado pelo cap diario ou sem telefone.
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    request_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    response_body: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    prospect: Mapped["Prospect"] = relationship(back_populates="outreaches")
