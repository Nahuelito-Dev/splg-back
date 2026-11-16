import { BloqueDeCorreo, MensajeDeCorreo } from '../email/layout/correo';

/** Un vencimiento de flota o del personal, ya en texto. */
export interface VencimientoDelCorreo {
  /** Qué vence (el plan: VTV, seguro, examen…). */
  que: string;
  /** De quién: «Vehículo AB123CD», «Empleado Ana Pérez», «Chofer …». */
  sujeto: string;
  /** Fecha de vencimiento, ya formateada. */
  vence: string;
}

/** Un chofer activo al que le falta documentación que bloquea el despacho. */
export interface FaltanteDelCorreo {
  chofer: string;
  /** Los documentos que faltan. */
  faltan: readonly string[];
}

/** Asunto del aviso diario de vencimientos (CU-142 y CU-188). */
export function asuntoDeVencimientos(
  vencimientos: number,
  faltantes: number,
): string {
  const partes: string[] = [];
  if (vencimientos > 0) partes.push(`${vencimientos} pendiente(s)`);
  if (faltantes > 0) {
    partes.push(`${faltantes} chofer(es) con documentos sin cargar`);
  }
  return `Vencimientos de flota y personal: ${partes.join(', ')}`;
}

/** El aviso diario de vencimientos de flota y personal, con los documentos que les faltan a los choferes. */
export function mensajeDeVencimientos(
  vencimientos: readonly VencimientoDelCorreo[],
  faltantes: readonly FaltanteDelCorreo[],
): MensajeDeCorreo {
  const bloques: BloqueDeCorreo[] = [];
  if (vencimientos.length > 0) {
    bloques.push(
      {
        tipo: 'parrafo',
        texto: 'Estos vencimientos necesitan atención:',
      },
      {
        tipo: 'tabla',
        columnas: [
          { titulo: 'Qué vence' },
          { titulo: 'De quién' },
          { titulo: 'Vence', alinear: 'derecha', mono: true },
        ],
        filas: vencimientos.map((v) => [v.que, v.sujeto, v.vence]),
      },
    );
  }
  if (faltantes.length > 0) {
    bloques.push(
      {
        tipo: 'nota',
        tono: 'aviso',
        texto:
          'Estos choferes no tienen cargada documentación que bloquea el despacho:',
      },
      {
        tipo: 'tabla',
        columnas: [{ titulo: 'Chofer' }, { titulo: 'Falta' }],
        filas: faltantes.map((f) => [f.chofer, f.faltan.join(', ')]),
      },
    );
  }
  const asunto = asuntoDeVencimientos(vencimientos.length, faltantes.length);
  return {
    asunto,
    preheader: asunto.replace('Vencimientos de flota y personal: ', '') + '.',
    etiqueta: 'Vencimientos',
    titulo: 'Vencimientos de flota y personal',
    bloques,
  };
}
