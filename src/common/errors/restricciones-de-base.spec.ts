import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  MENSAJES_DE_RESTRICCIONES,
  mensajeDeRestriccion,
} from './restricciones-de-base';

const MIGRACIONES = join(__dirname, '..', '..', 'migrations');
/** Las migraciones de las validaciones en la base (tanda V1). */
const DE_LA_TANDA = (archivo: string): boolean =>
  /^17927\d{8}-/.test(archivo) && archivo.endsWith('.ts');

/** Nombres anteriores que sólo reaparecen al deshacer una migración. */
const REEMPLAZADAS = new Set(['UQ_car_patente_vigente']);

const nombresCreados = (): string[] => {
  const nombres = new Set<string>();
  for (const archivo of readdirSync(MIGRACIONES).filter(DE_LA_TANDA)) {
    const texto = readFileSync(join(MIGRACIONES, archivo), 'utf8');
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

  it('los mensajes no son vacíos', () => {
    for (const [nombre, mensaje] of Object.entries(MENSAJES_DE_RESTRICCIONES)) {
      expect(mensaje.trim().length).toBeGreaterThan(10);
      expect(nombre).toMatch(/^(CHK|UQ|EXC)_/);
    }
  });
});
