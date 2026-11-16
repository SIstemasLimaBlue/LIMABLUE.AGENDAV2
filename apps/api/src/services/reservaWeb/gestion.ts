/**
 * MIS CITAS, CANCELAR y REPROGRAMAR desde el chat de WhatsApp (Ana) — 16-nov-2026, con las reglas que pidió el equipo del chat.
 * Rutas (routes/reservaChat.ts): GET /citas-paciente, POST /:codigo/cancelar|reprogramar y las agrupadas para GHL GET /consultar y
 * POST /cambiar (solo la API de WhatsApp). La identidad es el DOCUMENTO del paciente (decisión de la clínica).
 * `codigo` = «LB-…» si la cita nació de una reserva en línea (de cualquier canal) o el id de la cita si la registró la clínica.
 *
 * REGLAS (lo que no se puede responde 409 con un código y Ana deriva a un asesor):
 *  - NO_SE_PUEDE_CANCELAR  la cita ya está en curso o atendida (llegó, en atención, completada, no show);
 *  - FUERA_DE_PLAZO        faltan menos de RESERVA_CHAT_CAMBIO_ANTICIPACION_MIN minutos (120 por defecto) o ya pasó;
 *  - ESPERANDO_PAGO        la reserva de fin de semana aún espera su pago previo (se libera sola si no paga);
 *  - REQUIERE_ASESOR       la cita tiene un pago (en línea o en la sede), es de un paquete o de una visita de dos servicios, pide un
 *                          profesional en particular; al reprogramar: a sábado o domingo, un servicio que no se reserva en línea en esa
 *                          sede, o un paciente sin DNI/CE;
 *  - NO_VIGENTE            reprogramar una cita ya cancelada (cancelarla otra vez no es error: «repetida»);
 *  - HORA_NO_DISPONIBLE    la hora nueva no está libre (la cita queda como estaba).
 * Reprogramar MUEVE la misma cita (PATCH /citas/:id/mover): conserva su código, su historial y su recordatorio. Pedirla a la misma
 * fecha y hora que ya tiene no es error (reintento): responde como hecha, con `repetida: true`.
 * Cancelar y mover pasan por los MISMOS endpoints de la Agenda (PATCH /citas/:id/estado y /mover) con la llave interna, así que valen
 * todas sus reglas (estados, choques de horario, turnos, bloqueos), la auditoría (`chat_cita_cancelada` / `chat_cita_reprogramada`),
 * el tiempo real y los recordatorios.
 */
import { prisma } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { registrarAudit } from '../audit';
import { seleccionarProfesionalOptimo } from '../disponibilidad';
import { fechaAStr, fechaDb, hoyLimaStr } from '../../utils/fechaLima';
import { timeToMinutes } from '@limablue/shared';
import { horasLibres, limpiarCacheDias, llamarAgenda, minutosAhoraLima, servicioReservable, PASARELA_WOO } from './reservaWebService';
import { esFinDeSemana } from './woocommerce';
import { normalizarDocumento } from './validaciones';

const MODIFICABLES = ['agendada', 'confirmada'];
const EN_CURSO_O_ATENDIDA = ['llego', 'en_atencion', 'completada', 'no_show'];
/** Anticipación mínima para cancelar o reprogramar por el chat (minutos). */
const ANTICIPACION_CAMBIO_MIN = () => {
  const v = Number(process.env.RESERVA_CHAT_CAMBIO_ANTICIPACION_MIN);
  return Number.isFinite(v) && v >= 0 ? v : 120;
};
const SELECT_CITA = {
  id: true, estado: true, deletedAt: true, fecha: true, horaInicio: true, duracionMinutos: true,
  sedeId: true, unidadNegocioId: true, servicioId: true, subcategoriaId: true, profesionalId: true, pacienteId: true,
  estadoPago: true, pagada: true, paquetePacienteId: true, slotGrupoId: true, solicitadoProfesionalId: true,
  paciente: { select: { tipoDocumento: true } },
} as const;

