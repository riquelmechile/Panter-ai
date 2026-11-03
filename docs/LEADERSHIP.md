# Líder configurable del workforce (`PANTER_LEAD_HOST`)

Panter tiene un solo orquestador ("líder"). El líder configura perfiles, delega trabajo, lee resultados completos, maneja el harness ODD y la memoria curada. Todos los demás hosts son workers.

Hasta v0.15 el líder estaba fijo en `gpt-a`. Ahora se define con `PANTER_LEAD_HOST` (`gpt-a`, `gpt-b`, `grok`, `gemini` o `claude`). Sin la variable, todo funciona igual que antes, con GPT-A como líder.

## Qué cambia con `PANTER_LEAD_HOST=claude`

- Claude es el único que puede usar las tools de líder: `panter_mesh_profile_set`, `panter_mesh_delegate*`, `panter_workforce_status`, `panter_workforce_result_get`, `panter_harness_*`, revisiones 4R y memoria curada.
- GPT-A pasa a ser worker, igual que GPT-B, Grok y Gemini: puede hacer `pickup`, `claim`, `complete`, `wait`, app turns y recibir MCP Events, que antes eran exclusivos de GPT-B y Gemini.
- El líder no puede tomar trabajo de worker ni delegarse a sí mismo.
- Los mensajes de error y las descripciones de las tools nombran al líder configurado.

## Lo que no cambia

- El líder sale solo de la configuración del proceso, nunca de argumentos de tools ni de scopes pedidos por un cliente. Un valor inválido aborta el arranque.
- El scope `panter:lead` se concede en el consentimiento solo al host líder. Hoy el servidor autoriza al líder por identidad (`principal`), no por ese scope, así que cambiar de líder no obliga a reconectar las apps.
- El nombre del modo `GPT_A_ONLY` se mantiene por compatibilidad con los datos guardados; significa "solo el líder, sin delegación remota".

## Cambio de líder en un despliegue existente

1. Detener Panter y respaldar `data/`.
2. Agregar `PANTER_LEAD_HOST=claude` al archivo de entorno y arrancar.
3. Desde el nuevo líder, configurar los perfiles de los workers (GPT-A, GPT-B, Grok, Gemini) con `panter_mesh_profile_set`.

El trabajo y los resultados creados por el líder anterior quedan como historial: el nuevo líder no los lee como propios.

## Pendiente

- Agent Studio (`src/ui/agent-studio.ts`) todavía muestra a GPT-A como orquestador. Con otro líder, los perfiles se configuran con `panter_mesh_profile_set` hasta actualizar la interfaz.
