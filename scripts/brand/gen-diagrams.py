"""Generate Panter README diagrams (EN + ES) in the existing brand style. Writes SVGs to argv[1]."""
import sys, os, html
OUT = sys.argv[1]
FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
BG, PANEL, BOX, LINE = '#0d1117', '#111722', '#161b26', '#2a3142'
INK, MUTED, AMBER, TEAL, RED, GREEN = '#f5f0e6', '#9aa3b5', '#f5b301', '#2dd4bf', '#f87171', '#4ade80'
WARN = []

def esc(s): return html.escape(s, quote=True)
def tw(s, size, bold=False, mono=False):
    """Rough rendered width for overflow warnings."""
    k = 0.61 if mono else (0.58 if bold else 0.53)
    return len(s) * size * k

class D:
    def __init__(self, name, w, h, pfx, title, desc):
        self.name, self.w, self.h, self.p = name, w, h, pfx
        self.parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-labelledby="{pfx}-title {pfx}-desc">',
                      f'  <title id="{pfx}-title">{esc(title)}</title>', f'  <desc id="{pfx}-desc">{esc(desc)}</desc>',
                      '  <defs>']
        for nm, col in (('teal', TEAL), ('amber', AMBER), ('muted', MUTED)):
            self.parts.append(f'    <marker id="{pfx}-arrow-{nm}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="{col}"/></marker>')
        self.parts += [f'    <radialGradient id="{pfx}-halo"><stop offset="0" stop-color="#ffffff" stop-opacity=".9"/><stop offset=".35" stop-color="{TEAL}" stop-opacity=".55"/><stop offset="1" stop-color="{TEAL}" stop-opacity="0"/></radialGradient>',
                       f'    <radialGradient id="{pfx}-haloa"><stop offset="0" stop-color="#ffffff" stop-opacity=".9"/><stop offset=".35" stop-color="{AMBER}" stop-opacity=".6"/><stop offset="1" stop-color="{AMBER}" stop-opacity="0"/></radialGradient>',
                       '    <style>@media (prefers-reduced-motion: reduce){.pkt{display:none}}</style>',
                       '  </defs>', f'  <rect width="{w}" height="{h}" rx="24" fill="{BG}"/>']
        self.packets = []
    def text(self, x, y, s, size=13, fill=INK, bold=False, anchor='start', mono=False, spacing=None, maxw=None, ctx=''):
        if maxw and tw(s, size, bold, mono) > maxw: WARN.append(f'{self.name}: "{s}" ~{tw(s,size,bold,mono):.0f}px > {maxw}px {ctx}')
        attrs = f'font-family="{MONO if mono else FONT}" font-size="{size}"' + (' font-weight="700"' if bold else '') + (f' letter-spacing="{spacing}"' if spacing else '') + (f' text-anchor="{anchor}"' if anchor != 'start' else '')
        self.parts.append(f'  <text x="{x}" y="{y}" {attrs} fill="{fill}">{esc(s)}</text>')
    def label(self, x, y, s): self.text(x, y, s.upper(), 13, MUTED, True, spacing=2)
    def rect(self, x, y, w, h, stroke=LINE, fill=BOX, rx=12, sw=2, dash=None):
        self.parts.append(f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"' + (f' stroke-dasharray="{dash}"' if dash else '') + '/>')
    def box(self, x, y, w, h, title, lines=(), stroke=LINE, badge=None, badge_col=AMBER, tsize=16, lsize=12.5, mono_lines=False):
        self.rect(x, y, w, h, stroke)
        tx = x + 16
        if badge is not None:
            self.parts.append(f'  <circle cx="{x+26}" cy="{y+26}" r="13" fill="{badge_col}"/>')
            self.text(x + 26, y + 31, str(badge), 13, BG, True, 'middle')
            tx = x + 48
        self.text(tx, y + 31 if badge is not None else y + 25, title, tsize, INK, True, maxw=w - (tx - x) - 12, ctx='title')
        ly = y + (56 if badge is not None else 46)
        for ln in lines:
            self.text(x + 16, ly, ln, lsize, MUTED, mono=mono_lines and ln.startswith('`'), maxw=w - 28, ctx='line')
            ly += lsize + 6
    def arrow(self, x1, y1, x2, y2, col='teal', dash=None):
        c = {'teal': TEAL, 'amber': AMBER, 'muted': MUTED}[col]
        self.parts.append(f'  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{c}" stroke-width="3"' + (f' stroke-dasharray="{dash}"' if dash else '') + f' marker-end="url(#{self.p}-arrow-{col})"/>')
    def path(self, d, col='teal', dash=None):
        c = {'teal': TEAL, 'amber': AMBER, 'muted': MUTED}[col]
        self.parts.append(f'  <path d="{d}" fill="none" stroke="{c}" stroke-width="3"' + (f' stroke-dasharray="{dash}"' if dash else '') + f' marker-end="url(#{self.p}-arrow-{col})"/>')
    def dot(self, x, y, col): self.parts.append(f'  <circle cx="{x}" cy="{y}" r="5" fill="{col}"/>')
    def packet(self, d, cycle, start, travel, amber=False):
        """A glowing packet that travels path d once per cycle: starts at `start` s, takes `travel` s, then hides."""
        a, b = start / cycle, (start + travel) / cycle
        assert 0 <= a < b <= 1
        e = 0.03 * travel / cycle
        kt = f'0;{a:.4f};{b:.4f};1' if a > 0 else f'0;{b:.4f};1'
        kp = '0;0;1;1' if a > 0 else '0;1;1'
        ov = f'0;0;1;1;0;0' if a > 0 else '0;1;1;0;0'
        okt = f'0;{a:.4f};{a + e:.4f};{b - e:.4f};{b:.4f};1' if a > 0 else f'0;{e:.4f};{b - e:.4f};{b:.4f};1'
        halo = f'{self.p}-haloa' if amber else f'{self.p}-halo'
        self.packets.append(
            f'  <g class="pkt" opacity="0"><circle r="11" fill="url(#{halo})"/><circle r="3.5" fill="#ffffff"/>'
            f'<animateMotion path="{d}" keyPoints="{kp}" keyTimes="{kt}" calcMode="linear" dur="{cycle}s" repeatCount="indefinite"/>'
            f'<animate attributeName="opacity" values="{ov}" keyTimes="{okt}" dur="{cycle}s" repeatCount="indefinite"/></g>')
    def save(self):
        self.parts += self.packets
        self.parts.append('</svg>')
        with open(os.path.join(OUT, self.name), 'w') as f: f.write('\n'.join(self.parts) + '\n')

T = {
'en': dict(
  arch_title='How Panter-ai fits together',
  arch_desc='Diagram. Left: AI hosts (Claude, GPT-A, GPT-B, Grok and Gemini) connect to Panter-ai over MCP with OAuth; one of them is the leader set by PANTER_LEAD_HOST and the others are workers. Center: Panter-ai with its automatic harness, review gate, mesh and workforce, GitHub workforce, Engram memory and per-role tool surface. Right: downstream MCP servers, each in its own repository and service, reached through Panter\'s gateway. Bottom: GitHub, where pull requests, CI and an independent reviewer account gate every merge.',
  hosts='AI hosts', panter='Panter-ai', down='Downstream MCP servers',
  leader='leader (set by PANTER_LEAD_HOST)', worker='worker', worker_gem='worker (app or mail relay)',
  comps=[('Automatic harness','discover, design, implement, verify'),('Review gate','4R, Judgment Day, Panter-RDD'),('Mesh + workforce','delegation, claims, wake, results'),('GitHub workforce','scoped grants, PRs, audit'),('Engram memory','project context across sessions'),('Tool surface','per-role list, 8 domain routers')],
  ds=[('Your MCP server','its own repo, service, token'),('Another MCP server','its own repo, service, token'),('Any MCP server','registered once, one router')],
  ds_note=['Local, private or https; a token per server,','writes need a grant, every call audited,','the server keeps its own approvals.'],
  gw='gateway', gh='GitHub', gh_sub='pull requests, CI, an independent reviewer account on the exact commit',

  flow_title='How a task flows through Panter-ai',
  flow_desc='Diagram in seven steps. 1: the leader delegates a task. 2: Panter stores it durably and attaches a GitHub permission scoped to that one task. 3: Panter wakes the worker through its route. 4: the worker claims the task with a fenced lease. 5: the worker does the work in its own app, on its own branch, and opens a pull request. 6: it completes with evidence; Panter stores the result, sends the leader a receipt and revokes the permission. 7: the leader reads the result and the pull request goes through the review and merge gate.',
  flow_head='From a request to a merged pull request',
  steps=[('Leader delegates',['the leader sends a task: a harness','tick or panter_mesh_delegate']),
         ('Panter queues it',['durable work item in SQLite,','GitHub grant scoped to this task']),
         ('Panter wakes it',['MCP event, webhook, routine or','mail, depending on the host']),
         ('Worker claims it',['fenced lease and heartbeats:','one attempt owns the work']),
         ('Worker does the work',['in its own app and model, on','branch panter/<host>-<id>; opens a PR']),
         ('Done, with evidence',['result stored, receipt to','the leader, GitHub grant revoked']),
         ('Review and merge',['CI and an independent reviewer','on the exact commit; leader merges'])],
  flow_note='Panter never runs a model. Step 5 happens inside the worker\'s own app; Panter records what it reports and what GitHub shows.',

  wake_title='How Panter-ai wakes each worker',
  wake_desc='Diagram. Panter has queued work and rings each worker through the route its app supports: ChatGPT hosts (GPT-A and GPT-B) through an MCP event subscription that triggers a ChatGPT Work automation; Grok through a bearer webhook to its Grok Bot Routine; Claude through a Claude Code Routine; Gemini through a Gmail relay or a scheduled task, never for writers or sensitive missions; and any host with a chat open through a live MCP listener. An accepted ring is not proof of work: only the worker\'s claim counts.',
  wake_head='Work queued', wake_sub=['durable, with its grant,','waiting for a claim'],
  routes=[('GPT-A, GPT-B (ChatGPT)','MCP event subscription','a ChatGPT Work automation wakes the chat'),
          ('Grok','bearer webhook','the Grok Bot Routine picks the work up'),
          ('Claude','Claude Code Routine','a routine run starts a session'),
          ('Gemini','Gmail relay or scheduled task','never writers or sensitive missions'),
          ('Any host with a chat open','live MCP listener','long poll: resumes as soon as work arrives')],
  wake_note='A ring the host accepted is not proof of work. Panter only trusts the worker\'s claim and its result.',
  ring='rings',

  gate_title='The delivery gate: what blocks a merge',
  gate_desc='Diagram. A pull request goes through the delivery gate. Always blocking, in every mode: the exact frozen commit, an open non-draft pull request on the authorized base, required CI green, and the independent reviewer account approving that exact commit. Blocking by default and only warnings in owner mode: branch naming, one type label, an approved linked issue, conventional commits, no Co-Authored-By trailers, and pull request size. Then the leader merges with match-head-commit. Workers never merge, approve, force-push, write the default or protected branches, CI or git config, or read secrets.',
  gate_pr='Pull request', gate_pr_sub=['opened by a worker','from panter/<host>-<id>'],
  gate_always='Always blocks', gate_always_items=['exact frozen commit (SHA)','open, non-draft, authorized base','required CI checks green','independent reviewer approved that SHA'],
  gate_soft='Blocks by default · warning in owner mode', gate_soft_items=['branch naming, one type:* label','approved linked issue','Conventional Commits, no Co-Authored-By','PR size and commit count'],
  gate_merge='Leader merges', gate_merge_sub=['--match-head-commit','never a worker'],
  gate_never='Workers can never', gate_never_items=['merge or approve','force-push or delete branches','write main or protected branches','touch .github/workflows or git config','read secrets'],

  repo_title='What lives in the repository and what lives on your server',
  repo_desc='Diagram. Left: the public repository on GitHub holds code, tests, docs and example configs with placeholders only, guarded by a CI hygiene test. Right: your server holds panter.env with your secrets, accounts and domain; downstream.json with your MCP servers; the data directory with the SQLite ledger, OAuth clients and tokens and audit; and the backups. deploy.sh installs an exact commit from the repository on the server; nothing flows back. Connecting a new MCP server means editing downstream.json, adding its token to panter.env and restarting: no repository change.',
  repo_l='Public repository (GitHub)', repo_r='Your server',
  repo_items=[('Code and tests','src/, tests/, CI on every PR'),('Docs','docs/, README in English and Spanish'),('Example configs','*.example with placeholders only'),('Hygiene test','fails on real credentials or values')],
  srv_items=[('panter.env','secrets, accounts, domain, owner mode'),('downstream.json','the MCP servers you connect'),('Data directory','SQLite ledger, OAuth clients, audit'),('Backups','before every deploy and every day')],
  deploy='deploy.sh <sha>', deploy_sub='installs an exact commit', back='nothing flows back',
  repo_note='Connect a new MCP server: add it to downstream.json, put its token in panter.env, restart. The repository does not change.',
),
'es': dict(
  arch_title='Cómo encaja Panter-ai',
  arch_desc='Diagrama. Izquierda: hosts de IA (Claude, GPT-A, GPT-B, Grok y Gemini) se conectan a Panter-ai por MCP con OAuth; uno es el líder, definido por PANTER_LEAD_HOST, y los demás son trabajadores. Centro: Panter-ai con su harness automático, portón de revisión, mesh y fuerza de trabajo, fuerza de trabajo en GitHub, memoria Engram y lista de herramientas por rol. Derecha: servidores MCP downstream, cada uno en su propio repositorio y servicio, accesibles por el gateway de Panter. Abajo: GitHub, donde los pull requests, el CI y una cuenta revisora independiente controlan cada merge.',
  hosts='Hosts de IA', panter='Panter-ai', down='Servidores MCP downstream',
  leader='líder (PANTER_LEAD_HOST)', worker='trabajador', worker_gem='trabajador (app o correo)',
  comps=[('Harness automático','descubrir, diseñar, implementar, verificar'),('Portón de revisión','4R, Judgment Day, Panter-RDD'),('Mesh + fuerza de trabajo','delegación, claims, despertar, resultados'),('Fuerza de trabajo GitHub','permisos acotados, PRs, auditoría'),('Memoria Engram','contexto del proyecto entre sesiones'),('Herramientas por rol','lista por rol, 8 routers de dominio')],
  ds=[('Tu servidor MCP','su propio repo, servicio y token'),('Otro servidor MCP','su propio repo, servicio y token'),('Cualquier servidor MCP','se registra una vez, un router')],
  ds_note=['Local, privado o https; un token por servidor,','las escrituras piden permiso, todo se audita,','el servidor mantiene sus propias aprobaciones.'],
  gw='gateway', gh='GitHub', gh_sub='pull requests, CI y una cuenta revisora independiente sobre el commit exacto',

  flow_title='Cómo fluye una tarea por Panter-ai',
  flow_desc='Diagrama en siete pasos. 1: el líder delega una tarea. 2: Panter la guarda de forma durable y le asigna un permiso de GitHub acotado a esa tarea. 3: Panter despierta al trabajador por su ruta. 4: el trabajador toma la tarea con un lease exclusivo. 5: el trabajador hace el trabajo en su propia app, en su propia rama, y abre un pull request. 6: termina con evidencia; Panter guarda el resultado, le manda un recibo al líder y revoca el permiso. 7: el líder lee el resultado y el pull request pasa por el portón de revisión y merge.',
  flow_head='De un pedido a un pull request mergeado',
  steps=[('El líder delega',['manda una tarea: un tick del','harness o panter_mesh_delegate']),
         ('Panter la encola',['trabajo durable en SQLite y un','permiso GitHub solo para ella']),
         ('Panter lo despierta',['evento MCP, webhook, rutina o','correo, según el host']),
         ('El trabajador la toma',['lease exclusivo y latidos: un','solo intento es dueño del trabajo']),
         ('Hace el trabajo',['en su app y su modelo, en la rama','panter/<host>-<id>; abre un PR']),
         ('Termina con evidencia',['resultado guardado, recibo al','líder, permiso GitHub revocado']),
         ('Revisión y merge',['CI y un revisor independiente','sobre el commit; mergea el líder'])],
  flow_note='Panter nunca ejecuta un modelo. El paso 5 ocurre dentro de la app del trabajador; Panter registra lo que reporta y lo que muestra GitHub.',

  wake_title='Cómo despierta Panter-ai a cada trabajador',
  wake_desc='Diagrama. Panter tiene trabajo en cola y avisa a cada trabajador por la ruta que soporta su app: los hosts de ChatGPT (GPT-A y GPT-B) por una suscripción a eventos MCP que dispara una automatización de ChatGPT Work; Grok por un webhook con token a su Grok Bot Routine; Claude por una Claude Code Routine; Gemini por un relay de Gmail o una tarea programada, nunca para escritores ni misiones sensibles; y cualquier host con un chat abierto por una escucha MCP en vivo. Un aviso aceptado no prueba que hubo trabajo: solo cuenta el claim del trabajador.',
  wake_head='Trabajo en cola', wake_sub=['durable, con su permiso,','esperando que lo tomen'],
  routes=[('GPT-A, GPT-B (ChatGPT)','suscripción a eventos MCP','una automatización de ChatGPT Work abre el chat'),
          ('Grok','webhook con token','la Grok Bot Routine toma el trabajo'),
          ('Claude','Claude Code Routine','una ejecución de la rutina abre una sesión'),
          ('Gemini','relay de Gmail o tarea programada','nunca escritores ni misiones sensibles'),
          ('Cualquier host con chat abierto','escucha MCP en vivo','long poll: retoma apenas llega trabajo')],
  wake_note='Que el host acepte el aviso no prueba que trabajó. Panter solo confía en el claim del trabajador y en su resultado.',
  ring='avisa',

  gate_title='El portón de entrega: qué bloquea un merge',
  gate_desc='Diagrama. Un pull request pasa por el portón de entrega. Bloquea siempre, en cualquier modo: el commit exacto congelado, un pull request abierto y no borrador sobre la base autorizada, el CI requerido en verde y la aprobación de la cuenta revisora independiente sobre ese commit. Bloquea por defecto y es solo un aviso en modo dueño: el nombre de la rama, una etiqueta de tipo, un issue enlazado aprobado, commits convencionales, sin trailers Co-Authored-By, y el tamaño del pull request. Después el líder mergea con match-head-commit. Los trabajadores nunca mergean, aprueban, hacen push forzado, escriben la rama principal o ramas protegidas, el CI o la configuración de git, ni leen secretos.',
  gate_pr='Pull request', gate_pr_sub=['abierto por un trabajador','desde panter/<host>-<id>'],
  gate_always='Bloquea siempre', gate_always_items=['commit exacto congelado (SHA)','abierto, no borrador, base autorizada','checks de CI requeridos en verde','el revisor independiente aprobó ese SHA'],
  gate_soft='Bloquea por defecto · aviso en modo dueño', gate_soft_items=['nombre de rama, una etiqueta type:*','issue enlazado aprobado','Conventional Commits, sin Co-Authored-By','tamaño del PR y cantidad de commits'],
  gate_merge='Mergea el líder', gate_merge_sub=['--match-head-commit','nunca un trabajador'],
  gate_never='Un trabajador nunca puede', gate_never_items=['mergear ni aprobar','hacer push forzado ni borrar ramas','escribir main ni ramas protegidas','tocar .github/workflows ni config de git','leer secretos'],

  repo_title='Qué vive en el repositorio y qué vive en tu servidor',
  repo_desc='Diagrama. Izquierda: el repositorio público en GitHub tiene código, pruebas, documentación y configuraciones de ejemplo solo con marcadores, protegido por una prueba de higiene en el CI. Derecha: tu servidor tiene panter.env con tus secretos, cuentas y dominio; downstream.json con tus servidores MCP; el directorio de datos con el ledger SQLite, los clientes y tokens OAuth y la auditoría; y los respaldos. deploy.sh instala un commit exacto del repositorio en el servidor; nada vuelve al repositorio. Conectar un servidor MCP nuevo es editar downstream.json, poner su token en panter.env y reiniciar: el repositorio no cambia.',
  repo_l='Repositorio público (GitHub)', repo_r='Tu servidor',
  repo_items=[('Código y pruebas','src/, tests/, CI en cada PR'),('Documentación','docs/, README en inglés y español'),('Configs de ejemplo','*.example, solo marcadores'),('Prueba de higiene','falla con credenciales o valores reales')],
  srv_items=[('panter.env','secretos, cuentas, dominio, modo dueño'),('downstream.json','los servidores MCP que conectas'),('Directorio de datos','ledger SQLite, clientes OAuth, auditoría'),('Respaldos','antes de cada deploy y cada día')],
  deploy='deploy.sh <sha>', deploy_sub='instala un commit exacto', back='nada vuelve al repo',
  repo_note='Conectar un servidor MCP nuevo: agrégalo a downstream.json, pon su token en panter.env y reinicia. El repositorio no cambia.',
),
}

def sfx(lang): return '' if lang == 'en' else '.es'

def architecture(lang):
    t = T[lang]; d = D(f'panter-architecture{sfx(lang)}.svg', 1200, 620, f'pa{lang}', t['arch_title'], t['arch_desc'])
    d.label(40, 54, t['hosts']); d.label(430, 54, t['panter']); d.label(880, 54, t['down'])
    hosts = [('Claude', t['leader'], AMBER), ('GPT-A', t['worker'], LINE), ('GPT-B', t['worker'], LINE), ('Grok', t['worker'], LINE), ('Gemini', t['worker_gem'], LINE)]
    for i, (n, s, c) in enumerate(hosts): d.box(40, 76 + 66 * i, 280, 52, n, [s], c)
    d.rect(410, 70, 380, 420, AMBER, PANEL, 20)
    for i, (n, s) in enumerate(t['comps']): d.box(430, 88 + 66 * i, 340, 52, n, [s])
    for i, (n, s) in enumerate(t['ds']): d.box(880, 100 + 80 * i, 280, 52, n, [s], TEAL)
    for i, ln in enumerate(t['ds_note']): d.text(880, 370 + 20 * i, ln, 13, MUTED, maxw=320)
    d.parts.append(f'  <line x1="330" y1="245" x2="400" y2="245" stroke="{TEAL}" stroke-width="3" marker-start="url(#{d.p}-arrow-teal)" marker-end="url(#{d.p}-arrow-teal)"/>')
    d.text(365, 232, 'MCP', 12, MUTED, anchor='middle'); d.text(365, 268, 'OAuth', 12, MUTED, anchor='middle')
    d.arrow(798, 220, 872, 220); d.text(835, 207, t['gw'], 12, MUTED, anchor='middle')
    d.arrow(600, 498, 600, 536)
    d.packet('M 322 102 C 372 102, 360 245, 405 245', 6, 0, 1.4, amber=True)
    d.packet('M 798 220 L 872 220', 6, 1.9, 0.8)
    d.packet('M 600 498 L 600 536', 6, 3.0, 0.6)
    d.rect(300, 544, 600, 52)
    d.text(600, 568, t['gh'], 16, INK, True, 'middle'); d.text(600, 586, t['gh_sub'], 12.5, MUTED, anchor='middle', maxw=580)
    d.save()

def flow(lang):
    t = T[lang]; d = D(f'panter-flow{sfx(lang)}.svg', 1200, 520, f'pf{lang}', t['flow_title'], t['flow_desc'])
    d.label(40, 54, t['flow_head'])
    W, H = 255, 120
    top = [(40, 80), (330, 80), (620, 80), (910, 80)]
    bot = [(910, 270), (620, 270), (330, 270)]
    pos = top + bot
    for i, ((x, y), (name, lines)) in enumerate(zip(pos, t['steps'])):
        col = AMBER if i in (0, 6) else (TEAL if i == 4 else LINE)
        d.box(x, y, W, H, name, lines, col, badge=i + 1, badge_col=AMBER if i in (0, 6) else TEAL, lsize=12.5)
    for i in range(3): d.arrow(top[i][0] + W + 6, 140, top[i + 1][0] - 8, 140)
    d.path(f'M {910 + W // 2} {80 + H + 6} L {910 + W // 2} {270 - 8}')
    for i in range(2): d.arrow(bot[i][0] - 6, 330, bot[i + 1][0] + W + 8, 330)
    # the worker's app band
    d.rect(40, 270, 255, 120, LINE, PANEL, 12, 2, '6 6')
    fb = {'en': ('No pickup in time?', ['the work falls back to the leader,', 'which does it natively, so a', 'sleeping worker never blocks a run']),
          'es': ('¿Nadie la toma a tiempo?', ['el trabajo vuelve al líder, que lo', 'hace él mismo: un trabajador', 'dormido nunca frena una corrida'])}[lang]
    d.text(60, 302, fb[0], 15, INK, True, maxw=220)
    for i, ln in enumerate(fb[1]): d.text(60, 328 + 20 * i, ln, 12.5, MUTED, maxw=225)
    d.path(f'M 330 {270 + 60} L 303 {270 + 60}', 'muted', '6 6')
    # along the corridors, never over a box: under row 1, round the right edge, under row 2, up into step 7
    d.packet('M 167 202 L 167 235 L 1182 235 L 1182 405 L 457 405 L 457 392', 10, 0, 8.6)
    d.rect(40, 420, 1125, 64, LINE, PANEL, 14)
    d.text(602, 458, t['flow_note'], 13.5, MUTED, anchor='middle', maxw=1090)
    d.save()

def wake(lang):
    t = T[lang]; d = D(f'panter-wake{sfx(lang)}.svg', 1200, 560, f'pw{lang}', t['wake_title'], t['wake_desc'])
    d.rect(40, 190, 270, 140, AMBER, PANEL, 18)
    d.text(64, 236, t['wake_head'], 20, INK, True, maxw=230)
    for i, ln in enumerate(t['wake_sub']): d.text(64, 268 + 22 * i, ln, 13.5, MUTED, maxw=230)
    x0, y0 = 470, 40
    for i, (host, route, how) in enumerate(t['routes']):
        y = y0 + 90 * i
        d.rect(x0, y, 690, 74, TEAL if i < 4 else LINE)
        d.text(x0 + 20, y + 30, host, 16, INK, True, maxw=300)
        d.text(x0 + 20, y + 54, how, 12.5, MUTED, maxw=340)
        d.rect(x0 + 380, y + 15, 290, 44, LINE, BG, 22, 1.5)
        d.text(x0 + 525, y + 42, route, 13, TEAL if i < 4 else MUTED, True, 'middle', maxw=270)
        d.path(f'M 312 260 C 390 260, 390 {y + 37}, {x0 - 8} {y + 37}', 'teal' if i < 4 else 'muted', None if i < 4 else '6 6')
        d.packet(f'M 312 260 C 390 260, 390 {y + 37}, {x0 - 8} {y + 37}', 5, 0.55 * i, 1.4)
    d.text(390, 250, t['ring'], 12, MUTED, anchor='middle')
    d.rect(40, 496, 1120, 44, LINE, PANEL, 12)
    d.text(600, 523, t['wake_note'], 13.5, MUTED, anchor='middle', maxw=1090)
    d.save()

def gate(lang):
    t = T[lang]; d = D(f'panter-delivery-gate{sfx(lang)}.svg', 1200, 600, f'pg{lang}', t['gate_title'], t['gate_desc'])
    d.box(40, 150, 220, 100, t['gate_pr'], t['gate_pr_sub'], TEAL)
    d.arrow(266, 200, 322, 200)
    # always block
    d.rect(330, 40, 450, 210, RED, PANEL, 16)
    d.text(352, 74, t['gate_always'], 16, INK, True, maxw=400)
    for i, it in enumerate(t['gate_always_items']):
        d.dot(360, 106 + 36 * i, RED); d.text(376, 111 + 36 * i, it, 14, INK, maxw=390)
    d.rect(330, 270, 450, 210, AMBER, PANEL, 16, 2, '7 6')
    d.text(352, 304, t['gate_soft'], 16, INK, True, maxw=410)
    for i, it in enumerate(t['gate_soft_items']):
        d.dot(360, 336 + 36 * i, AMBER); d.text(376, 341 + 36 * i, it, 14, INK, maxw=390)
    d.arrow(786, 200, 842, 200)
    d.box(850, 150, 310, 100, t['gate_merge'], t['gate_merge_sub'], GREEN)
    d.packet('M 262 200 L 324 200', 5, 0, 0.8)
    d.packet('M 346 40 L 764 40', 5, 0.95, 1.4, amber=True)
    d.packet('M 784 200 L 846 200', 5, 2.6, 0.8)
    d.rect(850, 270, 310, 210, LINE, PANEL, 16)
    d.text(872, 304, t['gate_never'], 16, INK, True, maxw=270)
    for i, it in enumerate(t['gate_never_items']):
        d.text(872, 338 + 30 * i, '✕', 14, RED, True); d.text(894, 338 + 30 * i, it, 13.5, MUTED, maxw=250)
    d.rect(40, 500, 1120, 64, LINE, PANEL, 12)
    note = {'en': ['Owner mode (PANTER_OWNER_MODE=1) turns the dashed box into warnings. The red box and the worker limits never change.', 'Without an independent reviewer configured, owner mode blocks every delivery.'],
            'es': ['El modo dueño (PANTER_OWNER_MODE=1) convierte la caja punteada en avisos. La caja roja y los límites de los trabajadores nunca cambian.', 'Sin una cuenta revisora configurada, el modo dueño bloquea toda entrega.']}[lang]
    d.text(600, 527, note[0], 13, MUTED, anchor='middle', maxw=1090); d.text(600, 549, note[1], 13, MUTED, anchor='middle', maxw=1090)
    d.save()

def repo(lang):
    t = T[lang]; d = D(f'panter-repo-vs-server{sfx(lang)}.svg', 1200, 560, f'pr{lang}', t['repo_title'], t['repo_desc'])
    d.rect(40, 40, 440, 400, TEAL, PANEL, 18); d.text(64, 76, t['repo_l'], 17, INK, True, maxw=400)
    for i, (n, s) in enumerate(t['repo_items']): d.box(60, 96 + 82 * i, 400, 66, n, [s], LINE, tsize=15, lsize=13)
    d.rect(720, 40, 440, 400, AMBER, PANEL, 18); d.text(744, 76, t['repo_r'], 17, INK, True, maxw=400)
    for i, (n, s) in enumerate(t['srv_items']): d.box(740, 96 + 82 * i, 400, 66, n, [s], LINE, tsize=15, lsize=13)
    d.arrow(490, 210, 710, 210)
    d.packet('M 470 210 L 730 210', 4, 0, 1.8)
    d.text(600, 196, t['deploy'], 14, INK, True, 'middle', mono=True, maxw=210); d.text(600, 236, t['deploy_sub'], 12.5, MUTED, anchor='middle', maxw=210)
    d.path('M 710 300 L 490 300', 'muted', '6 6')
    d.parts.append(f'  <line x1="585" y1="285" x2="615" y2="315" stroke="{RED}" stroke-width="3"/>')
    d.parts.append(f'  <line x1="615" y1="285" x2="585" y2="315" stroke="{RED}" stroke-width="3"/>')
    d.text(600, 340, t['back'], 12.5, MUTED, anchor='middle', maxw=210)
    d.rect(40, 466, 1120, 64, LINE, PANEL, 14)
    d.text(600, 504, t['repo_note'], 14, MUTED, anchor='middle', maxw=1090)
    d.save()

for lang in ('en', 'es'):
    architecture(lang); flow(lang); wake(lang); gate(lang); repo(lang)
print('\n'.join(WARN) if WARN else 'no overflow warnings')