export interface Meta { ip?: string; userAgent?: string }
interface CitaG {
  id: string; estado: string; deletedAt: Date | null; fecha: Date; horaInicio: string; duracionMinutos: number;
  sedeId: string; unidadNegocioId: string; servicioId: string; subcategoriaId: string | null; profesionalId: string | null; pacienteId: string;
  estadoPago: string; pagada: boolean; paquetePacienteId: string | null; slotGrupoId: string | null; solicitadoProfesionalId: string | null;
  paciente?: { tipoDocumento: string } | null;
}
/** Lo que importa de las reservas de una cita para las reglas. */
interface ReservaR { pagoEstado: string | null; pasarela: string | null; estado: string }

function yaPaso(fecha: string, hora: string) {
  const hoy = hoyLimaStr();
  return fecha < hoy || (fecha === hoy && timeToMinutes(hora) <= minutosAhoraLima());
}

const asesor = (mensaje: string) => ({ codigo: 'REQUIERE_ASESOR', mensaje });

/**
 * ¿Se puede cambiar (cancelar o reprogramar) esta cita por el chat? Puro: recibe la cita y sus reservas.
 * `yaCancelada` = ya no está vigente; `bloqueo` = por qué no (código del 409 y mensaje para el paciente).
 */
export function evaluarCambio(cita: CitaG, reservas: ReservaR[]): { yaCancelada: boolean; bloqueo: { codigo: string; mensaje: string } | null } {
  if (cita.deletedAt || cita.estado === 'cancelada' || cita.estado === 'reprogramada') return { yaCancelada: true, bloqueo: null };
  const no = (b: { codigo: string; mensaje: string }) => ({ yaCancelada: false, bloqueo: b });
  if (EN_CURSO_O_ATENDIDA.includes(cita.estado) || !MODIFICABLES.includes(cita.estado)) {
    return no({ codigo: 'NO_SE_PUEDE_CANCELAR', mensaje: 'La cita ya está en curso o fue atendida.' });
  }
  if (reservas.some((r) => r.pasarela === PASARELA_WOO && r.estado === 'esperando_pago')) {
    return no({ codigo: 'ESPERANDO_PAGO', mensaje: 'La cita está esperando el pago: se libera sola si no se paga a tiempo.' });
  }
  if (reservas.some((r) => r.pagoEstado === 'aprobado') || cita.pagada || cita.estadoPago !== 'pendiente') {
    return no(asesor('La cita ya tiene un pago: lo resuelve un asesor.'));
  }
  if (cita.paquetePacienteId || cita.slotGrupoId) return no(asesor('La cita es parte de un paquete o de una visita de dos servicios: lo resuelve un asesor.'));
  if (cita.solicitadoProfesionalId) return no(asesor('La cita pide un profesional en particular: lo resuelve un asesor.'));
  const f = fechaAStr(cita.fecha), hoy = hoyLimaStr();
  if (f < hoy || (f === hoy && timeToMinutes(cita.horaInicio) - minutosAhoraLima() < ANTICIPACION_CAMBIO_MIN())) {
    return no({ codigo: 'FUERA_DE_PLAZO', mensaje: `Ya no hay tiempo para cambiarla desde el chat (se pide con al menos ${Math.round(ANTICIPACION_CAMBIO_MIN() / 60 * 10) / 10} horas de anticipación).` });
  }
  return { yaCancelada: false, bloqueo: null };
}

async function reservasDe(citaId: string): Promise<ReservaR[]> {
  return prisma.reservaWeb.findMany({ where: { citaId }, select: { pagoEstado: true, pasarela: true, estado: true } });
}

