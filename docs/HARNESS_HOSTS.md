# El harness con los hosts como equipo

Claude es el único líder: arranca el harness (`panter_harness_start`), avanza las fases (`panter_harness_tick`) y hace la síntesis, la revisión formal, el merge y el deploy. Cada fase la ejecuta el agente especialista que corresponde, en el host al que está asignado (`panter_specialist_bind`). El host recibe el paquete congelado del agente (prompt, skills y reglas del harness) y puede usar sus propios subagentes nativos para **esa** tarea; nunca delega a otros hosts ni actúa por otro.

## Asignación

| Agente | Fase | Host |
|---|---|---|
| gentle-ai-explore | Descubrir | GPT-B |
| (diseño) | Diseñar | Claude (inline) |
| gentle-ai-worker | Implementar | GPT-A |
| gentle-ai-verify | Verificar | GPT-B |
| review-risk | 4R | Grok |
| review-reliability | 4R | GPT-B |
| review-resilience | 4R | Grok |
| review-readability | 4R | Gemini |
| jd-judge-a / jd-judge-b | Judgment Day | Grok / Gemini |
| jd-fix-agent | Corrección | GPT-A |

Quien verifica o revisa nunca es el host que implementó (el harness lo comprueba).

## Lo que hace Panter al despachar una fase

- **Material para hosts sin acceso al repo** (`PANTER_MATERIAL_HOSTS`, por defecto `gemini`): Panter adjunta al paquete el diff del candidato contra su base (hasta ~26 KB), leído con el token del servidor. Gemini lo recibe dentro del correo. El material va marcado como datos (nunca instrucciones) y no puede imitar el cierre de su sección. Solo existe cuando hay un SHA candidato, así que a un host por correo conviene asignarle revisión o juicio, no descubrir.
- **Permiso de GitHub por fase** (solo si el operador lo autorizó con `PANTER_HARNESS_AUTO_GITHUB_GRANTS=1`, la corrida tiene repositorio y el workforce de GitHub está configurado; implementar exige además que la corrida tenga aprobación de escritura, y la rama parte de la base objetivo de la corrida): implementar → `commit` + `pr`; verificar / revisar → lectura y `comment` sobre el PR de la corrida; descubrir → lectura. El permiso de implementar solo deja hacer commits dentro de las rutas aprobadas de la corrida. Si el permiso falla al despachar, se vuelve a emitir mientras la fase espera. Los hosts con material no reciben permiso (no tienen herramientas).
- **Nota del líder en cada paquete**: al final del paquete Panter indica el repositorio y la base, cómo leer y escribir con las herramientas `panter_github_*` (no hay checkout local; se pasa `workId`, `attemptId` y `leaseGeneration` del claim) y qué puede hacer esa fase. Las fases piden además terminar con un único JSON `{"summary", "evidence", "candidateSha", "runId"}`; el harness también lo acepta dentro de un bloque de código o rodeado de texto. A los hosts por correo se les dice que solo juzguen el material.
- **Plazo para empezar**: si el host no toma la fase a tiempo (sigue en cola, o solo la tiene el transporte de correo sin respuesta), Panter la retira sin efectos y la fase pasa a ejecución nativa del líder; no se vuelve a mandar a ese host en esa corrida. Una fase que el host ya empezó nunca se retira. En la revisión 4R, si una lente se retira por no aparecer a tiempo, toda la revisión pasa a nativa y se revocan los permisos de las lentes que ya estaban corriendo; si el host alcanzó a tomarla, la revisión remota sigue.

- **Timbre de Grok**: Grok solo despierta con su webhook de rutina (`PANTER_WAKE_GROK_URL` / `PANTER_WAKE_GROK_KEY`). El harness lo toca para cada fase o lente que le despacha, un trabajo a la vez: si Grok ya tiene uno en curso o uno tocado sin tomar, el siguiente se toca en el primer tick después de que quede libre. Cada trabajo se toca una sola vez (el estado queda en `panter_workforce_grok_wake_status`). Como las lentes de Grok van en fila, conviene darle un plazo propio con `PANTER_REMOTE_PICKUP_TIMEOUT_SECONDS_GROK`.

```
PANTER_HARNESS_AUTO_GITHUB_GRANTS=1             # autorización del operador para permisos por fase
PANTER_MATERIAL_HOSTS=gemini
PANTER_REMOTE_PICKUP_TIMEOUT_SECONDS=180          # GPT-A, GPT-B, Grok
PANTER_REMOTE_PICKUP_TIMEOUT_SECONDS_MAIL=1200    # hosts por correo (Gemini)
PANTER_REMOTE_PICKUP_TIMEOUT_SECONDS_GROK=600     # opcional, plazo propio por host (GPT_A, GPT_B, GROK, GEMINI)
```

Para que el harness despache a un host, el líder lo informa como `CONNECTED` en `peerStates` del tick (los hosts con suscripción a eventos, webhook o correo se despiertan solos).
