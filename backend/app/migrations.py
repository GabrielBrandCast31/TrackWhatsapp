"""Migracoes leves de schema, rodadas no startup.

`create_all` cria tabela nova mas nao mexe em tabela que ja existe. Como o banco
de producao aqui e um SQLite/Postgres pequeno e o unico tipo de mudanca ate agora
e "coluna nova opcional", um ALTER TABLE idempotente resolve sem trazer Alembic.
"""

import logging

from sqlalchemy import inspect, text

log = logging.getLogger(__name__)

# tabela -> coluna -> tipo SQL (compativel com SQLite e Postgres)
_COLUMNS: dict[str, dict[str, str]] = {
    "contacts": {
        "wa_number_id": "INTEGER",
        # CRM por linha
        "stage": "VARCHAR(16)",
        "stage_changed_at": "TIMESTAMP",
        "note": "TEXT",
        "origin": "VARCHAR(16)",
        "profile_pic_url": "TEXT",
        "last_message_at": "TIMESTAMP",
        "last_message_body": "TEXT",
        "last_message_from_me": "BOOLEAN",
        "unread_count": "INTEGER",
        "synced_at": "TIMESTAMP",
    },
    "prospects": {"wa_number_id": "INTEGER"},
    "prospect_searches": {"wa_number_id": "INTEGER"},
    "outreaches": {"wa_number_id": "INTEGER"},
    "webhook_logs": {"wa_number_id": "INTEGER", "phone_number_id": "VARCHAR(64)"},
    # linha passou a ter canal: Evolution API (padrao) ou Cloud API (admin)
    "wa_numbers": {
        "channel": "VARCHAR(16)",
        "evo_base_url": "TEXT",
        "evo_api_key": "TEXT",
        "evo_instance": "VARCHAR(120)",
        "evo_state": "VARCHAR(32)",
        "evo_owner_jid": "VARCHAR(64)",
        "webhook_token": "VARCHAR(64)",
    },
    # de onde veio o evento: botao, regra de palavra-chave ou primeiro contato
    "conversions": {"source": "VARCHAR(16)", "rule_id": "INTEGER"},
}

# coluna nova com valor obrigatorio: ALTER TABLE cria com NULL, e o backfill
# deixa a base antiga coerente com o default do modelo.
_BACKFILL: tuple[tuple[str, str, str], ...] = (
    ("wa_numbers", "channel", "'cloud'"),   # linha que ja existia e Cloud API
    ("conversions", "source", "'manual'"),
    ("contacts", "stage", "'novo'"),
    ("contacts", "origin", "'webhook'"),
    ("contacts", "unread_count", "0"),
    # BOOLEAN: o literal precisa ser FALSE, nao 0 — o Postgres recusa o integer
    # (DatatypeMismatchError) e o SQLite aceita FALSE desde a 3.23.
    ("contacts", "last_message_from_me", "FALSE"),
)

# indices unicos que deixaram de ser unicos ao virar multi-numero
_DROP_INDEXES = ("ix_prospects_place_id",)


def _add_missing_columns(conn) -> None:
    inspector = inspect(conn)
    tables = set(inspector.get_table_names())
    for table, columns in _COLUMNS.items():
        if table not in tables:
            continue  # create_all acabou de criar com tudo no lugar
        existing = {c["name"] for c in inspector.get_columns(table)}
        for name, sql_type in columns.items():
            if name in existing:
                continue
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))
            log.info("migracao: %s.%s adicionada", table, name)


def _relax_unique_indexes(conn) -> None:
    """place_id passou a ser unico POR NUMERO, entao o indice unico global sai.

    O escopo por numero e garantido no import (`_import_results`), nao no banco:
    um indice composto exigiria recriar a tabela no SQLite.
    """
    inspector = inspect(conn)
    if "prospects" not in set(inspector.get_table_names()):
        return
    for index in inspector.get_indexes("prospects"):
        if index["name"] in _DROP_INDEXES and index.get("unique"):
            conn.execute(text(f'DROP INDEX {index["name"]}'))
            conn.execute(text(f'CREATE INDEX {index["name"]} ON prospects (place_id)'))
            log.info("migracao: indice %s deixou de ser unico", index["name"])


def _backfill(conn) -> None:
    inspector = inspect(conn)
    tables = set(inspector.get_table_names())
    for table, column, value in _BACKFILL:
        if table not in tables:
            continue
        if column not in {c["name"] for c in inspector.get_columns(table)}:
            continue
        result = conn.execute(
            text(f"UPDATE {table} SET {column} = {value} WHERE {column} IS NULL")
        )
        if result.rowcount:
            log.info("migracao: %s.%s preenchida em %s linha(s)", table, column, result.rowcount)


def upgrade(conn) -> None:
    _add_missing_columns(conn)
    _relax_unique_indexes(conn)
    _backfill(conn)
