# Requisitos de ejecución por worker

El líder define en el perfil de cada worker cómo debe trabajar ese host. Usa `panter_mesh_profile_set` con estos campos:

| Campo | Ejemplo | Límite |
|---|---|---|
| `modelRequest` | `gpt-6.1-sol` | hasta 120 caracteres |
| `effortRequest` | `max`, `ultra` | hasta 32 caracteres |
| `executionRequest.serviceTier` | `ultrafast` | minúsculas, dígitos, `-` o `_`, de 2 a 32 caracteres |
| `executionRequest.stream` | `true` | booleano |
| `executionRequest.parallelToolCalls` | `true` | booleano |
| `executionRequest.maxNativeSubagents` | `16` | entero de 0 a 32 |

Al delegar, Panter **congela** esos valores en el trabajo (`work.executionRequest`, con `status: "REQUESTED_UNVERIFIED"`). El worker los recibe al hacer `claim` o `pickup`. Si después cambias el perfil, el trabajo ya delegado mantiene los requisitos con que salió. Si el trabajo usa un especialista con binding propio, el modelo y el esfuerzo del binding tienen prioridad.

## Límites

- Panter no llama a ningún proveedor de modelos y **no puede imponer ni comprobar** estos valores. Es el host del worker el que los aplica, si su interfaz lo permite. El worker debe informar en su resultado qué modelo, esfuerzo, tier y cuántos subagentes usó de verdad, y eso sigue siendo un reporte, no una prueba.
- Solo los workers tienen `executionRequest`. El líder lo tiene prohibido.
- No se aceptan otras claves, para que nunca se guarden credenciales ni parámetros arbitrarios.

## Ejemplo (líder Claude)

GPT-A:

```json
{"host":"gpt-a","actorId":"panter-oauth-gpt-a","roles":["explorer","architect","implementer","verifier","reviewer"],
 "modelRequest":"gpt-6.1-sol","effortRequest":"max",
 "executionRequest":{"serviceTier":"ultrafast","stream":true,"parallelToolCalls":true,"maxNativeSubagents":16},
 "expectedRevision":0}
```

GPT-B:

```json
{"host":"gpt-b","actorId":"panter-oauth-gpt-b","roles":["explorer","architect","implementer","verifier","reviewer"],
 "modelRequest":"gpt-6-astra","effortRequest":"ultra",
 "executionRequest":{"serviceTier":"ultrafast","stream":true,"parallelToolCalls":true},
 "expectedRevision":1}
```

`expectedRevision` es la revisión actual del perfil de ese host: 0 si todavía no existe.
