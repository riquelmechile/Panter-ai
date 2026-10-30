import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Panter Agent Studio', version: '0.4.0' });
const hostNames = ['gpt-a', 'gpt-b', 'grok', 'gemini', 'claude'] as const;
const roleNames = ['explorer', 'architect', 'implementer', 'verifier', 'reviewer'] as const;
type Host = typeof hostNames[number];
type Profile = { host: Host; actorId: string; modelRequest: string; effortRequest: string; roles: string[]; revision: number; preferNativeSubagents?:boolean; maxRequestedNativeWorkers?:number };
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
  // Requested GPT-A capacity limits do not attest that the ChatGPT host really
  // exposes native subagents. Effective count is bounded again by host evidence.
  const nativePrefs=host==='gpt-a'?document.createElement('div'):null;
  let prefer:HTMLInputElement|null=null;
  let maxWorkers:HTMLInputElement|null=null;
  if(nativePrefs){
    const lab=document.createElement('label');lab.textContent='Solicitar subagentes nativos cuando el host los permita';
    prefer=document.createElement('input');prefer.type='checkbox';prefer.checked=existing?.preferNativeSubagents!==false;
    lab.prepend(prefer);nativePrefs.append(lab);
    const caption=document.createElement('label');caption.textContent='Máximo solicitado de subagentes en paralelo (0–32)';
    maxWorkers=document.createElement('input');maxWorkers.type='number';maxWorkers.min='0';maxWorkers.max='32';maxWorkers.step='1';maxWorkers.value=String(existing?.maxRequestedNativeWorkers??32);
    nativePrefs.append(caption,maxWorkers);
    const explain=document.createElement('p');explain.textContent='Estos valores son límites solicitados; no crean trabajadores ni cambian el modelo del host.';nativePrefs.append(explain);
    article.append(nativePrefs);
  }
  const save = document.createElement('button'); save.textContent = 'Guardar perfil'; save.type = 'button';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const chosen = checkboxes.filter(([, box]) => box.checked).map(([role]) => role);
      if (!chosen.length) throw new Error('Selecciona al menos un rol');
      if (actor.value.trim().length < 3) throw new Error('El alias debe tener al menos 3 caracteres');
      const count=host==='gpt-a'?Number(maxWorkers!.value):undefined;
      if(host==='gpt-a'&&(!Number.isInteger(count)||count===undefined||count<0||count>32))throw new Error('Límite nativo inválido');
      const response = await call('panter_mesh_profile_set', {
        host, actorId: actor.value.trim(), modelRequest: model.value.trim(), effortRequest: effort.value.trim(),
        roles: chosen, ...(host==='gpt-a'?{preferNativeSubagents:prefer!.checked,maxRequestedNativeWorkers:count}:{}), expectedRevision: existing?.revision ?? 0,
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
    await loadSpecialists();
  } catch (error) { setStatus(error instanceof Error ? error.message : 'No se pudo consultar MCP', true); }
  finally { refresh.disabled = false; }
}
refresh.addEventListener('click', () => { void load(); });
app.ontoolresult = () => { void load(); };
void app.connect().then(load).catch(error => setStatus(`No se pudo conectar la vista: ${String(error)}`, true));

type Specialist = { id:string; role:string; summary:string; defaultSkills:readonly string[] };
type Skill = { id:string; summary:string };
type Assignment = {agentId:string;host:Host;modelRequest:string;effortRequest:string;skillIds:string[];revision:number};
const specialistBox = document.getElementById('specialists')!;
function specialistCard(a:Specialist, skills:Skill[], current?:Assignment) {
  const article=document.createElement('article'); article.className='host';
  const heading=document.createElement('h2');heading.textContent=a.id;
  const info=document.createElement('p');info.textContent=`${a.summary} · ${a.role}`;
  const subtitle=document.createElement('p');subtitle.textContent=current?`Revisión ${current.revision}`:'Sin asignación';
  article.append(heading,info,subtitle);
  const label=document.createElement('label');label.textContent='Aplicación que ejecutará el agente';
  const select=document.createElement('select');
  for(const host of hostNames.filter(x=>x!=='gpt-a')){
    const option=document.createElement('option');option.value=host;option.textContent=host.toUpperCase();
    if ((current?.host??'gpt-b')===host)option.selected=true;
    select.append(option);
  }
  article.append(label,select);
  const model=field('Modelo solicitado a este agente',current?.modelRequest??'host-default',120);
  const effort=field('Esfuerzo solicitado',current?.effortRequest??'high',32);
  article.append(model.parentElement!,effort.parentElement!);
  const details=document.createElement('details');
  const summary=document.createElement('summary');summary.textContent='Skills MCP asignadas';
  details.append(summary);
  const skillBox=document.createElement('div');skillBox.className='roles';
  const checks:Array<[string,HTMLInputElement]>=[];
  for (const skill of skills){
    const wrap=document.createElement('label');wrap.title=skill.summary;
    const check=document.createElement('input');check.type='checkbox';
    check.checked=(current?.skillIds??a.defaultSkills).includes(skill.id);
    wrap.append(check,document.createTextNode(skill.id));
    checks.push([skill.id,check]);skillBox.append(wrap);
  }
  details.append(skillBox);article.append(details);
  const save=document.createElement('button');save.type='button';save.textContent='Guardar agente';
  save.addEventListener('click',async()=>{
    save.disabled=true;
    try{
      const chosen=checks.filter(([,v])=>v.checked).map(([id])=>id);
      if(chosen.length>8)throw new Error('Máximo 8 skills por agente');
      const result=await call('panter_specialist_bind',{agentId:a.id,host:select.value,modelRequest:model.value.trim(),effortRequest:effort.value.trim(),skillIds:chosen,expectedRevision:current?.revision??0}) as Assignment;
      current=result;subtitle.textContent=`Revisión ${result.revision}`;
      setStatus(`Guardado ${a.id} en ${result.host.toUpperCase()} · ${chosen.length} skills.`);
    }catch(error){setStatus(error instanceof Error?error.message:'No se guardó',true)}
    finally{save.disabled=false}
  });
  article.append(save);
  return article;
}
async function loadSpecialists(){
  const [catalog,bindings]=await Promise.all([
    call('panter_gentle_catalog',{}) as Promise<{agents:Specialist[];skills:Skill[]}>,
    call('panter_specialist_assignments',{}) as Promise<Assignment[]>
  ]);
  specialistBox.replaceChildren(...catalog.agents.map(agent=>specialistCard(agent,catalog.skills,bindings.find(x=>x.agentId===agent.id))));
  setStatus(`Conectado · ${catalog.agents.length} agentes, ${catalog.skills.length} skills · ${bindings.length} configurados.`);
}
// The existing five-host cards and new per-specialist cards share one refresh.
