# Superficie de herramientas por rol y routers por dominio

Panter registra más de 100 herramientas. Entregárselas todas a cada host hace que el modelo elija peor y gaste contexto, sobre todo en hosts como ChatGPT o Gemini. Desde este cambio, cada host ve una lista corta y ordenada, **sin perder ninguna capacidad**.

## Qué cambia y qué no

- **Nada se bloquea.** Todas las herramientas siguen registradas y se pueden llamar por su nombre, igual que antes, con su misma autorización (`requireLeader`, `requireAdmin`, permisos de GitHub, etc.).
- **Solo cambia `tools/list`.** Cada host ve los 8 routers por dominio más las herramientas de su flujo normal:
  - **Líder:** harness, revisión, delegación y perfiles, estado del workforce, permisos de GitHub, memoria y Agent Studio (con las herramientas que su UI llama por nombre), unas 47 en total.
  - **Worker** (GPT-A, GPT-B, Grok, Gemini cuando no son líder): pickup, claim, heartbeat, complete, wait/listen y GitHub del trabajo, unas 29. La memoria de Engram es solo del líder. Se deja amplio a propósito: un host como ChatGPT solo puede llamar herramientas que ve listadas, así que todas las rutas que usan las rutinas de los hosts siguen listadas.
  - **Operador** (token de operador, socket Unix): todo.
- **Todo es alcanzable desde los routers.** Un host que necesita una herramienta que no ve la usa a través del router de su dominio.
- El rol se calcula en cada conexión desde la identidad autenticada; si cambia el líder (`PANTER_LEAD_HOST`), cambia la lista.

## Routers

`panter_harness`, `panter_review`, `panter_mesh`, `panter_workforce`, `panter_github`, `panter_memory`, `panter_catalog` y `panter_admin`.

Hay dos niveles: dominio → operación. A propósito no es un árbol más profundo, porque cada nivel extra es otra llamada de ida y vuelta.

```json
{"operation": "index"}
{"operation": "index", "arguments": {"operation": "delivery_strategy_set"}}
{"operation": "delivery_strategy_set", "arguments": {"runId": "…", "strategy": "single-pr", "expectedRevision": 3}}
```

- `index` lista las operaciones del dominio: nombre corto, herramienta, si es de solo lectura y si está listada para tu rol.
- Con `arguments.operation`, `index` devuelve la descripción completa y el esquema de entrada.
- La operación acepta el nombre corto (`tick`) o el completo (`panter_harness_tick`).
- Los routers no se marcan como de solo lectura, porque también llegan a escrituras. Una herramienta que declare un esquema de salida solo se llama por su nombre, para no saltarse la validación del SDK.
- Los argumentos se validan con el mismo esquema de la herramienta y se llama al mismo handler.
- Un router solo enruta su propio dominio.

## Volver a la lista completa

`PANTER_TOOL_SURFACE=all` vuelve a listar todas las herramientas para todos los roles. El valor por defecto es `role`.

## Servidores MCP downstream

Cada servidor MCP montado detrás de Panter ([DOWNSTREAM_MCP.md](DOWNSTREAM_MCP.md)) aparece como un router propio, `panter_ds_<nombre>`, fuera de los ocho routers de dominio. Solo se lista para los hosts que su configuración permite (y para el operador). Los hosts no permitidos pueden llamarlo por nombre, pero el gateway lo rechaza y queda en el audit. `panter_downstream_status` y `panter_downstream_audit` están en la lista del líder; `panter_downstream_grant` y `panter_downstream_revoke` son solo del operador.
