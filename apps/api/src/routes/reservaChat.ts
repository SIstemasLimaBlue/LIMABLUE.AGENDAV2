/**
 * APIs de RESERVAS PARA INTEGRACIONES (server a server, con llave: `Authorization: ApiKey <llave>`). Desde el 12-nov-2026 son DOS,
 * iguales en rutas y respuestas pero con llave y canal propios (crearApiReservas):
 *   - WEB       /api/v1/integraciones/reservas   llave con permiso «reservas:write» (la que ya existía)  → canal «web»
 *   - WHATSAPP  /api/v1/integraciones/whatsapp   llave con permiso «reservas:whatsapp»                  → canal «whatsapp»
 * Solo se guarda la huella de cada llave: no se pueden recuperar. El canal lo fija la LLAVE (lo que mande el cliente en `canal` se
 * ignora): por código LB cada API solo ve las reservas de su canal. Documentación: docs/API-RESERVAS-WHATSAPP.md.
 *
 * Sin pasarela de pago: la cita se crea al confirmar (pago pendiente: se paga en la sede). Excepción (13-nov-2026): por WHATSAPP, los
 * sábados y domingos se pagan antes por la tienda WooCommerce si está conectada (services/reservaWeb/pagoPrevio.ts). Solo se ofrecen
 * los servicios marcados «reserva en línea» (los mismos de la página /reserva) y con la misma disponibilidad real de la Agenda.
 *
 *  GET  /catalogo                                  sedes y servicios reservables, con variantes y precios
 *  GET  /dias?sedeId&servicioId&desde&hasta        días con horas libres
 *  GET  /horas?sedeId&servicioId&fecha             horas libres de un día y cupos (cuántos pacientes caben en cada hora)
 *  POST /                                          registra al paciente (DNI o CE) y CREA LA CITA
 *  GET  /:codigo                                   estado de una reserva hecha por esta API
 * Mis citas, cancelar y reprogramar (16-nov-2026, services/reservaWeb/gestion.ts; la identidad es el documento del paciente):
 *  GET  /citas-paciente?numeroDocumento=                        citas próximas del paciente (`codigo`, `puedeCambiar`, `motivo`)
 *  POST /:codigo/cancelar      {numeroDocumento, motivo?}        `codigo` = «LB-…» o el id de la cita
 *  POST /:codigo/reprogramar   {numeroDocumento, fecha, horaInicio}
 * Rutas AGRUPADAS para el agente de GHL (solo la API de WhatsApp):
 *  GET  /consultar?que=catalogo|dias|horas|reserva|citas       (+ los parámetros de cada consulta)
 *  POST /cambiar   {accion: cancelar|reprogramar, codigo, numeroDocumento, fecha?, horaInicio?, motivo?}
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/auth';
import { catalogo, horasConCupos, diasDisponibles, reservar, estadoReservaPorCodigo } from '../services/reservaWeb/reservaWebService';
import { camposPaciente, revisarDocumento, normalizarPaciente, normalizarDocumento, TIPOS_DOCUMENTO_RESERVA } from '../services/reservaWeb/validaciones';
import { citasProximas, cancelarCitaChat, reprogramarCitaChat } from '../services/reservaWeb/gestion';

/** Permiso de la llave de la API WEB (es el de la llave que existía antes de separar las APIs). */
export const SCOPE_RESERVAS = 'reservas:write';
/** Permiso de la llave de la API de WHATSAPP. */
export const SCOPE_RESERVAS_WHATSAPP = 'reservas:whatsapp';

const uuid = z.string().uuid('Debe ser un id (uuid) tomado del catálogo');
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');
const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora inválida (HH:MM, 24 h)');

// Correo opcional (en el chat a veces no lo tienen). aceptaDatos: el cliente debe haber pedido el consentimiento.
// Ya no hay campo `canal`: lo pone la llave (si llega, se ignora).
const crearSchema = camposPaciente({ emailObligatorio: false }).extend({
  sedeId: uuid, servicioId: uuid, subcategoriaId: uuid.optional().nullable(),
  fecha, horaInicio: hora,
  aceptaDatos: z.literal(true, { errorMap: () => ({ message: 'El paciente debe aceptar el tratamiento de sus datos personales (aceptaDatos: true)' }) }),
  referencia: z.string().trim().min(6).max(100).optional().nullable(),
}).superRefine(revisarDocumento);

