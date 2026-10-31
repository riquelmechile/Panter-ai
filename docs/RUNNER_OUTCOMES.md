# Runner: estados durables y reconciliación independiente (PR #37)

**Estado:** solo biblioteca sin ejecutor, sin despliegue. Rebajada sobre main después de PRs #39, #41 y #35.

Se utiliza el helper compartido `sqlite-startup.ts` para WAL y creación de esquema; reintentos acotados solo durante el bootstrap, jamás sobre efectos o commits inciertos.

## Epoch fencing y ventana temporal

Cada apertura de escritor incrementa atómicamente `outcome_writer_epoch`; cada intención registra su epoch. `prepare` y `enterEffectWindow` exigen el epoch vigente en una transacción SQLite. Una segunda apertura bloquea nuevas ventanas del escritor anterior, pero **no cambia** una `EFFECT_WINDOW` viva a `OUTCOME_UNKNOWN` hasta el plazo. `RunnerOutcomeLedger.openReadonly(root)` permite inspección sin crear archivos, configurar WAL, mover epochs ni alterar filas.

`enterEffectWindow(id, generation, effectDeadline)` exige un deadline futuro acotado a una hora. **Su llamador debe pasar exactamente el `expiresAt` de un grant previamente verificado**; esta biblioteca no autentica por sí sola al emisor del deadline. Tras un cambio de epoch, una `INTENT` anterior queda UNKNOWN (la instancia vieja está fenced y no puede entrar en la ventana). Una `EFFECT_WINDOW` anterior solo queda UNKNOWN una vez vencido su deadline; la revisión puede hacer esa transición atómica. Filas legacy sin deadline quedan bloqueadas, no falsamente reconciliadas.

El reconciliador independiente solo acepta recibos Ed25519 SPKI `PUBLIC KEY` y exige `observedAt >= effectDeadline` **y además** `Date.now() >= effectDeadline`. Rechaza recibos prematuros, firma falsa, campos incongruentes y reutilización con contenido diferente. Un mismo comprobante verificado se acepta idempotentemente. Un `NO_EFFECT` no habilita reintentos automáticos.

## Gates pendientes

**Este PR no asegura que un proceso externo deje de realizar efectos al vencer el grant.** El ejecutor deberá imponer terminación real y fencing de subprocess/cgroups/UID al deadline y demostrarlo E2E antes de permitir `NO_EFFECT` seguro. No existe aún corte del runner, fuente real de observación ni autoridad de reconciliación desplegada. No se cierra el gate 4 ni se habilita servicio.

## Seguimiento de seguridad posterior al PR #37

Se rechaza una observación firmada con `observedAt > Date.now() + 5 minutos`, incluso si presenta el mismo comprobante previamente aceptado; no se permite saltar el control por idempotencia. La verificación del instante real y `observedAt >= effectDeadline` sigue siendo necesaria.

**Cierre normal:** en esta fase no se implementa `EFFECT_WINDOW → SUCCEEDED/FAILED` mediante un autorreporte no firmado del ejecutor. Se eligió documentarlo en vez de introducir una falsa prueba de ejecución completa: una salida de proceso no demuestra que todos sus efectos externos se hayan consolidado. Para registrar resultado, incluso el mismo escritor que abrió la ventana deberá obtener una observación Ed25519 **independiente** y esperar el deadline; luego el método `reconcile` transforma atómicamente `EFFECT_WINDOW → OUTCOME_UNKNOWN → SUCCEEDED/FAILED/NO_EFFECT`. El chequeo del epoch impide que un escritor antiguo realice esta transición tras un takeover.

**Gates pendientes antes de servicio:** terminación de efecto/cgroup al `expiresAt`, fuente de verdad de resultados firmada y reconciliador independiente, estrategia explícita de cierre anticipado sólo con prueba verificable si se necesita. Hasta entonces no se declara `EFFECT_WINDOW → SUCCEEDED/FAILED` normal del ejecutor ni se habilita runner. `openReadonly` rechaza como `OutcomeRejected` tanto directorio como archivo SQLite inexistentes sin crearlos.
