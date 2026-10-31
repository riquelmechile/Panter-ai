# SQLite legado — recuperación de carrera en la primera apertura WAL

## Problema demostrado

GitHub Actions del PR #37, run `41184588167`, falló en un caso real de dos procesos concurrentes con `UNEXPECTED:database is locked`, aunque `PRAGMA busy_timeout` ya precedía a `journal_mode=WAL`. El test demostró que la configuración del timeout por sí sola no elimina todos los `SQLITE_BUSY` transitorios durante el bootstrap del WAL.

## Corrección limitada

`src/core/sqlite-ledger.ts` ahora aplica reintentos breves y acotados **solo** a la inicialización idempotente de `journal_mode=WAL` y `migrate()`, usando `Atomics.wait` (20 reintentos, backoff acotado). La migración ya usa `BEGIN IMMEDIATE`, `COMMIT` y `ROLLBACK`; repetir su comprobación después de un fallo por bloqueo es seguro porque la transacción anterior no queda parcialmente confirmada y `schema_migrations` es idempotente.

**No** se reintenta ninguna mutación de aplicación. Una excepción de integridad, esquema incompatible, permisos o SQL que no sea bloqueo se propaga inmediatamente. La verificación confirma que el modo es WAL. Se mantienen `PRAGMA busy_timeout=10000` antes de acceder al journal, `synchronous=FULL` y las pruebas existentes de migración.

La prueba del ledger principal se amplió a **15 carreras de dos procesos reales** sobre bases nuevas, con dos commits persistidos por carrera; las pruebas del ledger de grants se mantienen.

## Activación

Es un cambio de inicialización, no despliegue de runner ni autorización para ejecutar tareas. Se requiere CI verde en el SHA, revisión independiente de Claude, pruebas en Oracle ARM64 y gate de rollback antes de aplicar a servicio actual. El PR #37 de conciliación de efectos depende de un entorno SQLite robusto y su CI anterior demostró esta deuda preexistente.

## Revisión #41: grants y presupuesto de startup

El helper compartido `src/core/sqlite-startup.ts` controla la inicialización WAL y la creación transaccional e idempotente de tablas de `SqliteLedger` y `RunnerGrantLedger`. Identifica `SQLITE_BUSY` por `errcode` numérico (también extendido, byte bajo = 5), no por regex. Un solo deadline de 15 s abarca WAL + esquema; `busy_timeout=1000` durante bootstrap y `10000` después. Nunca se repiten reservas ni mutaciones de negocio. Ambos tests multiproceso ejecutan 15 carreras reales. El futuro `RunnerOutcomeLedger` de #37 también debe consumir este helper.
