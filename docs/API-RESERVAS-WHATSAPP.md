# APIs de reservas (WhatsApp y web) — Limablue Agenda

Permite que el chat de WhatsApp de Limablue **consulte horarios y registre la cita de un paciente** conversando con él,
sin pasarela de pago: **la cita se crea al confirmar y el paciente paga en la sede**.

- Servidor a servidor (no se llama desde un navegador).
- Misma disponibilidad real que la Agenda: no hay doble reserva, respeta horarios, almuerzos, permisos y días especiales.
- Solo se ofrecen los servicios que la clínica marcó como «reserva en línea» en Administración › Reserva web (los mismos de la página `/agendamiento_directo_limablue_un_paso_cerca_de_ti/reserva`).
- Cada reserva entra a la Agenda con el **canal de su API** («WhatsApp» o «Web»), pago **pendiente** y un comentario con el código de reserva.

**Dos APIs (12-nov-2026):** iguales en rutas, campos y respuestas; cambian la dirección y la llave. El canal lo pone la llave.

| API | Dirección base | Permiso de la llave | Canal de la cita |
|---|---|---|---|
| WhatsApp (chat) | `https://<servidor>/api/v1/integraciones/whatsapp` | `reservas:whatsapp` | `whatsapp` |
| Web | `https://<servidor>/api/v1/integraciones/reservas` | `reservas:write` (la llave que ya existía) | `web` |

- Una llave solo sirve en su dirección: la de la otra API responde **403**.
- Por código `LB-…` cada API solo ve las reservas hechas con ella.
- El pago previo de sábado y domingo (§3.6) y el aviso de 2 h (§3.7) son **solo de la API de WhatsApp**.

## 1. Conexión y llave

| | |
|---|---|
| Dirección base | `https://<servidor>/api/v1/integraciones/whatsapp` (WhatsApp) o `/integraciones/reservas` (web) (hoy `https://161.132.166.44/...`; con dominio, `https://agenda.limablue.com/...`) |
| Autenticación | Cabecera `Authorization: ApiKey <llave>` |
| Formato | JSON (`Content-Type: application/json`), UTF-8 |
| Horario | Todas las fechas y horas son de **Lima** (`AAAA-MM-DD`, `HH:MM` en 24 h) |

La **llave** la genera Sistemas en el servidor con **«Llave API del chat.bat»**. Se muestra **una sola vez** (en la base solo queda
su huella). Si se pierde o se filtra, se crea otra y la anterior deja de funcionar al instante. Cada llave sirve solo para su API
(permiso `reservas:whatsapp` o `reservas:write`): no abre la Agenda ni ve datos de pacientes. **Guárdenla como un secreto**: no en el código del bot,
no en chats ni correos abiertos; usen una variable de entorno o un gestor de secretos.

> Los paths de la API (`/api/...`) **no** llevan el prefijo `/acceso_agenda_lb` de las pantallas.

## 2. Flujo recomendado para la conversación

1. `GET /catalogo` → sedes y servicios (con variantes y precios). Se puede guardar en caché unos minutos.
2. Preguntar al paciente **sede y servicio** (y la variante, si el servicio tiene varias).
3. `GET /dias` → días con horarios libres; `GET /horas` → horas de un día. Ofrecer solo lo que devuelven.
4. Pedir los datos: **tipo de documento (DNI o CE) y número, nombres, apellido paterno, (apellido materno), celular** y, si lo tiene,
   **correo**. El celular puede ser el del propio WhatsApp.
5. **Pedir el consentimiento** de tratamiento de datos personales y mandar `aceptaDatos: true`.
6. `POST /` con todo → responde el **código de reserva** y la cita queda creada. Confirmar al paciente: sede, dirección, día, hora,
   precio a pagar en esa sede (`precios[sedeId]`), código, y «llega 10 minutos antes con tu documento».

Si entre el paso 3 y el 6 alguien toma esa hora, el `POST /` responde **409** (`HORA_NO_DISPONIBLE`): vuelvan a consultar `/horas` y ofrezcan otra.

