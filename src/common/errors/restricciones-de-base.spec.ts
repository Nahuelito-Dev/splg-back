import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  MAQUINAS_DE_ESTADO,
  nombreDeLaRestriccionDeTransicion,
} from '../../migrations/sql/transiciones-de-estado';
import {
  esConflictoDeEstado,
  MENSAJES_DE_RESTRICCIONES,
  mensajeDeRestriccion,
} from './restricciones-de-base';

const MIGRACIONES = join(__dirname, '..', '..', 'migrations');
/** Las migraciones de las validaciones en la base (tanda V1). */
const DE_LA_TANDA = (archivo: string): boolean =>
  /^17927\d{8}-/.test(archivo) && archivo.endsWith('.ts');

/** Nombres anteriores que sólo reaparecen al deshacer una migración. */
const REEMPLAZADAS = new Set(['UQ_car_patente_vigente']);

const SQL_DE_LAS_MIGRACIONES = join(MIGRACIONES, 'sql');
const esCodigo = (archivo: string): boolean =>
  archivo.endsWith('.ts') && !archivo.endsWith('.spec.ts');

const nombresCreados = (): string[] => {
  const nombres = new Set<string>();
  // Las migraciones y el SQL que comparten con el arranque de las pruebas.
  const archivos = [
    ...readdirSync(MIGRACIONES)
      .filter(DE_LA_TANDA)
      .map((a) => join(MIGRACIONES, a)),
    ...readdirSync(SQL_DE_LAS_MIGRACIONES)
      .filter(esCodigo)
      .map((a) => join(SQL_DE_LAS_MIGRACIONES, a)),
  ];
  for (const archivo of archivos) {
    const texto = readFileSync(archivo, 'utf8');
    for (const m of texto.matchAll(/\b(?:CHK|UQ|EXC)_[A-Za-z0-9_]+/g)) {
      nombres.add(m[0]);
    }
  }
  return [...nombres].filter((n) => !REEMPLAZADAS.has(n));
};

describe('mensajes de las restricciones de la base', () => {
  it('devuelve el mensaje de una restricción conocida y undefined si no', () => {
    expect(mensajeDeRestriccion('CHK_car_patente')).toContain('patente');
    expect(mensajeDeRestriccion('CHK_inventada')).toBeUndefined();
    expect(mensajeDeRestriccion(undefined)).toBeUndefined();
  });

  it('toda restricción que crean las migraciones de la tanda tiene su mensaje en castellano', () => {
    const creadas = nombresCreados();
    expect(creadas.length).toBeGreaterThan(50);
    const sinMensaje = creadas.filter((n) => !(n in MENSAJES_DE_RESTRICCIONES));
    expect(sinMensaje).toEqual([]);
  });

  it('cada trigger de transición de estado tiene su mensaje', () => {
    for (const m of MAQUINAS_DE_ESTADO) {
      expect(MENSAJES_DE_RESTRICCIONES).toHaveProperty(
        nombreDeLaRestriccionDeTransicion(m.tabla),
      );
    }
  });

  it('transiciones y saldos contra el libro son conflictos de estado (409)', () => {
    expect(esConflictoDeEstado('CHK_order_transicion_de_estado')).toBe(true);
    expect(esConflictoDeEstado('CHK_stock_balance_saldo_contra_libro')).toBe(
      true,
    );
    expect(esConflictoDeEstado('CHK_car_patente')).toBe(false);
    expect(esConflictoDeEstado(undefined)).toBe(false);
  });

  it('los mensajes no son vacíos', () => {
    for (const [nombre, mensaje] of Object.entries(MENSAJES_DE_RESTRICCIONES)) {
      expect(mensaje.trim().length).toBeGreaterThan(10);
      expect(nombre).toMatch(/^(CHK|UQ|EXC)_/);
    }
  });
});
