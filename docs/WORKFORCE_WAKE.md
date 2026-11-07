# Workforce / Wake Gateway — fases 1–2C (sin activación externa)

> **Líder.** Esta página se escribió cuando el líder era siempre GPT-A. Hoy el líder es el host de `PANTER_LEAD_HOST` (por defecto `gpt-a`): donde GPT-A aparece coordinando, léase "el líder configurado". Ver [LEADERSHIP.md](LEADERSHIP.md).

El líder configurado (`PANTER_LEAD_HOST`, por defecto GPT-A) es el único orquestador;
los otros cuatro hosts son los trabajadores. Kimi no forma parte del contrato.
Las cuentas pueden estar conectadas al producto y aun así su presencia MCP
actual y su capacidad de wake permanecen desconocidas.

## Integrado

- `panter_workforce_next` permite que el **actor autenticado** consulte solo
  el Work `QUEUED` más antiguo que le corresponde como **candidato**. Retorna el identificador,
  misión y rol, jamás instrucciones, resultados o datos de otro actor.
  La elegibilidad y los grants se vuelven a verificar en `claim`. No reclama ni renueva leases, no eleva grants y nunca reintenta
  `RUNNING` o `OUTCOME_UNKNOWN`.
- `panter_workforce_status` es de solo lectura para GPT-A. Muestra exactamente
  cuatro trabajadores, las rutas **reportadas** por cada actor, presencia
  observada en llamadas MCP, el claim/receipt observado en transacciones del
  ledger y contadores agregados. No devuelve instrucciones ni resultados.
- Estado durable en **el ledger mesh SQLite actual**, sin cola secundaria,
  credenciales de proveedor ni nuevos procesos. Se conserva el aislamiento
  de actor en los handlers MCP y el fencing al reclamar y completar.
- Rutas compatibles con planificación Execution Fabric: Tasks 2026, Tasks 2025,
  Task Bridge, long-poll, webhook, polling programado y delivery-only.
  Son declaraciones del host; `routeEvidence=REPORTED_UNVERIFIED`.
  `autonomousWakeVerified=false` y `effectiveDeliveryMode=DELIVERY_ONLY`
  permanecen constantes hasta añadir verificación host-native de extremo a extremo.

## Separar evidencia

1. `profile configured`: GPT-A conoce el rol, **no** prueba conexión.
2. `presence FRESH`: se observó MCP poll/claim/receipt autenticado en
   menos de 120 s; **no** prueba que el host se haya despertado solo.
3. `claimObserved` / `receiptObserved`: el servidor registró cambios de
   estado bajo identidad y fencing. Puede ser trabajo manual atendido.
4. `wake verified`: **pendiente**. Requiere prueba real independiente
   trigger → host-session → actor OAuth → `workforce_next` → claim → receipt;
   un HTTP 2xx, una notificación SSE o un reporte propio nunca basta.

## Próximos cortes

1. Incorporar adaptadores de entrega/pickup y capacidad verificada por
   protocolo 2025/2026, 
   Mantener **una sola cola autoritativa** y no enviar instrucciones por wake.
2. Incorporar controles de wake externo por superficie y validación anti-replay,
   anti-SSRF, autenticación, cuotas, circuit breaker y revocación.
3. Probar rutas reales de Grok, Claude, GPT-A/GPT-B y Gemini con sus conexiones
   existentes. Registrar evidencias positivas y negativas por actor, sin
   asumir soporte de background por el mero hecho de tener MCP.
4. Integrar selección automática de transporte en harness solo después de
   prueba de disponibilidad; caso contrario continuar inline/nativo o
   `WAITING_CAPABILITY` sin crear workers ficticios.

**No se instala ni se activa un servicio. No modifica otros servicios del host ni
Cloudflare.** Revisar PR y CI SHA exacto antes de merge y E2E antes de producción.

## Fase 2A: long-poll por actor (sin wake externo)

- `panter_workforce_wait(protocolEra,waitSeconds)` mantiene una llamada MCP
  autenticada abierta un máximo configurable de **3.600 segundos**, con **una espera por
  trabajador** (cuatro en total). No hace inferencia, no reclama tareas, no
  mantiene una sesión de modelo viva por sí mismo y no crea otra cola.
- El servidor registra primero el listener por identidad y después consulta
  el ledger Mesh; cuando se persiste una delegación, el evento posterior al
  commit despierta únicamente la espera de ese actor. Recupera el candidato
  desde SQLite, nunca desde un evento con instrucciones.
