# Superficie de herramientas por rol y routers por dominio

Panter registra más de 100 herramientas. Entregárselas todas a cada host hace que el modelo elija peor y gaste contexto, sobre todo en hosts como ChatGPT o Gemini. Desde este cambio, cada host ve una lista corta y ordenada, **sin perder ninguna capacidad**.

## Qué cambia y qué no

- **Nada se bloquea.** Todas las herramientas siguen registradas y se pueden llamar por su nombre, igual que antes, con su misma autorización (`requireLeader`, `requireAdmin`, permisos de GitHub, etc.).
- **Solo cambia `tools/list`.** Cada host ve los 8 routers por dominio más las herramientas de su flujo normal:
  - **Líder:** harness, revisión, delegación, estado del workforce, permisos de GitHub y memoria (unas 39).
  - **Worker** (GPT-A, GPT-B, Grok, Gemini cuando no son líder): pickup, claim, heartbeat, complete, wait/listen, GitHub del trabajo y memoria (unas 32). Se deja amplio a propósito: un host como ChatGPT solo puede llamar herramientas que ve listadas, así que todas las rutas que usan las rutinas de los hosts siguen listadas.
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
- Los argumentos se validan con el mismo esquema de la herramienta y se llama al mismo handler.
- Un router solo enruta su propio dominio.

## Volver a la lista completa

`PANTER_TOOL_SURFACE=all` vuelve a listar todas las herramientas para todos los roles. El valor por defecto es `role`.

## Downstream (próximo paso)

Los routers son el punto donde se montarán los MCP downstream, empezando por commerce-control (MercadoLibre). Cada downstream aparecerá como sus propios routers por dominio, con su propia aprobación, y Panter pondrá encima identidad, permisos y auditoría. El código del downstream no se copia dentro de Panter.
