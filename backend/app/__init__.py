"""Carrega o .env antes de qualquer submodulo de app.

`settings_store` le os.getenv no import, entao o .env precisa estar em memoria
antes disso. No docker o env_file do compose ja resolve; rodando uvicorn na mao
(o caminho do README) e aqui que o .env da raiz do projeto entra.
Variavel ja definida no ambiente sempre ganha do arquivo.
"""

from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv(usecwd=True), override=False)
