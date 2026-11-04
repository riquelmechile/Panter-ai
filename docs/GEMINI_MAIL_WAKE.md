# Despertar a Gemini por correo (Gmail)

Gemini no envía `events/subscribe` y no tiene webhooks. Su único disparador por evento es un **monitor de Gmail** de sus tareas programadas. Panter lo usa así, sin API de Gemini (el mismo patrón que Xanxittoo usaba con Spark):

1. Una tarea de solo lectura para Gemini queda en cola y ningún chat de Gemini está esperando en vivo.
2. Pasados `PANTER_GEMINI_MAIL_MIN_AGE_SECONDS` (20 s por defecto), Panter reclama la tarea por una hora para ese intento y crea un **token de un solo uso** ligado a ese lease.
3. Panter manda el sobre al Worker `panter-gemini-mail-relay` (`PANTER_GEMINI_MAIL_RELAY_URL`). El Worker **pregunta a Panter** (`POST /a2a/gemini/email-validate`) si ese sobre exacto corresponde a un ticket pendiente, y solo entonces envía el correo a `PANTER_GEMINI_MAIL_RECIPIENT` con asunto `[PANTER_GEMINI] <workId>`.
4. El monitor de Gmail de Gemini ejecuta la tarea y **responde al correo** con la línea `PANTER_GEMINI_RESULT_V1` y un JSON `{work_id, token, success, result}`.
5. El Worker recibe la respuesta en su dirección de relay, verifica que venga del Gmail de Gemini y la reenvía cruda a Panter (`POST /a2a/gemini/email-result`). Panter completa la tarea solo con el token vigente, una sola vez.

Reglas:
- **Nunca** se manda por correo trabajo de implementador.
- Si un chat de Gemini está esperando con `panter_workforce_wait`, toma la tarea él y no se manda correo.
- Si el relay falla antes de enviar, la tarea vuelve a la cola con espera exponencial (hasta 30 min).
- Si Gemini no responde antes de que venza el lease, Panter reenvía con un lease y token nuevos (máximo 3 intentos) y después cierra la tarea como fallida.
- El Worker no guarda secretos: no puede enviar nada que Panter no reconozca.

Configuración en `panter.env`:

```
PANTER_GEMINI_MAIL_RELAY_URL=https://panter-gemini-mail-relay.<cuenta>.workers.dev/wake
PANTER_GEMINI_MAIL_RECIPIENT=<gmail que monitorea Gemini>
# PANTER_GEMINI_MAIL_MIN_AGE_SECONDS=20
```

El código del Worker está en `deploy/cloudflare/panter-gemini-mail-relay.js` (bindings `PANTER_BASE_URL`, `RECIPIENT`, `RELAY_ADDRESS` y `EMAIL`). La dirección de relay necesita una regla de Email Routing hacia ese Worker.

En Gemini se crea una vez una tarea con monitor de Gmail: correos de la dirección de relay con asunto `[PANTER_GEMINI]`.
