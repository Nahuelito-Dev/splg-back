/**
 * Freno para los errores que los procesos atrapan y siguen: un proceso que
 * corre cada 15 segundos y falla igual cada vez mandaría cientos de eventos
 * por hora. El mismo error (proceso + mensaje normalizado) pasa como mucho una
 * vez por ventana, por instancia, en memoria.
 */

/** Ventana del freno: 10 minutos. */
export const VENTANA_DEL_FRENO_MS = 10 * 60 * 1000;

/** Claves recordadas antes de limpiar las vencidas. */
const CLAVES_ANTES_DE_LIMPIAR = 500;

const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const NUMERO = /\d+/g;

/**
 * El mensaje sin lo que cambia de una vez a otra (ids, números), para que el
 * mismo error con otro pedido cuente como el mismo.
 */
export function mensajeNormalizado(mensaje: string): string {
  return mensaje.replace(UUID, '<id>').replace(NUMERO, '<n>').slice(0, 300);
}

export class FrenoDeErrores {
  private readonly ultimos = new Map<string, number>();

  constructor(private readonly ventanaMs = VENTANA_DEL_FRENO_MS) {}

  /** Si este error puede salir ahora; si sale, abre su ventana. */
  pasa(proceso: string | null, mensaje: string, ahora = Date.now()): boolean {
    const clave = `${proceso ?? '-'}|${mensajeNormalizado(mensaje)}`;
    const ultimo = this.ultimos.get(clave);
    if (ultimo !== undefined && ahora - ultimo < this.ventanaMs) return false;
    if (this.ultimos.size >= CLAVES_ANTES_DE_LIMPIAR) this.limpiar(ahora);
    this.ultimos.set(clave, ahora);
    return true;
  }

  private limpiar(ahora: number): void {
    for (const [clave, cuando] of this.ultimos) {
      if (ahora - cuando >= this.ventanaMs) this.ultimos.delete(clave);
    }
  }
}
