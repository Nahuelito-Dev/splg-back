import { MensajeDeCorreo } from '../../email/layout/correo';

/** La propuesta de ventana de taller que recibe el chofer (CU-105), ya en texto. */
export interface PropuestaDeTallerDelCorreo {
  patente: string;
  tarea: string;
  /** Inicio de la ventana propuesta, con fecha y hora. */
  cuando: string;
  /** Hasta cuándo puede responder. */
  responderAntes: string;
}

export function mensajeDePropuestaDeTaller(
  p: PropuestaDeTallerDelCorreo,
  distribuidora: string,
): MensajeDeCorreo {
  return {
    asunto: `Turno de taller para ${p.patente}`,
    preheader: `${p.tarea}: ${p.cuando}. Respondé desde la app antes de ${p.responderAntes}.`,
    etiqueta: 'Taller',
    titulo: `Turno de taller para ${p.patente}`,
    bloques: [
      {
        tipo: 'datos',
        filas: [
          { etiqueta: 'Vehículo', valor: p.patente, mono: true },
          { etiqueta: 'Tarea', valor: p.tarea },
          { etiqueta: 'Cuándo', valor: p.cuando },
        ],
      },
      {
        tipo: 'parrafo',
        texto: [
          'Respondé desde la app del chofer antes de ',
          { fuerte: p.responderAntes },
          '; si no podés, rechazala o proponé otro horario.',
        ],
      },
    ],
    motivo: `Recibís este aviso porque manejás para ${distribuidora}.`,
  };
}
