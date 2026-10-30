# Revisión final de Claude — seguridad, merge y Oracle (31-oct-2026)

**Objeto:** PR #1, rama `feat/initial-a2a-mesh-v0.3.0`, base `main`. Antes de leer cualquier código, obtener el HEAD ACTUAL desde la API de GitHub y registrar el SHA completo. El reporte previo de Claude en `62695dc6` es una excelente base, pero NO constituye revisión del nuevo HEAD. Este documento es un encargo de revisión, no una aprobación o autorización automática.

## 0. Evidencia de GitHub del mismo SHA

Usando la identidad real de Claude conectada a GitHub (read-only sirve para inspección; permisos para review solo si se publicará):
- Confirmar PR abierto y no draft, labels, `type:*` único, issue #2 con `status:approved`, 15 hilos Codex resueltos y issue #4 actualizado. Revisar reglas de rama, CODEOWNERS y necesidad de aprobación independiente; no sustituir requisitos de protección por comentarios.
- Examinar TODOS los archivos cambiados y confirmar que el diff grande es el bootstrap `single-pr` explícitamente autorizado, no una excepción universal. Comprobar SHA exacto de los jobs `test` y `arm64-image`; registros de CI desde otro SHA son insuficientes.
- Validar `package-lock.json` y `npm ci` desde checkout limpio, TypeScript, build, tests, `smoke:http`, `smoke:oauth`, `smoke:embedded`, `npm audit`, imagen `linux/arm64`. Verificar que no entraron credenciales, cambios de modelo, llaves privadas o rutas inseguras.

## 1. Código — reconciliación de escrituras inciertas (Claude #1)

`src/core/mesh.ts`, `src/core/auto-harness.ts`, `src/server.ts`, `tests/mesh.test.ts` y `tests/auto-harness.test.ts`.

- El cambio `OUTCOME_UNKNOWN` exige al operador (no GPT-A ni un peer) inspeccionar el trabajo real y declarar `CONFIRMED_COMPLETE` con SHA, runId, evidencia, o `CONFIRMED_NO_EFFECTS` solo tras verificar ausencia de efectos. Revisar race de worker tardío, leaseGeneration y attemptId vencidos, escritor paralelo, reinicio y mismo work ID.
- La confirmación de resultado debe producir el recibo correcto sin repetir side effects. La confirmación de no-efectos debe soltar el scope y generar un NUEVO idempotency key generacional; nunca reejecutar un trabajo incierto por detectar timeout. Verificar que el operador realmente puede asegurar que el worker no sigue vivo antes de elegir no-efectos.
- Revisar el patrón de escritura JSON atómica, control de concurrencia, auditabilidad de la decisión y necesidad de una confirmación externa de Git SHA/worktree.

## 2. Código — revocación y consentimiento OAuth (Claude #2, #4, #6)

`src/core/embedded-oauth.ts`, `src/server.ts`, `scripts/smoke-embedded.mjs`, `tests/embedded-oauth.test.ts`.

- Verificar que `panter_oauth_clients` y `panter_oauth_client_revoke` son operator-only; que no hay otra herramienta A2A capaz de invocarlas; que la revocación invalida access/refresh/grants/codes/pending y persiste tras reinicio, sin editar `oauth.json` externamente.
- `/revoke`: la posesión del token es legítima para public clients de RFC7009, pero ataques anónimos deben estar limitados por IP real y por borde; tokens falsos no reescriben el ledger, y una revocación auténtica sí se persiste. Revisar consumo de CPU/datos bajo ataques con miles de tokens válidos/distintos.
- `/oauth/consent`: nombre y callback compartidos son **NO VERIFICADOS**; se muestran ID, antigüedad y mensaje de advertencia sin XSS; CSRF, PKCE, origin, scopes y política de redirección siguen siendo correctos. La advertencia no prueba propiedad de la cuenta ChatGPT: revisar el residual phishing risk.

## 3. Seguridad del administrador — *nuevo límite de seguridad* (Claude #5)

`src/server.ts`, `scripts/smoke-embedded.mjs`, `docs/ORACLE_ARM.md`, `.env.example`.