- Cada respuesta trae `nextTool` y `nextArguments`. Si no hay trabajo
  (`IMMEDIATE_EMPTY` o `TIMED_OUT`), apunta a otra espera con `waitSeconds: 300`,
  incluso cuando la llamada anterior fue un sondeo con `waitSeconds: 0`. Así
  un worker que sigue la pista nunca cae en un bucle apretado.
- Al expirar el tiempo devuelve `TIMED_OUT`; un cliente puede repetir la
  operación respetando sus límites y permisos. Desregistra el listener tanto
  en éxito como al fallar. Una sesión desconectada sin cancelación explícita
  puede ocupar el único slot de ese actor hasta su vencimiento (máx. 3.600 s).
- Una modificación de perfil o un resultado ajeno no constituye Work para
  ese worker. `autonomousWakeVerified` sigue siendo `false`.
- Este adaptador **no implementa** todavía el método estándar MCP
  `subscriptions/listen` ni la extensión `io.modelcontextprotocol/tasks`;
  la notificación genérica ya existente permanece independiente. No afirmar
  compatibilidad Task wire basada en esta herramienta.
- El listener de esta fase es **local a una réplica**: no sirve para varias
  instancias sin bus de eventos compartido.


## Fase 2B — persistencia, bridge y resultado silencioso

- `panter_workforce_task_bridge` implementa `arm/get/cancel` como herramientas
  MCP autenticadas por actor con referencias a trabajo del ledger Mesh. El
  `protocolEra` es declarado por la llamada, **no negociado ni verificado
  por el host**: se registra compatibilidad de esquema, no un Task nativo.
- `panter_mesh_complete` conserva el resultado íntegro en SQLite, crea una
  intención durable de rearme y devuelve solo receipt compactado.
  `panter_workforce_result_get` permite a GPT-A recuperar el resultado con
  autenticación; no existe acceso cross-worker. Los eventos solo contienen
  una referencia opaca.
- Persisten los registros de transporte y rearm en el ledger Mesh SQLite ya
  utilizado, sin cola paralela. El rearme es una solicitud registrada, no un
  relanzamiento de inferencia ni una garantía de ejecución futura.
- El SDK MCP v2 ya soporta `subscriptions/listen` 2026 para notificaciones
  generales de recursos; este PR no inventa una suscripción a tareas que el
  SDK no implemente. La extensión `io.modelcontextprotocol/tasks` 2026
  sigue en Draft y **su wire nativo queda pendiente** de integración real.

**Límites verificados:** la CI prueba las operaciones del backend y los
smokes MCP HTTP/OAuth. No se ejecutaron cuentas de hosts reales ni una
prueba de recepción de Task nativo por GPT-B, Claude, Grok o Gemini.
Ninguno de esos hosts se declara `WAKE_VERIFIED`.


### Fase 2C — cadena compacta de trabajo

- `panter_workforce_pickup`: el worker autenticado toma el siguiente Work
  en estado `QUEUED` mediante el mismo claim con fencing/grants que
  `panter_mesh_claim`. Devuelve instrucciones **solo tras claim autorizado**.
  No introduce una cola paralela ni ejecuta inferencia en Panter.
- `panter_workforce_complete_and_rearm`: primero persiste el resultado,
  receipt e intención de rearme en la transacción Mesh SQLite; después
  registra el siguiente listener compat del mismo actor. Un error en el
  segundo paso retorna `PENDING_RETRY` y **no repite** los efectos ni el
  trabajo. El ACK de resultado continúa siendo compacto.
- `panter_workforce_receipts`: inbox compacto de operación normal; el
  anterior `panter_mesh_inbox` mantiene una respuesta legacy ampliada **solo
  para GPT-A** para no romper clientes existentes (menos eficiente en tokens).
  Migrar clientes a `panter_workforce_receipts` y
  `panter_workforce_result_get` antes de retirar el legacy.
- Los cambios no reemplazan el Task wire nativo de 2025/2026; los IDs de
  bridge son internos, autenticados y no se anuncian como MCP Tasks oficiales.

- Un listener que ya fue reclamado presenta `CONSUMED` y omite el puntero, aunque el registro histórico permanezca. La nueva escucha se rearma por separado tras terminalización y no permite repetir el efecto.
