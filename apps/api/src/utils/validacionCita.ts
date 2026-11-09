/** Validaciones de entrada de una cita (formato de fecha y hora). */
import { z } from 'zod';

export const REJILLA_MINUTOS = 30;
export const MESES_MAX_ADELANTE = 12;

/** «YYYY-MM-DD» que existe en el calendario (rechaza 2026-13-01 y 2026-02-30). */
export function esFechaReal(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** «HH:mm» válida (00:00 a 23:59), en cualquier minuto. */
export function horaEnRejilla(h: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(h);
}

export const zFechaCita = z.string().refine(esFechaReal, { message: 'La fecha no existe en el calendario (formato AAAA-MM-DD)' });
export const zHoraCita = z.string().refine(horaEnRejilla, { message: 'La hora debe tener formato HH:mm' });
export const zComentarioCita = z.string();
