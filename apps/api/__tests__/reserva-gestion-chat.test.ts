/**
 * Mis citas, cancelar y reprogramar desde el chat (16-nov-2026, reglas del equipo del chat). La Agenda (PATCH /citas/:id/estado y
 * /mover) está simulada: se comprueba qué se le pide y qué se rechaza antes de llegar a ella.
 */
/** Día HÁBIL (lunes a viernes) a partir de `n` días desde hoy: reprogramar a fin de semana tiene su propia regla. */
function diaHabil(n: number): string {
  const d = new Date(Date.now() + n * 86_400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function proximo(diaSemana: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + ((diaSemana - d.getUTCDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}
const manana = diaHabil(2);
/** El día hábil siguiente a `manana`. */
const pasado = (() => {
  const d = new Date(`${manana}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
})();
const hoyLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const ID_CITA = '11111111-1111-4111-8111-111111111111';
const doc = { numeroDocumento: '12345678' };

const citaBase = {
  id: 'c1', estado: 'agendada', deletedAt: null, fecha: new Date(`${manana}T12:00:00Z`), horaInicio: '10:00', duracionMinutos: 30,
  sedeId: 's1', unidadNegocioId: 'u1', servicioId: 'sv1', subcategoriaId: null, profesionalId: 'p1', pacienteId: 'pac1',
  estadoPago: 'pendiente', pagada: false, paquetePacienteId: null, slotGrupoId: null, solicitadoProfesionalId: null,
  paciente: { tipoDocumento: 'DNI' },
};

const mockPrisma = {
  reservaWeb: { findFirst: jest.fn(), findMany: jest.fn() },
  cita: { findUnique: jest.fn(), findMany: jest.fn() },
  paciente: { findFirst: jest.fn() },
};
jest.mock('../src/db', () => ({ prisma: mockPrisma }));
jest.mock('../src/services/audit', () => ({ registrarAudit: jest.fn().mockResolvedValue(undefined) }));
const mockProfesional = jest.fn();
jest.mock('../src/services/disponibilidad', () => ({ seleccionarProfesionalOptimo: (...a: unknown[]) => mockProfesional(...a) }));
const mockServicio = {
  horasLibres: jest.fn(), limpiarCacheDias: jest.fn(), llamarAgenda: jest.fn(), minutosAhoraLima: () => 12 * 60,
  servicioReservable: jest.fn(), PASARELA_WOO: 'woocommerce',
};
jest.mock('../src/services/reservaWeb/reservaWebService', () => mockServicio);

import { AppError } from '../src/middleware/errorHandler';
import { citasProximas, cancelarCitaChat, reprogramarCitaChat, evaluarCambio } from '../src/services/reservaWeb/gestion';

const respuesta = (status: number, cuerpo: unknown = {}) => ({ ok: status < 300, status, json: async () => cuerpo });
const cita = (extra: Record<string, unknown> = {}) => ({ ...citaBase, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  delete process.env.RESERVA_CHAT_CAMBIO_ANTICIPACION_MIN;
  mockPrisma.reservaWeb.findFirst.mockResolvedValue(null);
  mockPrisma.reservaWeb.findMany.mockResolvedValue([]);
  mockPrisma.cita.findUnique.mockResolvedValue(cita());
  mockPrisma.cita.findMany.mockImplementation(async (q: { select?: { sede?: unknown } }) => (q.select?.sede
    ? [{ id: 'c1', sede: { nombre: 'Los Olivos', direccion: 'Av. 1' }, servicio: { nombre: 'Evaluación' }, subcategoria: null }]
    : [cita()]));
  mockPrisma.paciente.findFirst.mockResolvedValue({ id: 'pac1' });
  mockServicio.horasLibres.mockResolvedValue(['09:00', '15:00']);
  mockServicio.llamarAgenda.mockResolvedValue(respuesta(200));
  mockServicio.servicioReservable.mockResolvedValue({});
  mockProfesional.mockResolvedValue('p2');
});

describe('reglas (evaluarCambio)', () => {
  const ev = (extra: Record<string, unknown> = {}, reservas: Record<string, unknown>[] = []) => evaluarCambio(cita(extra) as never, reservas as never);

  it('cita normal, con tiempo: se puede', () => expect(ev()).toEqual({ yaCancelada: false, bloqueo: null }));
  it('cancelada, reprogramada o borrada: ya no está vigente', () => {
    expect(ev({ estado: 'cancelada' }).yaCancelada).toBe(true);
    expect(ev({ estado: 'reprogramada' }).yaCancelada).toBe(true);
    expect(ev({ deletedAt: new Date() }).yaCancelada).toBe(true);
  });
  it('en curso o atendida → NO_SE_PUEDE_CANCELAR', () => {
    for (const estado of ['llego', 'en_atencion', 'completada', 'no_show']) expect(ev({ estado }).bloqueo?.codigo).toBe('NO_SE_PUEDE_CANCELAR');
  });
  it('esperando el pago previo → ESPERANDO_PAGO', () => {
    expect(ev({}, [{ pasarela: 'woocommerce', estado: 'esperando_pago', pagoEstado: 'pendiente' }]).bloqueo?.codigo).toBe('ESPERANDO_PAGO');
  });
  it('con cualquier pago, de paquete, de visita doble o con profesional pedido → REQUIERE_ASESOR', () => {
    expect(ev({}, [{ pasarela: 'woocommerce', estado: 'confirmada', pagoEstado: 'aprobado' }]).bloqueo?.codigo).toBe('REQUIERE_ASESOR');
    expect(ev({ pagada: true }).bloqueo?.codigo).toBe('REQUIERE_ASESOR');
    expect(ev({ estadoPago: 'incompleto' }).bloqueo?.codigo).toBe('REQUIERE_ASESOR');
    expect(ev({ paquetePacienteId: 'pq' }).bloqueo?.codigo).toBe('REQUIERE_ASESOR');
    expect(ev({ slotGrupoId: 'g' }).bloqueo?.codigo).toBe('REQUIERE_ASESOR');
    expect(ev({ solicitadoProfesionalId: 'pr' }).bloqueo?.codigo).toBe('REQUIERE_ASESOR');
  });
  it('faltan menos de 2 h (o ya pasó) → FUERA_DE_PLAZO; el plazo se puede cambiar', () => {
    const hoy = new Date(`${hoyLima}T12:00:00Z`); // minutosAhoraLima simulado = 12:00
    expect(ev({ fecha: hoy, horaInicio: '13:30' }).bloqueo?.codigo).toBe('FUERA_DE_PLAZO');
    expect(ev({ fecha: hoy, horaInicio: '14:00' }).bloqueo).toBeNull();
    expect(ev({ fecha: new Date('2026-01-05T12:00:00Z') }).bloqueo?.codigo).toBe('FUERA_DE_PLAZO');
    process.env.RESERVA_CHAT_CAMBIO_ANTICIPACION_MIN = '30';
    expect(ev({ fecha: hoy, horaInicio: '13:00' }).bloqueo).toBeNull();
  });
});

describe('mis citas', () => {
  it('lista con codigo (id si la registró la clínica), estadoCita y puedeCambiar; sin datos del paciente', async () => {
    const r = await citasProximas(doc);
    expect(mockPrisma.paciente.findFirst.mock.calls[0][0].where).toMatchObject({ numeroDocumento: '12345678' });
    expect(r).toEqual([expect.objectContaining({ codigo: 'c1', fecha: manana, horaInicio: '10:00', estadoCita: 'agendada', puedeCambiar: true, servicio: 'Evaluación' })]);
    expect(r[0]).not.toHaveProperty('motivo');
    expect(r[0]).not.toHaveProperty('pacienteId');
  });
  it('con reserva: el codigo es su LB; bloqueada → puedeCambiar false y motivo', async () => {
    mockPrisma.reservaWeb.findMany.mockResolvedValue([{ citaId: 'c1', codigo: 'LB-654321', pagoEstado: 'aprobado', pasarela: 'woocommerce', estado: 'confirmada' }]);
    expect((await citasProximas(doc))[0]).toMatchObject({ codigo: 'LB-654321', puedeCambiar: false, motivo: 'REQUIERE_ASESOR' });
  });
  it('documento desconocido → lista vacía', async () => {
    mockPrisma.paciente.findFirst.mockResolvedValue(null);
    expect(await citasProximas(doc)).toEqual([]);
  });
});

describe('cancelar', () => {
  it('por id de la cita → { codigo, estado: "cancelada", repetida } con el endpoint de la Agenda', async () => {
    const r = await cancelarCitaChat(ID_CITA, doc, 'whatsapp', 'Viaje');
    expect(mockServicio.llamarAgenda).toHaveBeenCalledWith('PATCH', '/citas/c1/estado', { estado: 'cancelada', motivoCancelacion: 'Cancelada por el paciente vía whatsapp: Viaje' });
    expect(r).toEqual({ codigo: ID_CITA, estado: 'cancelada', repetida: false });
  });
  it('por LB de cualquier canal, si el documento es del dueño', async () => {
    mockPrisma.reservaWeb.findFirst.mockResolvedValueOnce({ citaId: 'c1' });
    expect(await cancelarCitaChat('LB-654321', doc, 'whatsapp', null)).toMatchObject({ codigo: 'LB-654321', estado: 'cancelada' });
  });
  it('documento de otra persona o código inventado → 404 RESERVA_NO_ENCONTRADA', async () => {
    mockPrisma.cita.findUnique.mockResolvedValue(cita({ pacienteId: 'otro' }));
    await expect(cancelarCitaChat(ID_CITA, doc, 'whatsapp', null)).rejects.toMatchObject({ statusCode: 404, code: 'RESERVA_NO_ENCONTRADA' });
    await expect(cancelarCitaChat('cualquiera', doc, 'whatsapp', null)).rejects.toMatchObject({ statusCode: 404, code: 'RESERVA_NO_ENCONTRADA' });
    expect(mockServicio.llamarAgenda).not.toHaveBeenCalled();
  });
  it('ya cancelada → repetida: true sin tocar nada', async () => {
    mockPrisma.cita.findUnique.mockResolvedValue(cita({ estado: 'cancelada' }));
    expect((await cancelarCitaChat(ID_CITA, doc, 'whatsapp', null)).repetida).toBe(true);
    expect(mockServicio.llamarAgenda).not.toHaveBeenCalled();
  });
  it('una regla lo impide → 409 con su código', async () => {
    mockPrisma.cita.findUnique.mockResolvedValue(cita({ estado: 'llego' }));
    await expect(cancelarCitaChat(ID_CITA, doc, 'whatsapp', null)).rejects.toMatchObject({ statusCode: 409, code: 'NO_SE_PUEDE_CANCELAR' });
  });
  it('la Agenda rechaza → mismo código; 5xx → error del servidor', async () => {
    mockServicio.llamarAgenda.mockResolvedValueOnce(respuesta(400, { error: 'TRANSICION_INVALIDA', message: 'No se puede' }));
    await expect(cancelarCitaChat(ID_CITA, doc, 'whatsapp', null)).rejects.toMatchObject({ statusCode: 400, code: 'TRANSICION_INVALIDA' });
    mockServicio.llamarAgenda.mockResolvedValueOnce(respuesta(500));
    await expect(cancelarCitaChat(ID_CITA, doc, 'whatsapp', null)).rejects.toMatchObject({ statusCode: 502, code: 'AGENDA_ERROR' });
  });
});

describe('reprogramar', () => {
  it('MUEVE la misma cita a una hora ofrecida y responde con codigoAnterior', async () => {
    const r = await reprogramarCitaChat(ID_CITA, doc, 'whatsapp', pasado, '15:00');
    expect(mockProfesional).toHaveBeenCalledWith('s1', 'u1', 'sv1', pasado, '15:00', 'p1');
    expect(mockServicio.llamarAgenda).toHaveBeenCalledWith('PATCH', '/citas/c1/mover', { fecha: pasado, horaInicio: '15:00', profesionalId: 'p2' });
    expect(r).toMatchObject({ codigo: ID_CITA, codigoAnterior: ID_CITA, estado: 'confirmada', citaId: 'c1', repetida: false, moneda: 'PEN' });
  });
  it('misma fecha y hora → repetida (reintento), sin mover', async () => {
    expect((await reprogramarCitaChat(ID_CITA, doc, 'whatsapp', manana, '10:00')).repetida).toBe(true);
    expect(mockServicio.llamarAgenda).not.toHaveBeenCalled();
  });
  it('hora no ofrecida → HORA_NO_DISPONIBLE; cancelada → NO_VIGENTE', async () => {
    await expect(reprogramarCitaChat(ID_CITA, doc, 'whatsapp', pasado, '11:00')).rejects.toMatchObject({ statusCode: 409, code: 'HORA_NO_DISPONIBLE' });
    mockPrisma.cita.findUnique.mockResolvedValue(cita({ estado: 'cancelada' }));
    await expect(reprogramarCitaChat(ID_CITA, doc, 'whatsapp', pasado, '15:00')).rejects.toMatchObject({ statusCode: 409, code: 'NO_VIGENTE' });
  });
  it('a sábado o domingo, servicio no reservable en línea o paciente sin DNI/CE → REQUIERE_ASESOR', async () => {
    await expect(reprogramarCitaChat(ID_CITA, doc, 'whatsapp', proximo(6), '15:00')).rejects.toMatchObject({ code: 'REQUIERE_ASESOR' });
    await expect(reprogramarCitaChat(ID_CITA, doc, 'whatsapp', proximo(0), '15:00')).rejects.toMatchObject({ code: 'REQUIERE_ASESOR' });
    mockServicio.servicioReservable.mockRejectedValueOnce(new AppError('no', 400, 'SERVICIO_NO_RESERVABLE'));
    await expect(reprogramarCitaChat(ID_CITA, doc, 'whatsapp', pasado, '15:00')).rejects.toMatchObject({ code: 'REQUIERE_ASESOR' });
    mockPrisma.cita.findUnique.mockResolvedValue(cita({ paciente: { tipoDocumento: 'PASAPORTE' } }));
    await expect(reprogramarCitaChat(ID_CITA, doc, 'whatsapp', pasado, '15:00')).rejects.toMatchObject({ code: 'REQUIERE_ASESOR' });
    expect(mockServicio.llamarAgenda).not.toHaveBeenCalled();
  });
});