/** Respuesta de la Agenda → error con su mismo código y mensaje (en español). Llave mal configurada o 5xx: error del servidor. */
async function exigirOk(resp: Response, ref: string, que: string) {
  if (resp.ok) return;
  const c = await resp.json().catch(() => ({})) as { error?: string; message?: string };
  console.error(`[reserva-chat] ${ref}: la Agenda no pudo ${que} (HTTP ${resp.status}): ${c.message || c.error || ''}`);
  if (resp.status === 401 || resp.status === 403) throw new AppError('La gestión de citas no está disponible por el momento', 503, 'RESERVA_NO_CONFIGURADA');
  if (resp.status >= 500) throw new AppError('El sistema no pudo registrar el cambio en este momento. Intenta de nuevo.', 502, 'AGENDA_ERROR');
  throw new AppError(c.message || 'No se pudo hacer el cambio', resp.status === 404 ? 409 : resp.status, c.error || 'AGENDA_RECHAZO');
}

/** Cancela con PATCH /citas/:id/estado. Devuelve false si ya estaba cancelada (reintento: no es error). */
async function cancelar(cita: CitaG, o: { motivoCita: string; ref: string; despues: Record<string, unknown>; meta: Meta }) {
  const ev = evaluarCambio(cita, await reservasDe(cita.id));
  if (ev.yaCancelada) return false;
  if (ev.bloqueo) throw new AppError(ev.bloqueo.mensaje, 409, ev.bloqueo.codigo);
  await exigirOk(await llamarAgenda('PATCH', `/citas/${cita.id}/estado`, { estado: 'cancelada', motivoCancelacion: o.motivoCita }), o.ref, 'cancelar la cita');
  limpiarCacheDias();
  void registrarAudit({
    citaId: cita.id, accion: 'chat_cita_cancelada', entidad: 'cita', entidadId: cita.id, sedeId: cita.sedeId, ip: o.meta.ip, userAgent: o.meta.userAgent,
    antes: { estado: cita.estado, fecha: fechaAStr(cita.fecha), horaInicio: cita.horaInicio },
    despues: { ...o.despues, estado: 'cancelada' },
  });
  return true;
}

/** Reglas propias de REPROGRAMAR (además de evaluarCambio): a dónde y qué se puede mover por el chat. */
async function exigirReprogramable(cita: CitaG, fecha: string) {
  if (esFinDeSemana(fecha)) throw new AppError('Las citas de sábado y domingo requieren pago previo: lo coordina un asesor.', 409, 'REQUIERE_ASESOR');
  const tipo = cita.paciente?.tipoDocumento;
  if (tipo && tipo !== 'DNI' && tipo !== 'CE') throw new AppError('El documento del paciente no permite reservar en línea: lo resuelve un asesor.', 409, 'REQUIERE_ASESOR');
  try {
    await servicioReservable(cita.sedeId, cita.servicioId, cita.subcategoriaId);
  } catch (e) {
    if (e instanceof AppError && ['SERVICIO_NO_RESERVABLE', 'VARIANTE_REQUERIDA'].includes(e.code ?? '')) {
      throw new AppError('Este servicio no se reprograma por el chat: lo resuelve un asesor.', 409, 'REQUIERE_ASESOR');
    }
    throw e;
  }
}