## 3. Endpoints

### 3.1 `GET /catalogo`
Sedes y servicios reservables.

```bash
curl -H "Authorization: ApiKey $LLAVE" https://<servidor>/api/v1/integraciones/reservas/catalogo
```
```json
{
  "sedes": [
    { "id": "a1b2…", "nombre": "Los Olivos", "direccion": "Av. …", "horario": "Lun–Sáb 8:00–20:00" }
  ],
  "servicios": [
    {
      "id": "c3d4…", "nombre": "Evaluación PO", "duracionMinutos": 30, "unidad": "Podología",
      "sedes": ["a1b2…"],
      "variantes": [ { "id": null, "nombre": "Evaluación PO", "precio": 50, "precios": { "a1b2…": 50, "e5f6…": 60 } } ]
    }
  ],
  "reglas": { "diasMaximos": 30, "anticipacionMinutosHoy": 120 }
}
```
- `servicios[].sedes`: ids de las sedes donde se ofrece ese servicio.
- `variantes`: si el servicio tiene tipos (p. ej. «Limpieza clínica · Regular»), cada uno trae su `id` y `precio`; si no, hay una sola con `id: null`.
- `precios` (en soles) es el precio que se **paga en cada sede** (clave: id de la sede). **Cada sede puede cobrar distinto**: al confirmar al paciente, mostrar `precios[<id de la sede elegida>]`. Un tipo que no aparece en `precios` para una sede no se ofrece allí.
- `precio` es el precio web **general** (el de las sedes que no tienen precio propio); úsenlo solo como referencia. Se configura en Administración › Reserva web (si no hay uno, rige el precio de la clínica). Un servicio sin precio no aparece.
- `reglas.diasMaximos`: hasta cuántos días adelante se puede reservar. `anticipacionMinutosHoy`: para el mismo día, mínimo de minutos de anticipación.

### 3.2 `GET /dias?sedeId=&servicioId=&desde=&hasta=`
Días con horarios libres (máximo 31 días por consulta).
```json
{ "dias": [ { "fecha": "2026-11-02", "horas": 18 }, { "fecha": "2026-11-03", "horas": 12 } ] }
```
Los días que no aparecen no tienen horarios libres.

### 3.3 `GET /horas?sedeId=&servicioId=&fecha=`
```json
{ "fecha": "2026-11-02", "horas": ["09:00", "09:30", "10:00"], "cupos": { "09:00": 2, "09:30": 1, "10:00": 3 } }
```
`cupos` (13-nov-2026) = cuántos pacientes caben **a la vez** en cada hora (especialistas libres). No ofrezcan la misma hora a más
pacientes que sus cupos: el que llegue después recibirá `409 HORA_NO_DISPONIBLE`.

### 3.4 `POST /` — registrar la reserva (crea la cita)

```bash
curl -X POST https://<servidor>/api/v1/integraciones/reservas \
  -H "Authorization: ApiKey $LLAVE" -H "Content-Type: application/json" \
  -d '{
    "tipoDocumento": "CE",
    "numeroDocumento": "001234567",
    "nombres": "Ana María",
    "apellidoPaterno": "Quispe",
    "apellidoMaterno": "Rojas",
    "telefono": "987654321",
    "email": "ana@correo.pe",
    "sedeId": "a1b2…",
    "servicioId": "c3d4…",
    "subcategoriaId": null,
    "fecha": "2026-11-02",
    "horaInicio": "09:00",
    "aceptaDatos": true,
    "referencia": "wa-51987654321-20261029-0001"
  }'
```

