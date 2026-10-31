# Autoridad externa de sellado — Cloudflare Worker + R2

**Estado:** código para revisión independiente, sin despliegue, bucket, dominio ni secretos reales.

Ubicación: `src/runner/seal-worker.mjs`. Se ejecuta fuera de Oracle, usando un Worker separado con binding `SEAL_BUCKET` a un bucket R2 creado expresamente para esta función. El runner no debe recibir credenciales R2 ni la clave privada de sellado.

## Contrato

- `GET /seal/latest`: último comprobante firmado visible en R2.
- `GET /seal/00000001`: comprobante por número; lectura autenticada.
- `POST /seal`: cuerpo `{ "claim": <SegmentSealClaim>, "segmentBase64": "..." }`. Debe autenticarse con token administrativo del bridge y no aceptar más de 3 MiB.
- El Worker verifica el digest SHA-256 de todos los bytes, hash-chain de cada registro, secuencias exactas y último hash. Firma el manifiesto `panter.segment-seal/v1` con una clave Ed25519 propia, **no** con llaves Panter-RDD ni del firmante de grants.
- Publica `payloads/<n>.jsonl` y `receipts/<n>.json` mediante `R2.put` condicional `If-None-Match: *` y valida evidencia existente; no expone endpoints de sustitución o eliminación. Un crash después de guardar payload antes de receipt se reintenta sin sobrescribirlo.
- Lee y verifica cada comprobante existente contra la clave pública configurada antes de usarlo como antecedente de otro segmento. Cualquier fallo produce denegación.
- La ausencia de un comprobante no prueba que no exista un PUT en vuelo: los clientes no deben reintentar con contenido diferente.

## Provisionamiento propuesto, no ejecutado

Configuración de Worker equivalente (ejemplo; reemplazar nombre/bucket por recursos aprobados):

```jsonc
{
  "name": "panter-audit-sealer",
  "main": "src/runner/seal-worker.mjs",
  "compatibility_date": "2026-10-31",
  "r2_buckets": [{ "binding": "SEAL_BUCKET", "bucket_name": "panter-audit-seals" }],
  "vars": { "SEAL_KEY_ID": "audit-ed25519-1" }
}
```

**Secrets de Cloudflare, nunca en Git:** `SEAL_BEARER_TOKEN` (aleatorio >= 32 caracteres), `SEAL_PRIVATE_KEY_PKCS8_B64` (clave PKCS#8 Ed25519), `SEAL_PUBLIC_KEY_SPKI_B64` (par público correspondiente; puede ser var revisada). Generar y registrar la clave **fuera de Oracle y de los worktrees**. Fijar el mismo SPKI en la configuración de verificación del runner, pero jamás la clave privada.

Proteger el Worker con **Cloudflare Access/service-token o mTLS**, políticas de acceso y rate limit; el bearer interno no sustituye controles de borde. No exponer rutas de borrado ni credenciales R2 al runner. Restringir cambios de bucket/Worker y retención según política de infraestructura. La ausencia de DELETE por HTTP **no implica WORM ante un administrador con acceso al bucket**: reforzar IAM, backups/replicación externos y revisión periódica. Separar el backend de sellado de las identidades de despliegue de Panter.

## Pruebas y gates pendientes

`tests/runner-seal-worker.test.ts` usa un R2 simulado, no Cloudflare real. Verifica firma, lecturas, idempotencia, publicación tras crash, conflicto concurrente lógico, digest/tampering y denegación de peticiones no autorizadas.

Antes de uso real:
1. Provisionar recursos y secretos aprobados, ejecutar pruebas de lectura/escritura condicional y consistencia **contra R2 real**; verificar identidad única, fallas de red y recuperación.
2. Integrar un bridge protegido que cumpla el contrato `ExternalSealAuthority` del PR #35. Su interfaz de demostración es síncrona, mientras que Worker/R2 es asíncrono; **no están conectados en este PR**. No bloquear el proceso de auditoría con llamadas no verificadas.
3. E2E de arranque, rotación, relleno de diario, reinicio y detección de rollback, con la clave pública externa fijada. Exigir seal remoto vigente antes de reanudar efectos.
4. Integrar con ledger OUTCOME_UNKNOWN, grants firmados, UID/cgroups y sandbox; hacer cutover revisado y rollback seguro. Mantener el ejecutor deshabilitado mientras falte cualquier gate.

Documentación oficial de WebCrypto Ed25519: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
Consistencia y escrituras condicionales R2: https://developers.cloudflare.com/r2/reference/consistency/

## Primer tramo del issue #42: bridge asíncrono (solo biblioteca)

`src/core/runner-seal-http.ts` aporta `HttpSegmentSealAuthority` (HTTPS con fetch inyectable, GET latest/segment, POST claim + bytes completos, sin redirecciones, timeout, respuesta limitada) y `AsyncSegmentedRunnerAudit.open()`, `append()` y `sealCurrent()`. No se intenta bloquear el event loop con HTTP síncrono: se solicita el sello **antes** de rotar localmente, se verifica la firma con las claves públicas fijadas del diario, y se crea el segmento siguiente solo después de confirmar el sello.

En una respuesta HTTP perdida tras persistencia remota, la siguiente apertura lee anclas del Worker y el diario recupera el estado posterior al sello; una petición que sí haya fallado antes de persistir puede reintentarse **solo con los mismos bytes**. La memoria local no sustituye a R2 ni es autoridad de firma. El bridge serializa las operaciones por instancia y rechaza acceso concurrente; la exclusión entre procesos/UID aún no está implementada. La verificación y publicación real en R2 con identidad externa/Access/mTLS, el soporte de miles de segmentos (límite defensivo de 10.000 en preload), el cutover de diario legado y el endurecimiento de permisos siguen pendientes. No se creó ningún recurso Cloudflare ni se desplegó el runner.

## Endurecimiento del bridge posterior a revisión

`SealCache.install` ahora verifica firma/campos del recibo remoto usando la clave pública fijada **antes de insertar** en memoria, además de continuidad del digest del sello anterior y secuencia. Una respuesta forjada o malformada no contamina el cache ni bloquea la instancia hasta reapertura: se puede repetir con bytes idénticos si la autoridad confirmó el sello pero el transporte devolvió un recibo falsificado. La respuesta errónea nunca se transforma en evidencia válida ni habilita el efecto.