/** Mueve con PATCH /citas/:id/mover. Devuelve false si ya estaba en ese horario (reintento). */
async function mover(cita: CitaG, fecha: string, horaInicio: string, o: { ref: string; despues: Record<string, unknown>; meta: Meta }) {
  const ev = evaluarCambio(cita, await reservasDe(cita.id));
  if (ev.yaCancelada) throw new AppError('Esa cita ya no está vigente.', 409, 'NO_VIGENTE');
  const fechaActual = fechaAStr(cita.fecha);
  if (fechaActual === fecha && cita.horaInicio === horaInicio) return false;
  if (ev.bloqueo) throw new AppError(ev.bloqueo.mensaje, 409, ev.bloqueo.codigo);
  await exigirReprogramable(cita, fecha);

  // La hora tiene que ser una de las que ofrece GET /horas. Excepción: el mismo día, a una hora que se cruza con la propia
  // cita (p. ej. 30 min después): /horas la ve «ocupada» por ella misma; ahí decide la Agenda al mover.
  const libres = await horasLibres(cita.sedeId, cita.servicioId, fecha);
  const ini = timeToMinutes(horaInicio), actual = timeToMinutes(cita.horaInicio);
  const seCruzaConsigo = fechaActual === fecha && ini < actual + cita.duracionMinutos && actual < ini + cita.duracionMinutos;
  if (!libres.includes(horaInicio) && !seCruzaConsigo) throw new AppError('Esa hora no está disponible. Elige otra de GET /horas.', 409, 'HORA_NO_DISPONIBLE');

  // Especialista: se queda el mismo si está libre a esa hora; si no, la Agenda elige a otro libre (como al reservar).
  const profesionalId = (await seleccionarProfesionalOptimo(cita.sedeId, cita.unidadNegocioId, cita.servicioId, fecha, horaInicio, cita.profesionalId)) ?? cita.profesionalId;
  await exigirOk(await llamarAgenda('PATCH', `/citas/${cita.id}/mover`, { fecha, horaInicio, profesionalId }), o.ref, 'mover la cita');
  limpiarCacheDias();
  void registrarAudit({
    citaId: cita.id, accion: 'chat_cita_reprogramada', entidad: 'cita', entidadId: cita.id, sedeId: cita.sedeId, ip: o.meta.ip, userAgent: o.meta.userAgent,
    antes: { fecha: fechaActual, horaInicio: cita.horaInicio, profesionalId: cita.profesionalId },
    despues: { ...o.despues, fecha, horaInicio, profesionalId },
  });
  return true;
}

// ─── Por el PACIENTE (documento + código LB-… o id de la cita) ───────────────
/** Documento del paciente; el tipo es opcional (el chat manda solo el número: sin tipo se busca por número). */
export interface DocumentoPaciente { tipoDocumento?: string | null; numeroDocumento: string }