| Campo | Obligatorio | Detalle |
|---|---|---|
| `tipoDocumento` | no (por defecto `DNI`) | `DNI` o `CE` (carné de extranjería) |
| `numeroDocumento` | sí | DNI: 8 dígitos. CE: 8 a 12 letras o números. Se aceptan espacios y guiones (se limpian) |
| `nombres`, `apellidoPaterno` | sí | 2 caracteres o más |
| `apellidoMaterno` | no | |
| `telefono` | sí | Celular peruano. Acepta `987654321`, `+51 987 654 321`, `51987654321`. Se guarda a 9 dígitos y debe empezar con 9 |
| `email` | no | Si no lo tiene, omitirlo (o `""`) |
| `sedeId`, `servicioId` | sí | Ids del catálogo. El servicio debe ofrecerse en esa sede |
| `subcategoriaId` | solo si el servicio tiene variantes | `id` de la variante del catálogo; si el servicio tiene una sola, omitirlo o `null` |
| `fecha`, `horaInicio` | sí | Una hora que devolvió `/horas` |
| `aceptaDatos` | sí, `true` | El paciente aceptó el tratamiento de sus datos personales |
| `referencia` | recomendado | Identificador **único de esta petición** (6 a 100 caracteres; p. ej. id de la conversación + número de intento). Evita citas duplicadas si el chat **reintenta** (ver §4). También se acepta en la cabecera `Idempotency-Key` |

Respuesta **201** (o **200** si es un reintento ya procesado, con `"repetida": true`):
```json
{
  "codigo": "LB-567405",
  "estado": "confirmada",
  "citaId": "9f8e…",
  "repetida": false,
  "fecha": "2026-11-02",
  "horaInicio": "09:00",
  "duracionMinutos": 30,
  "monto": 50,
  "moneda": "PEN",
  "sede": { "nombre": "Los Olivos", "direccion": "Av. …" },
  "servicio": "Evaluación PO",
  "variante": null
}
```
- La **profesional** se asigna automáticamente (la que esté libre a esa hora). No se informa su nombre.
- Si el paciente ya existe (mismo tipo y número de documento), se usa su ficha **sin modificar sus datos**; si no, se registra uno nuevo.
- Si hay correo, el paciente recibe el correo de confirmación de la Agenda.
- **Sábado y domingo por WhatsApp:** la respuesta puede venir con `"estado": "esperando_pago"` y un enlace de pago: ver §3.6.

### 3.5 `GET /:codigo` — estado de una reserva hecha por el chat
```json
{
  "codigo": "LB-567405", "estado": "confirmada", "citaVigente": true, "estadoCita": "agendada",
  "nombres": "Ana María", "fecha": "2026-11-02", "horaInicio": "09:00", "duracionMinutos": 30,
  "sede": { "nombre": "Los Olivos", "direccion": "Av. …" }, "servicio": "Evaluación PO", "variante": null,
  "monto": 50, "moneda": "PEN"
}
```
`estado` es `confirmada` o `cancelada` (si recepción canceló la cita); con pago previo (§3.6) también `esperando_pago`,
`expirada` (no pagó a tiempo: la cita se canceló) o `reembolsar` (pagó cuando la cita ya no estaba vigente), y vienen
`pagado`, `pagoEstado` y, mientras se pueda pagar, `pago`. `estadoCita` es el estado real en la Agenda
(`agendada`, `confirmada`, `llego`, `en_atencion`, `completada`, `no_show`, `cancelada`, `reprogramada`). Si el paciente quiere
**cambiar o cancelar**, ver 3.8.

### 3.6 Pago previo de sábado y domingo (13-nov-2026) — solo canal `whatsapp`
Las citas de **sábado y domingo** que se reservan por el chat (canal `whatsapp`) se pagan **antes**, por la tienda en línea de
Limablue (Niubiz). Lunes a viernes y la página /reserva: sin cambios (se paga en la sede). Feriados: por ahora no piden pago. Si en el
servidor no está conectada la tienda (`WOO_URL`, `WOO_CONSUMER_KEY`, `WOO_CONSUMER_SECRET`), todo sigue como siempre.

