# Líder configurable del workforce (`PANTER_LEAD_HOST`)

Panter tiene un solo orquestador ("líder"). El líder configura perfiles, delega trabajo, lee resultados completos, maneja el harness ODD y la memoria curada. Todos los demás hosts son workers.

Hasta v0.15 el líder estaba fijo en `gpt-a`. Ahora se define con `PANTER_LEAD_HOST` (`gpt-a`, `gpt-b`, `grok`, `gemini` o `claude`). Sin la variable, todo funciona igual que antes, con GPT-A como líder.

## Qué cambia con `PANTER_LEAD_HOST=claude`

- **Tools de líder:** solo Claude puede usar `panter_mesh_profile_set`, `panter_mesh_delegate*`, `panter_workforce_status`, `panter_workforce_result_get`, `panter_harness_*`, las revisiones 4R y la memoria curada.
- **GPT-A como worker:** pasa a trabajar igual que GPT-B, Grok y Gemini. Puede usar `pickup`, `claim`, `heartbeat`, `complete`, `wait`, los app turns y los MCP Events, que antes eran exclusivos de GPT-B y Gemini.
- **El líder no hace trabajo de worker:** no puede usar `claim`, `heartbeat`, `complete`, `pickup`, `wait`, los app turns ni los eventos.
- **El líder no se delega a sí mismo:** no puede mandarse trabajo, ni directamente ni por los bindings de especialistas ni por la Routine de wake.
- **Política de modelo:** con un líder que no es ChatGPT se usa la política nativa del host (`host-selected`). La política de ChatGPT (`gpt-6-astra`) queda solo para GPT-A y GPT-B.
- **Mensajes y Agent Studio** nombran al líder configurado.

## Garantías

- **Origen del líder:** sale solo de la configuración del proceso, nunca de argumentos de tools ni de scopes pedidos por un cliente. Se valida y se congela al arrancar, antes de abrir cualquier store. Un valor inválido aborta el arranque, y si el entorno cambia después, el líder no cambia.
- **Scope `panter:lead`:** se concede solo al host líder, tanto en el consentimiento como en cada token emitido, refresh incluido. Así, un líder anterior pierde el scope en su próximo refresh.
- **Modo `GPT_A_ONLY`:** el nombre se mantiene por compatibilidad con los datos guardados. Significa "solo el líder, sin delegación remota".

## Modo OAuth y cambio de líder

- **`embedded` (el canary actual):** el servidor autoriza al líder por identidad (`principal`), no por scope. Cambiar de líder no obliga a reconectar las apps.
- **`external-jwt`:** el verificador exige `panter:lead` en el token del líder. Antes de cambiar `PANTER_LEAD_HOST`, el IdP debe emitir ese scope al nuevo líder. Si no, todas sus llamadas fallan con `<Líder> leader scope required`.

## Cambio de líder en un despliegue existente

1. Detener Panter y respaldar `data/`.
2. Agregar `PANTER_LEAD_HOST=claude` al archivo de entorno y arrancar.
3. Desde el nuevo líder, configurar los perfiles de los workers (GPT-A, GPT-B, Grok, Gemini) con `panter_mesh_profile_set` o desde Agent Studio.

Panter guarda en su ledger quién era el líder. Si al arrancar el líder configurado es otro, migra solo y lo registra en el log (`Panter leader switch gpt-a -> claude`):

- **Trabajo dirigido al nuevo líder**, que ya nadie podría tomar:
  - si estaba en `QUEUED`, queda `ABORTED_NO_EFFECTS`;
  - si era de solo lectura (revisión, verificación, exploración) y estaba en curso, queda `ABORTED_NO_EFFECTS`;
  - si era de implementación en curso, queda `OUTCOME_UNKNOWN`, para pasar por la reconciliación de siempre.
- **Revisiones remotas afectadas** quedan `INTERRUPTED`. El harness cierra sus lentes que siguen en cola (`ABORTED_NO_EFFECTS`) y abre un intento nuevo.
- **Mensajes de workers al líder anterior** pasan al nuevo líder.
- **Fases nativas ODD abiertas** del líder anterior las adopta el nuevo. El ledger guarda una marca de adopción pendiente que se borra solo cuando la adopción termina, así que si Panter se cae a mitad de camino, la adopción se repite en el siguiente arranque.
- **Política exclusiva del líder** (`coordinationMode`, `preferNativeSubagents`, `maxRequestedNativeWorkers`) pasa del líder anterior al nuevo, porque es del rol y no del host. Así `GPT_A_ONLY` se mantiene después del cambio.
- **Perfiles:**
  - si el líder no tenía perfil, se le crea uno;
  - el del líder queda solo con el rol `orchestrator` y sin ajustes de worker;
  - los workers pierden el rol `orchestrator` y los ajustes exclusivos del líder;
  - el líder anterior puede quedar sin roles hasta que lo configures.
- **Bindings de especialistas que apuntan al líder** quedan inactivos y se ven como no asignados. Se pueden reasignar a un worker con revisión 0, y mientras tanto las revisiones usan fases nativas.
- **Revisiones nativas 4R y Judgment Day** guardan el modelo y el esfuerzo con que se congelaron, así que siguen siendo legibles después del cambio.

Un ledger vacío no cuenta como cambio de líder. Pero un ledger anterior a este cambio, sin líder registrado, se trata como liderado por GPT-A para las fases nativas: el nuevo líder las adopta aunque el mesh esté vacío. Los mensajes que el nuevo líder mandó cuando era worker se quedan con el líder anterior, así que nunca queda uno dirigido a sí mismo. Hay un solo líder por proceso y solo el líder crea trabajo, así que el nuevo líder ve los resultados del trabajo que delegó el anterior: inbox, `resultGet` y el estado de los wakes de Grok y Claude.

Agent Studio toma el líder de `panter_gentle_catalog` (`leaderHost`).
