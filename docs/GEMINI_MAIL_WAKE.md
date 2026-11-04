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
- Si el relay rechaza el envío (4xx), la tarea vuelve a la cola con espera exponencial (hasta 30 min). Si la respuesta es ambigua (timeout, 5xx), el correo pudo haber salido: Panter conserva el lease y espera a que venza antes de reintentar, para que Gemini nunca tenga dos copias vivas de la misma tarea.
- Cada sobre se valida una sola vez y por su contenido completo, así que nadie puede reenviarlo por el relay ni cambiarle campos.
- Las dos rutas públicas tienen límite de tamaño (~300 KB de correo) y la lectura del correo es lineal (también el HTML).
- `PANTER_GEMINI_MAIL_RELAY_SECRET` es **obligatoria**: Panter y el Worker comparten esa clave en la cabecera `x-panter-relay-key`. El Worker la exige a quien le pide enviar y la manda a Panter; Panter rechaza (401) sin leer el cuerpo a quien no la tenga y registra una advertencia. Las peticiones sin clave pasan antes por un límite anónimo de 30/min por cliente (IPv6 agrupado por /64), así que tráfico basura no puede agotar el cupo del relay real. Si el cliente corta la conexión a mitad del cuerpo, Panter responde 400 y sigue vivo.
- Detrás de un proxy o túnel, sin `PANTER_TRUSTED_PROXY_CIDRS` todos los clientes anónimos comparten la IP del proxy; la clave compartida hace que eso no afecte al relay. Si usas `docs/nginx-panter.conf.example`, `/a2a/gemini/` sale por `location /`.
- La recuperación no depende de la contabilidad del relay: en cada pasada Panter devuelve a la cola toda tarea de solo lectura de Gemini cuyo lease venció (correo sin respuesta, caída a mitad del envío, error transitorio, chat que desapareció). Ninguna tarea queda RUNNING más allá de su lease.
- Reclamar una tarea para mandarla por correo (o cerrarla como fallida porque no se pudo entregar) no cuenta como que Gemini esté presente ni crea un rearm.
- Mientras una tarea está en vuelo por correo, ningún chat de Gemini puede tomarla ni renovar ese lease: una sola copia viva por tarea. Si el chat la quiere, la toma cuando el lease venza y vuelva a la cola.
- Si el relay rechaza la misma tarea 8 veces seguidas, se cierra como fallida en vez de reintentar para siempre.
- Si Panter se está reiniciando, el Worker reintenta entregar la respuesta de Gemini unos segundos antes de rebotarla.
- Si un chat de Gemini está escuchando y una tarea enviada por correo venció, vuelve a la cola para que la tome ese chat.
- Si Gemini no responde antes de que venza el lease, Panter reenvía con un lease y token nuevos (máximo 3 intentos) y después cierra la tarea como fallida.
- Aunque alguien obtuviera la clave del Worker, no puede enviar nada que Panter no reconozca ni completar trabajo sin el token del lease vigente.

Configuración en `panter.env`:

```
PANTER_GEMINI_MAIL_RELAY_URL=https://panter-gemini-mail-relay.<cuenta>.workers.dev/wake
PANTER_GEMINI_MAIL_RECIPIENT=<gmail que monitorea Gemini>
PANTER_GEMINI_MAIL_RELAY_SECRET=<obligatoria: 32+ caracteres URL-safe, igual al binding RELAY_SECRET del Worker>
# PANTER_GEMINI_MAIL_MIN_AGE_SECONDS=20
```

El código del Worker está en `deploy/cloudflare/panter-gemini-mail-relay.js` (bindings `PANTER_BASE_URL` en https, `RECIPIENT`, `RELAY_ADDRESS`, `RELAY_SECRET` y `EMAIL`; sin clave o sin https el Worker no opera). El Worker acepta correos de respuesta de hasta 300 KB. La dirección de relay necesita una regla de Email Routing hacia ese Worker.

En Gemini se crea una vez una tarea con monitor de Gmail: correos de la dirección de relay con asunto `[PANTER_GEMINI]`.