`POST /` de un sábado o domingo responde **201** con la cita **apartada** y el enlace de pago:
```json
{
  "codigo": "LB-123456", "estado": "esperando_pago", "citaId": "…", "repetida": false,
  "fecha": "2026-11-14", "horaInicio": "10:00", "duracionMinutos": 30, "monto": 90, "moneda": "PEN",
  "sede": { "nombre": "Los Olivos", "direccion": "Av. …" }, "servicio": "Evaluación PO", "variante": null,
  "pago": { "url": "https://…/order-pay/…", "expiraEn": "2026-11-13T15:10:00.000Z", "minutos": 10, "monto": 90 }
}
```
- Envíen `pago.url` al paciente: tiene **10 minutos** (`pago.expiraEn`). Hasta que pague **no digan que la cita está confirmada**.
- Para saber si ya pagó: `GET /:codigo` (§3.5) trae `estado`, `pagoEstado` (`pendiente` | `pagado` | `rechazado` | `monto_distinto`)
  y, mientras se pueda pagar, el mismo `pago`. Al pagar pasa a `"estado": "confirmada"` y `"pagado": true` (segundos después del pago).
- Un pago **rechazado** (tarjeta sin fondos…) se puede reintentar con el mismo enlace dentro de los 10 minutos.
- Si **no paga** a tiempo, la cita se cancela sola, la hora queda libre y el enlace deja de servir: `"estado": "expirada"`. Para volver a
  intentarlo se hace una reserva **nueva** (con otra `referencia`).
- `"estado": "reembolsar"`: pagó cuando la cita ya no estaba vigente. **No** se reagenda sola: deriven a un asesor (devolución o nueva cita).
- Si la tienda no responde al reservar: `502 PAGO_NO_DISPONIBLE` y **no se crea nada** (reintentar en un momento o derivar a un asesor).

**Aviso de pago de la tienda (lo configura Sistemas):** WooCommerce › Ajustes › Avanzado › Webhooks › «Pedido actualizado», API v3,
URL `https://<dominio de la Agenda>/api/v1/publico/pagos/woo` (**sin** secretos en la URL) y en «Secreto» el mismo valor de
`WOO_WEBHOOK_SECRET`. WooCommerce firma cada aviso con él (`X-WC-Webhook-Signature`); sin la firma correcta se responde 401. Aun con
firma válida, la Agenda vuelve a leer el pedido en la tienda antes de confirmar.

### 3.7 Aviso por WhatsApp 2 h antes de la cita (para el flujo de GHL)
Para las citas reservadas por el chat (canal `whatsapp`), la Agenda llama una sola vez, unas **2 horas antes** de la cita, al webhook
del flujo de GHL configurado en `GHL_AVISO_WEBHOOK_URL`, y GHL envía la plantilla de WhatsApp. Lo que manda la Agenda (`POST`, JSON):
```json
{ "codigo": "LB-123456", "telefono": "+51987654321", "nombres": "Ana María", "fecha": "2026-11-14", "hora": "10:00",
  "servicio": "Evaluación PO", "sede": "Los Olivos", "direccion": "Av. …" }
```
- Fecha y hora son las **actuales** de la cita (si se reprogramó, la nueva). No se avisa si la cita se canceló, si el paciente ya
  llegó o si faltan menos de 20 minutos. Las de pago previo se avisan solo si se pagaron.
- El webhook debe responder `2xx`; si no, la Agenda reintenta cada minuto mientras falten más de 20 minutos.

### 3.8 Mis citas, cancelar y reprogramar (16-nov-2026)
Sirve para **cualquier cita vigente** del paciente (la creó el chat o recepción). La identidad es el **documento** del paciente (decisión
de la clínica; se mitiga con límites por llave —20 búsquedas y 10 cambios por minuto—, auditoría y devolviendo solo datos mínimos).
El tipo de documento es opcional: sin él se busca por el número.

**`GET /citas-paciente?numeroDocumento=75921504`** → citas vigentes y futuras:
```json
{ "citas": [ { "codigo": "LB-490390", "fecha": "2026-11-16", "horaInicio": "13:00", "duracionMinutos": 60,
  "sede": { "nombre": "Lince", "direccion": "…" }, "servicio": "Limpieza Clínica del Pie", "variante": "Regular",
  "estadoCita": "agendada", "puedeCambiar": true } ] }
```
`codigo` es el `LB-…` si la cita nació de una reserva en línea, o el **id de la cita** si la registró la clínica: úsenlo tal cual abajo.
`puedeCambiar: false` trae `motivo` (los códigos de la tabla de abajo): Ana deriva a un asesor. Sin citas: `citas: []`.

