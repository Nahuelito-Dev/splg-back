import { MensajeDeCorreo } from '../email/layout/correo';

/** CU-195: la última carga de combustible se aparta del consumo habitual. */
export function mensajeDeCargaAnomala(
  patente: string,
  fuelLoadId: string,
): MensajeDeCorreo {
  return {
    asunto: `Consumo de combustible anómalo: ${patente}`,
    preheader: `La última carga del vehículo ${patente} se aparta más de un 25 % del consumo habitual.`,
    etiqueta: 'Aviso de flota',
    titulo: 'Consumo de combustible anómalo',
    bloques: [
      {
        tipo: 'parrafo',
        texto: [
          'La última carga de combustible del vehículo ',
          { fuerte: patente },
          ' tiene un consumo que se aparta más de un 25 % del habitual. Revisala en el panel de flota.',
        ],
      },
      {
        tipo: 'datos',
        filas: [
          { etiqueta: 'Vehículo', valor: patente, mono: true },
          { etiqueta: 'Carga', valor: fuelLoadId, mono: true },
        ],
      },
    ],
  };
}

/** CU-201: siniestro con fuga o derrame de gas. */
export function mensajeDeDerrame(
  patente: string,
  accidentId: string,
): MensajeDeCorreo {
  return {
    asunto: `URGENTE: derrame de gas en un siniestro (${patente})`,
    preheader: `Siniestro con fuga o derrame de gas del vehículo ${patente}: revisalo ahora.`,
    etiqueta: 'Urgente',
    titulo: 'Derrame de gas en un siniestro',
    bloques: [
      {
        tipo: 'nota',
        tono: 'peligro',
        titulo: 'Incidente de seguridad',
        texto: [
          'Se registró un siniestro con fuga o derrame de gas del vehículo ',
          { fuerte: patente },
          '. Es un incidente de seguridad: revisalo ahora en el panel de flota.',
        ],
      },
      {
        tipo: 'datos',
        filas: [
          { etiqueta: 'Vehículo', valor: patente, mono: true },
          { etiqueta: 'Siniestro', valor: accidentId, mono: true },
        ],
      },
    ],
  };
}

/** El vehículo quedó fuera de servicio por un siniestro, pero sigue asignado a su chofer. */
export function mensajeDeAsignacionPendiente(
  patente: string,
  accidentId: string,
  motivo: string,
): MensajeDeCorreo {
  return {
    asunto: `Vehículo fuera de servicio con el chofer en entrega (${patente})`,
    preheader: `El vehículo ${patente} quedó fuera de servicio por un siniestro, pero sigue asignado a su chofer.`,
    etiqueta: 'Aviso de flota',
    titulo: 'Vehículo fuera de servicio con el chofer en entrega',
    bloques: [
      {
        tipo: 'nota',
        tono: 'aviso',
        texto: [
          'El vehículo ',
          { fuerte: patente },
          ` quedó fuera de servicio por un siniestro, pero sigue asignado a su chofer: ${motivo}.`,
        ],
      },
      {
        tipo: 'datos',
        filas: [
          { etiqueta: 'Vehículo', valor: patente, mono: true },
          { etiqueta: 'Siniestro', valor: accidentId, mono: true },
        ],
      },
    ],
  };
}
