# Issue #42 — captura forense de cola incompleta del segmento activo

**Etapa incremental sin cutover ni recuperación.** `quarantineActiveSegmentTail()` exige el último recibo Ed25519 independiente, valida su firma y deriva el índice y las anclas esperadas del segmento activo. Acepta solo una cola terminal sin `\\n` tras un prefijo JSONL cuya cadena completa valida con el parser del diario; cualquier corrupción interna, recibo falso o segmento inesperado falla cerrado.

Publica bytes exactos de la cola en `<raíz>-quarantine/` como binario solo lectura 0400, junto con un recibo de hashes, tamaños, índice y ancla remota. Los nombres finales se crean mediante temp + `fsync` + enlace exclusivo sin reemplazo y el reintento verifica bytes existentes. El archivo activo original **no se modifica**. No lee ni registra el contenido del fragmento.

**Importante:** guardar evidencia NO prueba que no haya efectos externos. El diario continúa bloqueado; ninguna operación, nueva reserva o reanudación puede resultar de esta función. El siguiente gate debe reconciliar outcome en SQLite, verificar el tail contra el proceso fenced, preservar la fuente original, construir un segmento válido bajo un cutover versionado y confirmar su sello remoto antes de admitir nuevas acciones. La validación de toda la cadena histórica y la consistencia de R2 real sigue siendo obligatoria. No despliegue ni recursos Cloudflare.

## Endurecimiento post-revisión

`signedLatest` usa el mismo `inspectSeal` del diario para exigir campos exactos del envoltorio, firma base64url canónica, clave Ed25519 fijada y claim íntegro. El recibo persistido registra solo nombres relativos de los archivos de evidencia (basenames), de modo que mover conjuntamente diario y carpeta de cuarentena no lo invalida por una ruta absoluta antigua. El retorno del método conserva las rutas locales para el operador. La cadena completa de sellos históricos permanece como verificación obligatoria antes de cualquier futura reanudación.