**`POST /{codigo}/cancelar`** — cuerpo `{ "numeroDocumento": "75921504", "motivo": "…" }` (motivo opcional). `200`
`{ codigo, estado: "cancelada", repetida }`; si ya estaba cancelada, `repetida: true`. Si el documento no es del dueño: `404 RESERVA_NO_ENCONTRADA`.

**`POST /{codigo}/reprogramar`** — cuerpo `{ "numeroDocumento": "75921504", "fecha": "2026-11-17", "horaInicio": "10:00" }`. La hora debe salir
de `/horas` (misma sede y servicio de la cita). `201` con `codigo`, `estado: "confirmada"`, `citaId`, `fecha`, `horaInicio`,
`duracionMinutos`, `monto`, `moneda`, `sede`, `servicio`, `variante`, `repetida` y `codigoAnterior`. **La cita se mueve, no se crea
otra**: conserva su código y su historial, así que `codigo` = `codigoAnterior`. Pedir la misma fecha y hora que ya tiene (un reintento)
responde igual, con `repetida: true`. Si la hora nueva ya se ocupó: `409 HORA_NO_DISPONIBLE` y la cita queda como estaba.

Códigos `409` (Ana deriva a un asesor, salvo `HORA_NO_DISPONIBLE`, que se resuelve ofreciendo otra hora):
| Código | Cuándo |
|---|---|
| `FUERA_DE_PLAZO` | Faltan menos de 2 horas para la cita (o ya pasó). Configurable: `RESERVA_CHAT_CAMBIO_ANTICIPACION_MIN` (120) |
| `REQUIERE_ASESOR` | Cita con pago (en línea o en la sede), de paquete o de visita de dos servicios, o con profesional pedido; reprogramar a un sábado o domingo, un servicio que no se reserva en línea en esa sede o un paciente sin DNI ni CE |
| `ESPERANDO_PAGO` | La reserva de fin de semana aún espera el pago (se libera sola a los 10 minutos) |
| `NO_SE_PUEDE_CANCELAR` | La cita ya está en curso o fue atendida |
| `NO_VIGENTE` | La cita ya no está vigente (cancelada) — solo al reprogramar |
| `HORA_NO_DISPONIBLE` | La hora nueva ya se ocupó |

### 3.9 Rutas agrupadas para GHL (16-nov-2026) — solo la API de WhatsApp
GHL deja solo **5 acciones «Llamada a API» por agente**. Estas dos rutas reúnen todo, y Ana usa 3 acciones (Consultar, Reservar cita con
`POST /` y Cambiar cita). Hacen lo mismo que las rutas sueltas (mismas funciones, reglas y límites); las sueltas siguen funcionando.

**`GET /consultar?que=…`** — el parámetro `que` elige la consulta:

| `que` | Parámetros obligatorios | Equivale a |
|---|---|---|
| `catalogo` | — | `GET /catalogo` |
| `dias` | `sedeId`, `servicioId`, `desde`, `hasta` | `GET /dias` |
| `horas` | `sedeId`, `servicioId`, `fecha` | `GET /horas` (con `cupos`) |
| `reserva` | `codigo` (`LB-123456`) | `GET /:codigo` |
| `citas` | `numeroDocumento` | `GET /citas-paciente` (con su límite de 20 por minuto) |

**`POST /cambiar`** — cuerpo JSON con `accion`:
- `{ "accion": "cancelar", "codigo": "LB-123456", "numeroDocumento": "…", "motivo": "…" }` → como `POST /{codigo}/cancelar` (`200`).
- `{ "accion": "reprogramar", "codigo": "LB-123456", "numeroDocumento": "…", "fecha": "AAAA-MM-DD", "horaInicio": "HH:MM" }` → como
  `POST /{codigo}/reprogramar` (`201`).

