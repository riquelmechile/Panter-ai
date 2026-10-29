import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Panter Agent Studio', version: '0.4.0' });
const hostNames = ['gpt-a', 'gpt-b', 'grok', 'gemini', 'claude'] as const;
const roleNames = ['explorer', 'architect', 'implementer', 'verifier', 'reviewer'] as const;
type Host = typeof hostNames[number];
type Profile = { host: Host; actorId: string; modelRequest: string; effortRequest: string; roles: string[]; revision: number };
const hostBox = document.getElementById('hosts')!;
const status = document.getElementById('status')!;
const refresh = document.getElementById('refresh') as HTMLButtonElement;

function setStatus(text: string, error = false) {
  status.textContent = text;
  status.className = `status ${error ? 'bad' : 'good'}`;
}
function field(label: string, value: string, maxLength: number): HTMLInputElement {
  const wrap = document.createElement('div');
  const caption = document.createElement('label'); caption.textContent = label;
  const input = document.createElement('input'); input.type = 'text'; input.maxLength = maxLength; input.value = value;
  wrap.append(caption, input);
  return input;
}
function readTextResponse(result: Awaited<ReturnType<typeof app.callServerTool>>) {
  if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text ?? 'Error MCP');
  const text = result.content?.find(c => c.type === 'text')?.text;
  if (!text) throw new Error('Respuesta MCP vacía');
  return JSON.parse(text) as unknown;
}
async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  return readTextResponse(await app.callServerTool({ name, arguments: args }));
}
function card(host: Host, existing?: Profile) {
  const article = document.createElement('article'); article.className = 'host';
  const heading = document.createElement('h2'); heading.textContent = `${host.toUpperCase()}${host === 'gpt-a' ? ' · Orquestador' : ''}`;
  const subtitle = document.createElement('p'); subtitle.textContent = existing ? `Perfil guardado · revisión ${existing.revision}` : 'Pendiente de configurar';
  article.append(heading, subtitle);
  const actor = field('Alias del actor (no es una credencial)', existing?.actorId ?? `actor-${host}`, 160);
  const model = field('Modelo solicitado', existing?.modelRequest ?? 'host-default', 120);
  const effort = field('Esfuerzo solicitado', existing?.effortRequest ?? 'max', 32);
  for (const inp of [actor, model, effort]) article.append(inp.parentElement!);
  const legend = document.createElement('label'); legend.textContent = 'Roles asignados';
  article.append(legend);
  const roles = document.createElement('div'); roles.className = 'roles';
  const checkboxes: Array<[string, HTMLInputElement]> = [];
  for (const role of host === 'gpt-a' ? ['orchestrator'] : roleNames) {
    const label = document.createElement('label');
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = host === 'gpt-a' || !!existing?.roles.includes(role);
    check.disabled = host === 'gpt-a';
    label.append(check, document.createTextNode(role)); roles.append(label); checkboxes.push([role, check]);
  }
  article.append(roles);
  const save = document.createElement('button'); save.textContent = 'Guardar perfil'; save.type = 'button';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const chosen = checkboxes.filter(([, box]) => box.checked).map(([role]) => role);
      if (!chosen.length) throw new Error('Selecciona al menos un rol');
      if (actor.value.trim().length < 3) throw new Error('El alias debe tener al menos 3 caracteres');
      const response = await call('panter_mesh_profile_set', {
        host, actorId: actor.value.trim(), modelRequest: model.value.trim(), effortRequest: effort.value.trim(),
        roles: chosen, expectedRevision: existing?.revision ?? 0,
      }) as Profile;
      existing = response;
      subtitle.textContent = `Perfil guardado · revisión ${response.revision}`;
      setStatus(`Guardado ${host.toUpperCase()}: revisión ${response.revision}.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Error de configuración', true); }
    finally { save.disabled = false; }
  });
  article.append(save);
  return article;
}
async function load() {
  refresh.disabled = true;
  try {
    const profiles = await call('panter_mesh_profiles', {}) as Profile[];
    hostBox.replaceChildren(...hostNames.map(host => card(host, profiles.find(p => p.host === host))));
    setStatus(`Conectado. ${profiles.length} de ${hostNames.length} perfiles configurados.`);
  } catch (error) { setStatus(error instanceof Error ? error.message : 'No se pudo consultar MCP', true); }
  finally { refresh.disabled = false; }
}
refresh.addEventListener('click', () => { void load(); });
app.ontoolresult = () => { void load(); };
void app.connect().then(load).catch(error => setStatus(`No se pudo conectar la vista: ${String(error)}`, true));
