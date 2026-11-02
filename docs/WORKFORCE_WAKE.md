# Workforce / Wake Gateway — fase 1 (sin activación externa)

Panter-ai es Xanxittoo 2.0. GPT-A es el único orquestador; GPT-B, Claude,
Grok y Gemini son los cuatro trabajadores. Kimi no forma parte del contrato.
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
   protocolo 2025/2026, usando componentes de Xanxittoo y DevZana ADR-002/M5.
   Mantener **una sola cola autoritativa** y no enviar instrucciones por wake.
2. Incorporar controles de wake externo por superficie y validación anti-replay,
   anti-SSRF, autenticación, cuotas, circuit breaker y revocación.
3. Probar rutas reales de Grok, Claude, GPT-A/GPT-B y Gemini con sus conexiones
   existentes. Registrar evidencias positivas y negativas por actor, sin
   asumir soporte de background por el mero hecho de tener MCP.
4. Integrar selección automática de transporte en harness solo después de
   prueba de disponibilidad; caso contrario continuar inline/nativo o
   `WAITING_CAPABILITY` sin crear workers ficticios.

**No se instala ni se activa un servicio. No modifica Xanxittoo, Oracle o
Cloudflare.** Revisar PR y CI SHA exacto antes de merge y E2E antes de producción.

## Fase 2A: long-poll por actor (sin wake externo)

- `panter_workforce_wait(protocolEra,waitSeconds)` mantiene una llamada MCP
  autenticada abierta un máximo de **20 segundos**, con **una espera por
  trabajador** (cuatro en total). No hace inferencia, no reclama tareas, no
  mantiene una sesión de modelo viva por sí mismo y no crea otra cola.
- El servidor registra primero el listener por identidad y después consulta
  el ledger Mesh; cuando se persiste una delegación, el evento posterior al
  commit despierta únicamente la espera de ese actor. Recupera el candidato
  desde SQLite, nunca desde un evento con instrucciones.
- Al expirar el tiempo devuelve `TIMED_OUT`; un cliente puede repetir la
  operación respetando sus límites y permisos. Desregistra el listener tanto
  en éxito como al fallar. Una sesión desconectada sin cancelación explícita
  puede ocupar el único slot de ese actor hasta su vencimiento (máx. 20 s).
- Una modificación de perfil o un resultado ajeno no constituye Work para
  ese worker. `autonomousWakeVerified` sigue siendo `false`.
- Este adaptador **no implementa** todavía el método estándar MCP
  `subscriptions/listen` ni la extensión `io.modelcontextprotocol/tasks`;
  la notificación genérica ya existente permanece independiente. No afirmar
  compatibilidad Task wire basada en esta herramienta.
- El listener de esta fase es **local a una réplica**: no sirve para varias
  instancias sin bus de eventos compartido.


## Fase 2B
La compatibilidad mediante herramientas no equivale a los métodos wire MCP Tasks 2026. Los resultados íntegros se conservan en el backend y el ACK del trabajador es compacto. El rearme se registra en SQLite. El soporte autónomo de los hosts requiere E2E verificadas.
