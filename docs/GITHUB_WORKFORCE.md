# GitHub para los trabajadores

Los trabajadores (GPT-A, GPT-B, Grok, Gemini) pueden leer y dejar trabajo en GitHub a través de Panter, sin tener credenciales propias. Panter guarda **un** token del operador en el servidor y lo usa solo mediante operaciones acotadas, ligadas a una tarea delegada y auditadas.

## Configuración (solo en el servidor)

```
PANTER_GITHUB_WORKFORCE_TOKEN=<token del operador; nunca en el repo>
PANTER_GITHUB_WORKFORCE_REPOS=riquelmechile/*        # "owner/repo" u "owner/*", separados por coma
```

El repositorio es público: el token va solo en el entorno del servicio (por ejemplo `etc/panter.env` o el lanzador `bin/run`), nunca en el código, la documentación, los paquetes A2A ni los resultados. Sin token o sin lista de repos la capacidad queda apagada.

## Cómo se usa

1. El líder (Claude) delega una tarea y le adjunta un permiso de GitHub, en la misma llamada (`panter_mesh_delegate` con `github`) o después (`panter_github_grant`):
   - `repository`: un repo permitido;
   - `ops`: operaciones de escritura permitidas, cualquiera de `commit`, `pr`, `comment`, `issue` (leer siempre está permitido);
   - `branch` (opcional): rama de trabajo; por defecto `panter/<host>-<8 primeros del workId>`;
   - `base` (opcional): rama base; por defecto la rama principal del repo.
2. El trabajador, con su claim vivo (`workId`, `attemptId`, `leaseGeneration`), usa:
   - `panter_github_read`: lee bajo `repos/{owner}/{repo}/` (contenidos decodificados, PRs, issues, commits, compare...). `path: "grant"` muestra su permiso.
   - `panter_github_commit`: hasta 50 archivos de texto en un solo commit a **su** rama (la crea desde la base la primera vez).
   - `panter_github_open_pr`: abre el PR desde su rama (o devuelve el que ya esté abierto).
   - `panter_github_comment` / `panter_github_create_issue`.
3. El líder ve todo en `panter_github_audit` y puede cortar con `panter_github_revoke`.

## Límites (por diseño)

- Nunca se escribe en la rama principal ni en ramas protegidas (`main`, `master`, `develop`, `release/*`, `production`...), nunca se fuerza un push y nunca se tocan `.github/workflows` ni `.github/actions`.
- No existe merge, aprobación, borrado, etiquetas, releases, settings ni lectura de secretos, llaves, hooks o colaboradores. Merge y aprobación siguen siendo del líder y de la cuenta revisora independiente.
- El permiso muere con el lease de la tarea: al completarse, vencer o revocarse, las herramientas dejan de funcionar.
- Máximo 200 escrituras por tarea. Cada commit lleva `Panter-Work` y `Panter-Host`; los PR, comentarios e issues indican qué trabajador y qué tarea los hizo.