- En `embedded` y `external-jwt`, una credencial `PANTER_OPERATOR_TOKEN` nunca crea actor `admin` en el listener TCP, **ni desde 127.0.0.1, ni si Host=localhost, sin XFF, ni detrás de nginx/cloudflared**. Confirmar 401 por TCP en prueba HTTP real.
- El actor admin existe solo mediante `PANTER_ADMIN_SOCKET` de tipo Unix, ACL `0600` bajo directorio propio, y token distinto; sin rutas de proxy hacia él. Asegurar que un symlink o socket ocupado no permite cambiar de propietario, que un reinicio detecta socket obsoleto con comprobación kernel de `ECONNREFUSED` e inode, y que nunca borra uno activo.
- Confirmar la semántica de los headers MCP 2026-07-28 para herramientas en socket y que los clientes normales OAuth no llaman tools admin. Revisar `dev-static`: debe permanecer privado y nunca utilizarse como modo público.

## 4. Rate limiting / identidad detrás de proxy — nuevo límite de confianza (Claude #3)

`src/core/trusted-proxy.ts`, `src/core/embedded-oauth.ts`, `tests/trusted-proxy.test.ts`, `tests/embedded-oauth.test.ts`, `docs/nginx-panter.conf.example`.

- `PANTER_TRUSTED_PROXY_CIDRS` NO se infiere: solo se aceptan IP/CIDR explícitos del transporte conectado, no `X-Forwarded-For` arbitrario. Si el peer es confiable, exigir `X-Panter-Client-IP` único y validado; si no lo es, ignorar por completo el header. Probar dos IPs reales bajo el mismo proxy, spoofing directo, listas ambiguas, falta de header, IPv4-mapped e IPv6.
- **Límites de aplicación no reemplazan WAF/edge:** verificar que nginx/cloudflared borra o sobrescribe cualquier `X-Panter-Client-IP` de cliente antes de enviar al backend; que `$remote_addr` sea realmente el IP externo tras una cadena Cloudflare de confianza, no siempre localhost o bridge Docker. Probar los límites por IP en `/register`, `/authorize`, `/token` y `/revoke`.
- Verificar limits del edge por origen y globales; 100 plazas activas de DCR en memoria son un techo de capacidad, no una defensa suficiente contra bots distribuidos. No exponer público sin DNS, trust CIDRs y edge rules realmente instalados y probados.

## 5. Política ODD/4R/Judgment Day (sin regresiones)

- Preservar exactamente `src/core/policy.ts` y las exigencias al host: GPT-A solicita `gpt-6-astra`, esfuerzo `max`/`xhigh` compatible, Fast preferido, subagentes nativos paralelos hasta límite host 32, sin API de proveedor. El host debe confirmar capacidad real, nunca declararla como observada por inferencia.
- GPT-A puede hacer cuatro lentes 4R **solo** en serie, pero con estado `SOLO_4R_COMPLETED_UNVERIFIED`, nunca aprobación independiente. Revisores nativos necesitan evidencias firmadas de runner distinto, SHA exacto, escritor/integrador/correctores excluidos de revisar su propio candidato.
- Judgment Day requiere dos jueces ciegos realmente separados; cambios SHA reinician las pruebas de revisión. RDD, GitHub gate y autorización humana de merge son puertas distintas.

## 6. Prueba de despliegue privado en Oracle ARM64 (NO ejecutar sin autorización)

- La cuenta/host Oracle y dominio exacto aún deben verificarse; Panter debe ser un Compose/container separado de Xanxittoo, con puertos, volúmenes y secretos independientes.
- Comprobar listener TCP del Panter solo dentro del proxy y socket admin privado no publicado ni en el tunnel ni en nginx. Validar salud, OAuth discovery, PKCE, consentimiento, `/mcp` 401 sin token, acceso operador SOLO por socket, persistencia y reinicio.
- Confirmar real client IP/edge rate limiting desde dos clientes diferentes. Capturar backup de volumen Panter y verificar un rollback. No se toca Xanxittoo ni el DNS existente.
- Probar ChatGPT y Claude como clientes reales **después** de que las políticas de proxy y OAuth sean correctas. Un build/health OK no prueba compatibilidad con hosts ni aislamiento de subagentes.

## Dictamen solicitado a Claude

Publicar una revisión SHA-bound en GitHub PR #1 con: identidad del revisor, commit exacto, pruebas realmente ejecutadas y logs/enlaces, hallazgos con archivo:línea y severidad, estado de todos los gates, riesgos residuales y **dos decisiones separadas**: (A) `merge a main` y (B) `canary privado/publicación`. Nunca firmar una certificación 4R ajena sin el runner real. Una revisión APPROVE no autoriza por sí misma el despliegue, y cualquier commit posterior exige revisión de los cambios nuevos.
