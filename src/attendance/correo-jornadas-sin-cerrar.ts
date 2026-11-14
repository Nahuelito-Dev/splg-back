import { MensajeDeCorreo } from '../email/layout/correo';

/** Una jornada abierta, ya en texto: quién, qué día y a qué hora ingresó. */
export interface JornadaSinCerrar {
  persona: string;
  dia: string;
  ingreso: string;
}

/** El aviso de las 7 (CU-189): jornadas de días anteriores que siguen abiertas. */
export function mensajeDeJornadasSinCerrar(
  jornadas: readonly JornadaSinCerrar[],
): MensajeDeCorreo {
  return {
    asunto: `Jornadas sin cerrar: ${jornadas.length}`,
    preheader: `${jornadas.length} jornada(s) de días anteriores siguen abiertas: corregilas desde la grilla de asistencia.`,
    etiqueta: 'Asistencia',
    titulo: 'Jornadas sin cerrar',
    bloques: [
      {
        tipo: 'parrafo',
        texto:
          'Estas jornadas de días anteriores siguen sin cerrar. Corregilas desde la grilla de asistencia:',
      },
      {
        tipo: 'tabla',
        columnas: [
          { titulo: 'Persona' },
          { titulo: 'Día', mono: true },
          { titulo: 'Ingresó', alinear: 'derecha', mono: true },
        ],
        filas: jornadas.map((j) => [j.persona, j.dia, j.ingreso]),
      },
    ],
  };
}