async function pacienteDe(d: DocumentoPaciente) {
  return prisma.paciente.findFirst({
    where: { ...(d.tipoDocumento ? { tipoDocumento: d.tipoDocumento as never } : {}), numeroDocumento: normalizarDocumento(d.numeroDocumento), deletedAt: null },
    select: { id: true },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODIGO_RESERVA = /^LB-\d{6}$/i;

/** La cita a la que apunta `ref`: su id (uuid) o el código de su reserva («LB-123456», de cualquier canal). */
async function citaPorReferencia(ref: string) {
  const t = ref.trim();
  if (UUID.test(t)) return prisma.cita.findUnique({ where: { id: t }, select: SELECT_CITA });
  if (CODIGO_RESERVA.test(t)) {
    const r = await prisma.reservaWeb.findFirst({ where: { codigo: t.toUpperCase() }, select: { citaId: true } });
    return r?.citaId ? prisma.cita.findUnique({ where: { id: r.citaId }, select: SELECT_CITA }) : null;
  }
  return null;
}

/** Ficha de una cita para el chat (sin datos del paciente ni del profesional), con lo que se puede hacer por aquí. */
async function fichas(citas: CitaG[]) {
  if (!citas.length) return [];
  const ids = citas.map((c) => c.id);
  const [extra, reservas] = await Promise.all([
    prisma.cita.findMany({
      where: { id: { in: ids } },
      select: { id: true, sede: { select: { nombre: true, direccion: true } }, servicio: { select: { nombre: true } }, subcategoria: { select: { nombre: true } } },
    }),
    prisma.reservaWeb.findMany({ where: { citaId: { in: ids } }, select: { citaId: true, codigo: true, pagoEstado: true, pasarela: true, estado: true } }),
  ]);
  const ex = new Map(extra.map((e) => [e.id, e]));
  return citas.map((c) => {
    const e = ex.get(c.id);
    const rs = reservas.filter((r) => r.citaId === c.id);
    const ev = evaluarCambio(c, rs);
    return {
      /** Para usar en /:codigo/cancelar|reprogramar o /cambiar: el «LB-…» de su reserva o, si la registró la clínica, el id de la cita. */
      codigo: rs[0]?.codigo ?? c.id,
      fecha: fechaAStr(c.fecha), horaInicio: c.horaInicio, duracionMinutos: c.duracionMinutos,
      sede: e?.sede ?? null, servicio: e?.servicio.nombre ?? null, variante: e?.subcategoria?.nombre ?? null,
      estadoCita: c.estado,
      /** false → `motivo` (código de la tabla de reglas) y Ana deriva a un asesor. Reprogramar a sábado o domingo tampoco se puede. */
      puedeCambiar: !ev.yaCancelada && !ev.bloqueo,
      ...(ev.bloqueo ? { motivo: ev.bloqueo.codigo } : {}),
    };
  });
}

/** Citas PRÓXIMAS «Agendada» o «Confirmada» del paciente (todas, también las de recepción). Documento desconocido = lista vacía. */
export async function citasProximas(d: DocumentoPaciente) {
  const paciente = await pacienteDe(d);
  if (!paciente) return [];
  const citas = await prisma.cita.findMany({
    where: { pacienteId: paciente.id, deletedAt: null, estado: { in: MODIFICABLES as never }, fecha: { gte: fechaDb(hoyLimaStr()) } },
    select: SELECT_CITA, orderBy: [{ fecha: 'asc' }, { horaInicio: 'asc' }], take: 50,
  });
  return fichas(citas.filter((c) => !yaPaso(fechaAStr(c.fecha), c.horaInicio)));
}

/** La cita (id o «LB-…»), solo si es de ese paciente (si no, 404 igual que si no existiera). */
async function citaDelPaciente(ref: string, d: DocumentoPaciente) {
  const [cita, paciente] = await Promise.all([citaPorReferencia(ref), pacienteDe(d)]);
  if (!cita || !paciente || cita.pacienteId !== paciente.id) throw new AppError('Reserva no encontrada', 404, 'RESERVA_NO_ENCONTRADA');
  return cita;
}

/** Cancelar → `{ codigo, estado: "cancelada", repetida }`. */
export async function cancelarCitaChat(codigo: string, d: DocumentoPaciente, canal: string, motivo: string | null, meta: Meta = {}) {
  const cita = await citaDelPaciente(codigo, d);
  const hecho = await cancelar(cita, {
    motivoCita: `Cancelada por el paciente vía ${canal}${motivo ? `: ${motivo}` : ''}`,
    ref: codigo, meta, despues: { codigo, canal, motivo },
  });
  return { codigo, estado: 'cancelada', repetida: !hecho };
}

/**
 * Reprogramar → los campos de la respuesta de POST / más `codigoAnterior`. La cita se MUEVE (no se crea otra), así que
 * `codigo` y `codigoAnterior` son el mismo.
 */
export async function reprogramarCitaChat(codigo: string, d: DocumentoPaciente, canal: string, fecha: string, horaInicio: string, meta: Meta = {}) {
  const cita = await citaDelPaciente(codigo, d);
  const hecho = await mover(cita, fecha, horaInicio, { ref: codigo, meta, despues: { codigo, canal } });
  const [c, reserva] = await Promise.all([
    prisma.cita.findUnique({
      where: { id: cita.id },
      select: { fecha: true, horaInicio: true, duracionMinutos: true, montoFinal: true, precioLista: true, sede: { select: { nombre: true, direccion: true } }, servicio: { select: { nombre: true } }, subcategoria: { select: { nombre: true } } },
    }),
    prisma.reservaWeb.findFirst({ where: { citaId: cita.id }, select: { monto: true, moneda: true } }),
  ]);
  return {
    codigo, estado: 'confirmada', citaId: cita.id, repetida: !hecho, codigoAnterior: codigo,
    fecha: c ? fechaAStr(c.fecha) : fecha, horaInicio: c?.horaInicio ?? horaInicio, duracionMinutos: c?.duracionMinutos ?? cita.duracionMinutos,
    monto: Number(reserva?.monto ?? c?.montoFinal ?? c?.precioLista ?? 0), moneda: reserva?.moneda ?? 'PEN',
    sede: c?.sede ?? null, servicio: c?.servicio?.nombre ?? '', variante: c?.subcategoria?.nombre ?? null,
  };
}