// Documento del paciente para «mis citas», cancelar y reprogramar: el tipo es opcional (el chat manda solo el número).
// Sin tipo vale cualquier documento de 8 a 12 letras o números; con tipo se valida como al reservar.
const zDocumento = z.object({
  tipoDocumento: z.enum(TIPOS_DOCUMENTO_RESERVA).optional().nullable(),
  numeroDocumento: z.string().trim().min(1, 'Indica el número de documento').max(20),
}).superRefine((d, ctx) => {
  const n = normalizarDocumento(d.numeroDocumento);
  if (d.tipoDocumento) revisarDocumento({ tipoDocumento: d.tipoDocumento, numeroDocumento: n }, ctx);
  else if (!/^[A-Z0-9]{8,12}$/.test(n)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['numeroDocumento'], message: 'Documento inválido (8 a 12 letras o números)' });
});
const motivo = z.string().trim().max(300).optional().nullable();
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined });

export function crearApiReservas(o: { scope: string; canal: 'web' | 'whatsapp' }): Router {
  const router = Router();
  const { canal } = o;

  // Solo llaves con el permiso de ESTA API (un usuario con sesión de la Agenda, o la llave de la otra API, no entra por aquí).
  const exigirLlave = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.apiKey) throw new AppError('Esta API se usa con una llave (Authorization: ApiKey …)', 401, 'UNAUTHORIZED');
    if (!req.apiKey.scopes.includes(o.scope)) throw new AppError(`La llave no tiene el permiso «${o.scope}»`, 403, 'FORBIDDEN');
    next();
  };

  // Límite por llave (no por IP: el cliente sale desde pocos servidores). Cada API tiene sus propios contadores.
  const porLlave = (req: Request) => req.apiKey?.id ?? req.ip ?? 'sin-llave';
  const limite = (limit: number, message: string) => rateLimit({
    windowMs: 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: porLlave,
    handler: (_req, res) => { res.status(429).json({ error: 'DEMASIADOS_INTENTOS', message, statusCode: 429 }); },
  });
  const limiteConsultas = limite(240, 'Demasiadas consultas. Espera un minuto.');
  const limiteReservas = limite(30, 'Demasiadas reservas en un minuto. Espera un momento.');
  // Buscar citas por DOCUMENTO y cancelar/reprogramar: límites cortos, para frenar a quien pruebe documentos ajenos.
  const limiteBusqueda = limite(20, 'Demasiadas búsquedas en un minuto. Espera un momento.');
  const limiteCambios = limite(10, 'Demasiados cambios en un minuto. Espera un momento.');

  router.use(requireAuth, exigirLlave);

  router.get('/catalogo', limiteConsultas, async (_req, res) => {
    res.json(await catalogo());
  });

  router.get('/dias', limiteConsultas, async (req, res) => {
    const q = z.object({ sedeId: uuid, servicioId: uuid, desde: fecha, hasta: fecha }).parse(req.query);
    res.json({ dias: await diasDisponibles(q.sedeId, q.servicioId, q.desde, q.hasta) });
  });

  router.get('/horas', limiteConsultas, async (req, res) => {
    const q = z.object({ sedeId: uuid, servicioId: uuid, fecha }).parse(req.query);
    const hc = await horasConCupos(q.sedeId, q.servicioId, q.fecha);
    // horas como siempre; cupos (13-nov-2026) = cuántos pacientes caben a la vez en cada hora (no ofrecer una hora a más personas).
    res.json({ fecha: q.fecha, horas: hc.map((h) => h.hora), cupos: Object.fromEntries(hc.map((h) => [h.hora, h.cupos])) });
  });

  router.post('/', limiteReservas, async (req, res) => {
    const { aceptaDatos: _acepta, referencia, sedeId, servicioId, subcategoriaId, fecha: f, horaInicio, ...paciente } = crearSchema.parse(req.body);
    void _acepta;
    const refHeader = req.header('Idempotency-Key')?.trim();
    const r = await reservar(
      { ...normalizarPaciente(paciente), sedeId, servicioId, subcategoriaId, fecha: f, horaInicio },
      { canal, conLlave: true, referencia: referencia ?? (refHeader && refHeader.length >= 6 ? refHeader.slice(0, 100) : null), ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined },
    );
    const { token: _token, ...publico } = r;
    res.status(r.repetida ? 200 : 201).json(publico);
  });

  // ─── Mis citas, cancelar y reprogramar (16-nov-2026). Reglas en services/reservaWeb/gestion.ts ───────────────────
  router.get('/citas-paciente', limiteBusqueda, async (req, res) => {
    res.json({ citas: await citasProximas(zDocumento.parse(req.query)) });
  });

  // ─── Rutas AGRUPADAS para el agente de GHL (16-nov-2026) — solo la API de WhatsApp ───────────────────────────────
  // GHL deja 5 acciones «Llamada a API» por agente: con estas dos (más POST /) Ana usa 3. Hacen lo mismo que las rutas sueltas
  // (mismas funciones, reglas y límites); las sueltas siguen funcionando. Van ANTES de GET /:codigo.
  if (canal === 'whatsapp') {
    const consultaSchema = z.discriminatedUnion('que', [
      z.object({ que: z.literal('catalogo') }),
      z.object({ que: z.literal('dias'), sedeId: uuid, servicioId: uuid, desde: fecha, hasta: fecha }),
      z.object({ que: z.literal('horas'), sedeId: uuid, servicioId: uuid, fecha }),
      z.object({ que: z.literal('reserva'), codigo: z.string().trim().min(6).max(40) }),
      z.object({ que: z.literal('citas'), numeroDocumento: z.string(), tipoDocumento: z.enum(TIPOS_DOCUMENTO_RESERVA).optional().nullable() }),
    ], { errorMap: () => ({ message: 'Indica qué consultar: que=catalogo, dias, horas, reserva o citas' }) });
    // «Mis citas» busca por documento: lleva el límite corto de búsquedas (como la ruta suelta).
    const limiteSiBuscaCitas = (req: Request, res: Response, next: NextFunction) => (req.query.que === 'citas' ? limiteBusqueda(req, res, next) : next());

    router.get('/consultar', limiteSiBuscaCitas, limiteConsultas, async (req, res) => {
      const q = consultaSchema.parse(req.query);
      switch (q.que) {
        case 'catalogo': res.json(await catalogo()); return;
        case 'dias': res.json({ dias: await diasDisponibles(q.sedeId, q.servicioId, q.desde, q.hasta) }); return;
        case 'horas': {
          const hc = await horasConCupos(q.sedeId, q.servicioId, q.fecha);
          res.json({ fecha: q.fecha, horas: hc.map((h) => h.hora), cupos: Object.fromEntries(hc.map((h) => [h.hora, h.cupos])) });
          return;
        }
        case 'reserva': res.json(await estadoReservaPorCodigo(q.codigo, canal)); return;
        case 'citas': res.json({ citas: await citasProximas(zDocumento.parse(q)) }); return;
      }
    });

    const codigoCambio = z.string().trim().min(1, 'Indica el código de la cita').max(60);
    const cambioSchema = z.discriminatedUnion('accion', [
      z.object({ accion: z.literal('cancelar'), codigo: codigoCambio, numeroDocumento: z.string(), tipoDocumento: z.enum(TIPOS_DOCUMENTO_RESERVA).optional().nullable(), motivo }),
      z.object({ accion: z.literal('reprogramar'), codigo: codigoCambio, numeroDocumento: z.string(), tipoDocumento: z.enum(TIPOS_DOCUMENTO_RESERVA).optional().nullable(), fecha, horaInicio: hora }),
    ], { errorMap: () => ({ message: 'Indica la acción: accion=cancelar o reprogramar' }) });

    router.post('/cambiar', limiteCambios, async (req, res) => {
      const b = cambioSchema.parse(req.body ?? {});
      const doc = zDocumento.parse(b);
      if (b.accion === 'cancelar') { res.json(await cancelarCitaChat(b.codigo, doc, canal, b.motivo || null, meta(req))); return; }
      res.status(201).json(await reprogramarCitaChat(b.codigo, doc, canal, b.fecha, b.horaInicio, meta(req)));
    });
  }

  router.get('/:codigo', limiteConsultas, async (req, res) => {
    res.json(await estadoReservaPorCodigo(String(req.params.codigo), canal));
  });

  router.post('/:codigo/cancelar', limiteCambios, async (req, res) => {
    const b = zDocumento.and(z.object({ motivo })).parse(req.body ?? {});
    res.json(await cancelarCitaChat(String(req.params.codigo), b, canal, b.motivo || null, meta(req)));
  });

  router.post('/:codigo/reprogramar', limiteCambios, async (req, res) => {
    const b = zDocumento.and(z.object({ fecha, horaInicio: hora })).parse(req.body ?? {});
    res.status(201).json(await reprogramarCitaChat(String(req.params.codigo), b, canal, b.fecha, b.horaInicio, meta(req)));
  });

  return router;
}
