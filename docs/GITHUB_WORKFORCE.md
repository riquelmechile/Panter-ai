# GitHub para los trabajadores

Los trabajadores (GPT-A, GPT-B, Grok, Gemini) pueden leer y dejar trabajo en GitHub a través de Panter, sin tener credenciales propias. Panter guarda **un** token del operador en el servidor y lo usa solo mediante operaciones acotadas, ligadas a una tarea delegada y auditadas.

## Configuración (solo en el servidor)

```
PANTER_GITHUB_WORKFORCE_TOKEN=<token del operador; nunca en el repo>
PANTER_GITHUB_WORKFORCE_REPOS=riquelmechile/*        # obligatoria: "owner/repo" u "owner/*", separados por coma
```

El repositorio es público: el token va solo en el entorno del servicio (por ejemplo `etc/panter.env` o el lanzador `bin/run`), nunca en el código, la documentación, los paquetes A2A ni los resultados. Sin token o sin lista de repos la capacidad queda apagada.

## Cómo se usa

1. El líder (Claude) delega una tarea y le adjunta un permiso de GitHub, en la misma llamada (`panter_mesh_delegate` con `github`) o después (`panter_github_grant`):
   - `repository`: un repo permitido;
   - `ops`: operaciones de escritura permitidas, cualquiera de `commit`, `pr`, `comment`, `issue` (leer siempre está permitido);
   - `branch` (opcional): rama de trabajo, siempre bajo `panter/`; por defecto `panter/<host>-<8 primeros del workId>`;
   - `base` (opcional): rama base; por defecto la rama principal del repo;
   - `numbers` (opcional): issues/PR existentes en los que el trabajador puede comentar.
2. El trabajador, con su claim vivo (`workId`, `attemptId`, `leaseGeneration`), usa:
   - `panter_github_read`: lee recursos del repo (`contents`, `readme`, `git/...`, `pulls`, `issues`, `commits`, `compare`, `branches`, `tags`, `releases`, `languages`, `check-runs`, `actions/runs`). `path: "grant"` muestra su permiso. Los archivos vuelven decodificados y sin enlaces temporales.
   - `panter_github_commit`: hasta 50 archivos de texto en un solo commit a **su** rama, que Panter crea desde la base la primera vez.
   - `panter_github_open_pr`: abre el PR desde su rama (o devuelve el que ya esté abierto).
   - `panter_github_comment`: solo en los `numbers` del permiso y en los issues/PR que abrió esta tarea.
   - Comentarios, issues y PR no pueden llevar @menciones, comentarios HTML ni comandos con barra o de bots: lo publicado sale con la identidad del dueño y podría dar órdenes a bots o agentes instalados en el repo (Dependabot, Mergify, Copilot, Codex, Claude...).
   - `panter_github_create_issue`.
3. El líder ve todo en `panter_github_audit` y puede cortar con `panter_github_revoke`.

## Límites (por diseño)

- Cada petición queda fijada, después de interpretar la URL, a `https://api.github.com/repos/<repo del permiso>/...`: ninguna ruta codificada (`%2e%2e`, etc.) puede llegar a otro repo ni al resto de la API.
- Solo se escribe en una rama `panter/...` que Panter creó para esa tarea: nunca en una rama existente, protegida o principal, y nunca con push forzado. El lease y el permiso se vuelven a comprobar justo antes de mover la rama o publicar algo.
- Nunca se tocan `.github/` (workflows, actions, CODEOWNERS...), `CODEOWNERS`, `.gitmodules`, `.gitattributes`, `.lfsconfig`, `.husky/`, `.devcontainer/` ni archivos de CI/despliegue de otros sistemas (GitLab, CircleCI, Buildkite, Woodpecker, Netlify, Vercel, Railway, Render, Fly, Wrangler, pre-commit...).
- Un permiso no puede cambiar de repositorio, y una rama solo cuenta como "creada por esta tarea" en el repo donde se creó.
- Los procesos que Panter lanza (revisión nativa, verificador local que corre tests sobre código de trabajadores) no heredan las variables `PANTER_*`; el verificador local tampoco hereda nada que parezca credencial.
- Tope global de 3000 llamadas por hora a GitHub entre todos los trabajadores.
- No existe merge, aprobación, borrado, etiquetas, releases, settings ni lectura de secretos, variables, logs, artefactos, alertas, llaves, hooks o colaboradores. Los comentarios no pueden llevar comandos de bots ni comandos con barra (`@dependabot merge`, `/merge`, `bors r+`...). Merge y aprobación siguen siendo del líder y de la cuenta revisora independiente.
- **Riesgo a considerar:** subir una rama al mismo repo ejecuta el CI existente (`on: push` / `pull_request`) sobre el código del trabajador, con los secretos de Actions. Recomendado: `GITHUB_TOKEN` de Actions en solo lectura por defecto, "Require approval for workflow runs" y que los despliegues de preview y pasos privilegiados no corran en ramas `panter/*`; o un token fine-grained limitado a los repos necesarios.
- El permiso muere con el lease de la tarea: al completarse, vencer o revocarse, las herramientas dejan de funcionar.
- Máximo 200 escrituras y 1500 lecturas por tarea, reservadas de forma atómica. Cada commit lleva `Panter-Work` y `Panter-Host`; los PR, comentarios e issues indican qué trabajador y qué tarea los hizo.
