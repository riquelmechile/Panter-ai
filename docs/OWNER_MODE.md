# Modo dueño (`PANTER_OWNER_MODE=1`)

Para un despliegue de un solo dueño: todas las cuentas conectadas (Claude, GPT-A, GPT-B, Grok, Gemini) las opera la misma persona. Las restricciones que solo protegen contra hosts que el dueño no controla pasan a ser avisos. Se activa con `PANTER_OWNER_MODE=1` en `panter.env` y un reinicio. El valor queda fijo durante la vida del proceso, igual que el líder.

## Qué cambia

| Antes | En modo dueño |
|---|---|
| Escribir exige un permiso del operador (`panter_harness_write_grant`) atado al texto exacto del objetivo, de un solo uso, máximo 24 h y 16 rutas | El permiso es opcional: la delegación del líder es la autorización. Sigue disponible para fijar una corrida a rutas acotadas |
| `panter_mesh_delegate` con rol `implementer` siempre fallaba con `Authorized run required` | El líder delega escritores directo |
| Un escritor necesitaba rutas explícitas | Sin rutas = todo el repositorio |
| Los despertares (Grok, eventos MCP, Claude Routine, sondeo programado) rechazaban escritores y a un host ocupado | Aceptan escritores, y el trabajo queda en cola detrás del que está ocupado |
| `panter_mesh_delegate_auto` solo delegaba si el trabajador había llamado en los últimos 2 minutos | Elige al trabajador alcanzable (escucha en vivo, eventos MCP, webhook de Grok, Routine de Claude o correo de Gemini) con menos carga |
| Palabras como "deploy", "permisos", "seguridad" o "migración" y no listar rutas mandaban la corrida a descubrimiento + diseño + verificación + 4R | Son un aviso. Solo una observación explícita (`requirementsClear:false`, `resumableFromDiff:false`) o Judgment Day piden la ruta completa |
| El portón de entrega bloqueaba por nombre de rama, etiqueta `type:*`, issue con `status:approved`, formato de commits, `Co-Authored-By`, tamaño del PR y cantidad de commits | Eso pasa a avisos. Siguen bloqueando: SHA exacto, PR abierto y no borrador, base autorizada, CI requerida en verde y la aprobación de la cuenta revisora |
| Los permisos GitHub automáticos por fase exigían `PANTER_HARNESS_AUTO_GITHUB_GRANTS=1` | Activos |
| Hasta 2 correcciones por corrida | Hasta 10 |
| Un trabajador que solo sondea por horario no tomaba escritores | Los toma |
| Las unidades paralelas debían caber en rutas listadas | Con todo el repo como alcance, cualquier conjunto de unidades disjuntas |

Además, en cualquier modo:
- `panter_workforce_status` agrega por trabajador `wakeRoutes` (cómo se le puede despertar ahora), `last24h` (completados, fallados y último resultado) y `reachable`. `presence` sigue midiendo solo los últimos 2 minutos.
- `panter_mesh_withdraw` (por el router `panter_mesh`, operación `withdraw`): el líder retira trabajo en cola que nadie empezó y revoca su permiso GitHub.

## Qué no cambia

- Los trabajadores nunca mergean, aprueban, borran, hacen push forzado ni escriben ramas por defecto o protegidas, `.github/workflows`, CODEOWNERS o configuración de git.
- Los tokens y secretos se quedan en el servidor.
- Misiones sensibles: no se guardan ni se mandan por correo datos personales.
- Dos escritores de la misma misión nunca corren a la vez sobre rutas que se cruzan (un escritor sin rutas, todo el repo, se cruza con cualquiera).
- Un `writeGrantId` entregado explícitamente se valida y se aplica igual que antes.
- Sin `PANTER_GITHUB_INDEPENDENT_REVIEWER` configurado, el portón de entrega bloquea: el revisor independiente es la compuerta que reemplaza a las convenciones.
- El correo de Gemini nunca lleva escritores.
- Los servidores downstream mantienen su política `writes` y sus propias aprobaciones.