Una combinación inválida (por ejemplo `que=horas` sin `fecha`, o una `accion` desconocida) responde `422` con el campo que falta.

## 4. Reintentos sin duplicar (`referencia`)
Si la llamada `POST /` se corta (tiempo de espera, caída de red) y no saben si se creó, **repitan exactamente la misma petición con la
misma `referencia`**: devuelve la reserva ya creada (`200`, `"repetida": true`) en vez de crear otra cita. Usen una `referencia`
**nueva** para cada reserva distinta. La misma `referencia` siempre devuelve **lo que pasó con esa reserva**: si era de pago previo
y ya venció, vuelve `"estado": "expirada"` (para intentarlo otra vez, otra `referencia`).

## 5. Errores
Formato general: `{ "error": "CODIGO", "message": "texto en español", "statusCode": 4xx }`. Los errores de datos (422) traen el detalle por campo:
```json
{ "error": "VALIDATION_ERROR", "message": "…", "details": [ { "campo": "numeroDocumento", "mensaje": "El DNI tiene 8 dígitos" } ] }
```
Los mensajes (`message`, `mensaje`) están en español y se pueden **mostrar tal cual al paciente**.

| HTTP | `error` | Cuándo |
|---|---|---|
| 401 | `UNAUTHORIZED` / `INVALID_API_KEY` | Falta la llave o no es válida |
| 403 | `FORBIDDEN` | La llave no es de esta API (p. ej. la llave web en `/integraciones/whatsapp`) |
| 400 | `SERVICIO_NO_RESERVABLE` | Ese servicio no se ofrece en esa sede (o no es reservable) |
| 400 | `VARIANTE_REQUERIDA` | El servicio tiene tipos: falta `subcategoriaId` |
| 400 | `FECHA_PASADA` / `FECHA_MUY_LEJANA` | Fecha fuera del rango reservable |
| 409 | `HORA_NO_DISPONIBLE` | Esa hora ya se ocupó: ofrecer otra |
| 502 | `PAGO_NO_DISPONIBLE` | Sábado o domingo: la tienda no respondió al preparar el pago. No se creó nada |
| 422 | `VALIDATION_ERROR` | Datos mal escritos (documento, celular, correo, falta `aceptaDatos`…) |
| 404 | `RESERVA_NO_ENCONTRADA` | El código no existe, se hizo con la otra API o (3.8) el documento no es del dueño de la cita |
| 409 | `FUERA_DE_PLAZO` / `REQUIERE_ASESOR` / `ESPERANDO_PAGO` / `NO_SE_PUEDE_CANCELAR` / `NO_VIGENTE` | Cancelar/reprogramar: ver la tabla de 3.8 (Ana deriva a un asesor) |
| 429 | `DEMASIADOS_INTENTOS` | Límite de la llave por minuto: 240 consultas, 30 reservas, 20 búsquedas de citas por documento y 10 cancelaciones o reprogramaciones. Esperar un momento |
| 502 / 503 | `AGENDA_ERROR` / `AGENDA_NO_RESPONDE` / `RESERVA_NO_CONFIGURADA` | Falla temporal o sin configurar en el servidor: reintentar con la **misma** `referencia`; si persiste, avisar a Sistemas |

## 6. Pruebas
Pidan a Sistemas una cita de prueba con un paciente de prueba. Para probar sin ensuciar la Agenda, usen un número de documento
claramente ficticio y avisen para que recepción cancele esas citas. **No hay entorno separado**: todo lo que se registre con la llave
real crea citas reales.

## 7. Seguridad (resumen)
- La llave viaja solo por HTTPS y solo en la cabecera `Authorization`; no en la URL.
- La API no devuelve datos de pacientes (ni siquiera confirma si un documento ya existe) ni nombres de profesionales.
- Cada reserva queda auditada en la Agenda (quién/qué canal, código, cita creada).
- Si sospechan que la llave se filtró, avisen a Sistemas: se reemplaza en segundos.
