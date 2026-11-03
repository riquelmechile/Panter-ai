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
2. Revisar el trabajo pendiente. Lo que esté en `QUEUED` o `RUNNING` hacia el futuro líder no lo podrá tomar nadie después del cambio, así que hay que cerrarlo o reconciliarlo antes.
3. Agregar `PANTER_LEAD_HOST=claude` al archivo de entorno y arrancar. Al abrir, Panter normaliza los perfiles: el del líder queda con el rol `orchestrator` y ningún worker conserva ese rol. Los bindings de especialistas que apuntan al líder quedan inactivos, y las revisiones vuelven a fases nativas hasta reasignarlos a un worker.
4. Desde el nuevo líder, configurar los perfiles de los workers (GPT-A, GPT-B, Grok, Gemini) con `panter_mesh_profile_set` o desde Agent Studio.

Agent Studio reconoce al líder por el perfil que tiene el rol `orchestrator`. Si ese perfil todavía no existe, la interfaz asume GPT-A: hay que guardar primero el modo de coordinación del líder (`panter_native_mode_set`), que crea su perfil.

Hay un solo líder por proceso y solo el líder crea trabajo. Por eso el nuevo líder ve y puede leer los resultados del trabajo que delegó el anterior: inbox, `resultGet` y el estado de los wakes de Grok y Claude.
