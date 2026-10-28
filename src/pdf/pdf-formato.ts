import { ZONA_ARGENTINA } from '../common/utils/dias-argentina';

const MONEDA = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const NUMERO = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });

const FECHA = new Intl.DateTimeFormat('es-AR', {
  timeZone: ZONA_ARGENTINA,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const FECHA_HORA = new Intl.DateTimeFormat('es-AR', {
  timeZone: ZONA_ARGENTINA,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Importe en pesos: `$ 1.234,50`. */
export function pesos(valor: number): string {
  return MONEDA.format(valor).replace(/\p{Zs}/gu, ' ');
}

export function numero(valor: number): string {
  return NUMERO.format(valor);
}

/** Día en hora argentina: `27/10/2026`. */
export function fecha(valor: Date | string | null | undefined): string {
  if (!valor) return '-';
  return FECHA.format(new Date(valor));
}

/** Día y hora en hora argentina: `27/10/2026 21:43`. */
export function fechaHora(valor: Date | string | null | undefined): string {
  if (!valor) return '-';
  return FECHA_HORA.format(new Date(valor)).replace(',', '');
}

/** `2026-10-27` (día calendario guardado como texto) a `27/10/2026`. */
export function diaCalendario(dia: string): string {
  const [anio, mes, d] = dia.split('-');
  return anio && mes && d ? `${d}/${mes}/${anio}` : dia;
}

/** Número de documento con ceros: `N° 0012`. */
export function numeroDeDocumento(n: number): string {
  return `N° ${String(n).padStart(4, '0')}`;
}

/** Los 8 primeros caracteres del UUID, en mayúsculas: el pedido no tiene número correlativo. */
export function codigoCorto(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 8).toUpperCase();
}

/** Los caracteres de Windows-1252 fuera de Latin-1 que también tiene WinAnsi. */
const EXTRAS_WINANSI = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
/** Letras que no se descomponen en letra + signo. */
const SIN_SIGNO: Record<string, string> = {
  Ł: 'L',
  ł: 'l',
  Đ: 'D',
  đ: 'd',
  Ħ: 'H',
  ħ: 'h',
  ı: 'i',
};

const enWinAnsi = (c: string): boolean => {
  const codigo = c.codePointAt(0) ?? 0;
  return (
    c === '\n' ||
    (codigo >= 0x20 && codigo <= 0x7e) ||
    (codigo >= 0xa0 && codigo <= 0xff) ||
    EXTRAS_WINANSI.has(c)
  );
};

/**
 * Las fuentes estándar del PDF (Helvetica) sólo tienen WinAnsi: el resto sale como basura.
 * Se le quita el signo a lo que se puede (Łódź → Lodz) y lo demás (emojis, otros alfabetos)
 * queda como «?».
 */
export function aWinAnsi(texto: string): string {
  let salida = '';
  const limpio = texto
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // Signos sueltos, selectores de variante y uniones de emojis: no se ven, se descartan.
    .normalize('NFC')
    .replace(/[\p{M}\uFE00-\uFE0F\u200D]/gu, '');
  for (const c of limpio) {
    if (enWinAnsi(c)) {
      salida += c;
      continue;
    }
    const base = SIN_SIGNO[c] ?? c.normalize('NFD').replace(/\p{M}/gu, '');
    salida += [...base].every(enWinAnsi) && base ? base : '?';
  }
  return salida;
}

/** Texto apto para el PDF y con un largo tope: un valor enorme no puede desarmar la página. */
export function acotar(texto: string, maximo: number): string {
  const limpio = aWinAnsi(texto);
  return limpio.length > maximo
    ? `${limpio.slice(0, maximo - 1).trimEnd()}…`
    : limpio;
}
