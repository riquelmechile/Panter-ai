# Montar tu propio Panter

Este repositorio es público y genérico: no trae cuentas, dominios, tokens ni contraseñas de nadie. Todo lo que es tuyo va en la configuración de **tu** servidor, fuera de Git.

## Pasos

1. Clona el repo (o un fork) en tu servidor.
2. Copia `deploy/panter.env.example` a un lugar fuera del árbol del repo, por ejemplo `~/panter-ai/etc/panter.env`, con permisos `0600`.
3. Complétalo con tus valores. Lo mínimo:
   - `PANTER_PUBLIC_MCP_URL`, `PANTER_ALLOWED_HOSTS` y `PANTER_ALLOWED_ORIGINS`: tu dominio.
   - `PANTER_AUTH_MODE=embedded`, `PANTER_CONSENT_PASSWORD` y `PANTER_OPERATOR_TOKEN`: secretos aleatorios propios (`openssl rand -hex 32`).
   - `PANTER_OAUTH_REDIRECT_URIS`: los callbacks de las apps que vas a conectar (ChatGPT, Claude, Grok, Gemini).
   - `PANTER_LEAD_HOST`: qué host orquesta (`claude`, `gpt-a`, …).
   - GitHub, si lo usas: `PANTER_GITHUB_ALLOWED_REPOS`, `PANTER_GITHUB_WORKFORCE_REPOS` (`tu-org/*`), `PANTER_GITHUB_WORKFORCE_TOKEN` y `PANTER_GITHUB_INDEPENDENT_REVIEWER` (tu cuenta revisora, ver [INDEPENDENT_REVIEW_IDENTITY.md](INDEPENDENT_REVIEW_IDENTITY.md)).
   - Despertares, si los usas: `PANTER_WAKE_GROK_URL`/`PANTER_WAKE_GROK_KEY`, `PANTER_WAKE_CLAUDE_*`, `PANTER_GEMINI_MAIL_*`.
   - `PANTER_OWNER_MODE=1` si todas las cuentas conectadas son tuyas ([OWNER_MODE.md](OWNER_MODE.md)).
4. Despliega con `deploy/deploy.sh <sha>` ([OPERATIONS.md](OPERATIONS.md)) o con Docker ([ORACLE_ARM.md](ORACLE_ARM.md)).
5. Conecta cada app a `https://<tu-dominio>/mcp` y apruébala en la pantalla de consentimiento con tu `PANTER_CONSENT_PASSWORD`. Cada cliente aprobado queda amarrado a un host.

## Qué nunca va al repositorio

- `panter.env` y cualquier `.env` (el `.gitignore` ya los excluye; solo se versionan los `.example`).
- Tokens de GitHub, de los despertares, de servidores downstream y la contraseña de consentimiento.
- El directorio de datos (`PANTER_DATA_DIR`): base SQLite, clientes y tokens OAuth, auditorías.
- Nombres de tus cuentas, dominios o rutas de tu servidor: van en `panter.env`, no en el código ni en los docs.

`tests/public-repo-hygiene.test.ts` corre en CI y falla si un archivo versionado trae una credencial con formato real o si los ejemplos de configuración traen valores en vez de marcadores.
