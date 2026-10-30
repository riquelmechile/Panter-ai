# Identidad de revisión independiente

**Estado:** vigente desde el 30-oct-2026. Es la identidad GitHub que Panter-ai usa como evidencia de revisión independiente. Este documento es normativo para operadores y agentes.

## Por qué existe

GitHub no permite que el autor de un PR lo apruebe. Todas las identidades que usaban los agentes (incluida la sesión de Claude que operaba con `riquelmechile`) eran la misma cuenta del autor. Por eso ninguna revisión podía quedar como `APPROVE`, los PR no se podían cerrar con evidencia formal y las revisiones independientes fallaban, tanto en Panter-ai como en Xanxittoo.

## Quién es

| Campo | Valor |
|---|---|
| Cuenta GitHub | `sebastianriquelme95-max` |
| Dueño | el responsable del repositorio (`riquelmechile`) |
| Rol | **solo revisión independiente**: `APPROVE`, `REQUEST_CHANGES` y comentarios de revisión |
| Repos | `riquelmechile/Panter-ai`; otros repos solo si se la invita explícitamente como colaboradora (permiso *Write*) |
| Dónde vive la credencial | host del operador, `gh` del usuario de servicio del operador (configuración local de gh) |
| Tipo de credencial | token OAuth de GitHub CLI (*device flow*), scopes `repo`, `read:org`, `gist` |
| Git | sin *credential helper*: la cuenta **no** se usa para `git push` |

**Nunca** se usa esta cuenta para push, merge, crear o editar ramas, cambiar labels, aprobar issues (`status:approved` lo pone el responsable) ni para configurar el repositorio. Push y merge siguen siendo de `riquelmechile`.

## Comandos en el host

En el **host del operador**, los wrappers separan las credenciales por cuenta. Ambos se invocan con `sh`; las rutas exactas se resuelven en el entorno del usuario de servicio del operador:

- `sh <ruta>/gh-main ...`: cuenta principal `riquelmechile`, activa por defecto en `gh`. Se usa para push, ramas, issues, etiquetas, PR y merge cuando hay autorización explícita. **Bloquea `pr review`**.
- `sh <ruta>/gh-review ...`: cuenta revisora `sebastianriquelme95-max`, limitada a `pr review`, `pr view`, `pr diff`, `pr checks` y `pr status`. Nunca se usa para push, merge, ramas, labels ni aprobar issues.

Cada wrapper obtiene su propio token con `gh auth token --user` para la identidad correspondiente. La cuenta principal permanece activa por defecto en GitHub CLI; los wrappers no dependen de cambiar manualmente la cuenta activa para cada operación.

## Qué significa "independiente"

La cuenta es solo el vehículo. Lo independiente es que **la ejecución que revisa no es la que escribió el código**.

**Con un solo modelo se puede trabajar solo.** El mismo modelo puede implementar y revisar, siempre que la revisión la haga un **subagente nuevo o una sesión nueva desde cero**: sin el contexto, el razonamiento ni las conclusiones de quien implementó, partiendo solo del diff, el SHA, la especificación (issue o PR) y el repositorio. Si el host no permite crear un subagente o una sesión limpia, la autorrevisión queda como evidencia no independiente (en Panter-RDD, `SOLO_4R_COMPLETED_UNVERIFIED`) y no se publica como `APPROVE`.

La regla de identidad compara **cuentas de GitHub**, no modelos: los commits pueden salir con la cuenta del responsable o con la identidad del agente (por ejemplo `claude`), y la regla compara contra la cuenta revisora. Panter-ai lo hace cumplir así:

1. `PANTER_GITHUB_INDEPENDENT_REVIEWER=sebastianriquelme95-max` activa el chequeo en `GitHubDeliveryGate` (`src/core/github-delivery.ts`).
2. El gate exige que la **última revisión decisiva** de esa cuenta (`APPROVED`, `CHANGES_REQUESTED` o `DISMISSED`; los comentarios no cuentan) sea `APPROVED` **sobre el SHA exacto** del head del PR. Cualquier push nuevo deja la aprobación como `STALE_SHA` y obliga a revisar de nuevo.
3. La cuenta no puede ser autora del PR ni autora o *committer* de ningún commit del PR (`REVIEWER_IS_AUTHOR`).
4. Si el historial de commits o de revisiones no se puede leer completo, el gate falla cerrado (`UNAVAILABLE`).
5. Panter-RDD consulta el mismo gate, así que con la variable configurada tampoco aprueba sin este `APPROVE`. Excepción: el camino localProject/LocalGitVerifier (sin PR) no pasa por el gate de GitHub.
6. El gate solo **verifica evidencia**: `approvals.review` sigue siendo `false`. Panter nunca convierte un `APPROVE` en permiso de merge o despliegue.

Sin la variable, el gate mantiene el comportamiento anterior y emite una advertencia explícita.

## Convención del texto de la revisión

Toda revisión publicada con esta cuenta empieza identificando:

- qué agente revisó (por ejemplo `Claude (Opus 5.5), subagente nuevo sin contexto de implementación`) y que opera una cuenta del responsable;
- el SHA exacto revisado;
- el alcance: merge a `main` sí o no, y despliegue privado o público sí o no;
- las pruebas efectivamente ejecutadas y los riesgos residuales.

No se presenta como revisor humano, ni como firma de runner Panter-RDD, ni como certificación 4R.

## Debilidad conocida y siguiente paso obligatorio

Hoy el token vive en el usuario de servicio del operador, al que pueden acceder agentes habilitados para las herramientas del host. En la práctica, **el mismo agente que escribió un cambio podría aprobarlo**. El gate impide que la cuenta revisora sea autora de commits, pero no impide que un agente autor maneje la cuenta revisora.

Objetivo antes de declarar producción:

1. Crear un usuario Unix dedicado (`panter-review`) sin acceso por Xanxittoo ni por SSH de agentes.
2. Mover allí `gh` (logout en el usuario de servicio del operador y nuevo device flow en el usuario de revisión aislado) junto con la llave privada Ed25519 del runner de Panter-RDD.
3. Exponer a los agentes solo una operación acotada: "publicar revisión X sobre SHA Y", invocada por el flujo de revisión de Panter, con registro de qué ejecución de revisor la pidió y verificación de que esa ejecución no es autora del candidato.
4. Recién entonces activar la protección de `main` (ver abajo).

## Rotación y revocación

- **Revocar:** en la cuenta revisora, *Settings → Applications → Authorized OAuth Apps → GitHub CLI → Revoke*; en Oracle, `gh auth logout -h github.com`.
- **Volver a conectar:** `gh auth login --hostname github.com --git-protocol https --web` en el usuario que corresponda, e ingresar el código en `github.com/login/device` **con la sesión de la cuenta revisora** (no con la principal).
- **Tokens classic:** no se usan. Si se generó alguno, se borra en *Settings → Developer settings → Personal access tokens*.
- **Verificar:** `gh auth status` debe mostrar `sebastianriquelme95-max` y `git config --global --get-regexp credential` debe estar vacío.

## Repos privados y protección de rama

- El scope `repo` permite revisar repos privados donde la cuenta sea colaboradora. Pasar Panter-ai a privado no requiere cambiar la credencial.
- La protección de rama y los rulesets en repos **privados** de cuentas personales requieren un plan de pago de GitHub. En un repo público son gratis.
- Cuando el punto anterior esté resuelto, configurar en `main`: 1 aprobación requerida, descartar aprobaciones obsoletas al hacer push, y checks requeridos `test` y `arm64-image`. No activarlo antes: si la cuenta revisora no está operativa, el responsable queda bloqueado para mergear.
