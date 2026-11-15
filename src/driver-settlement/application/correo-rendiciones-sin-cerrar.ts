import { MensajeDeCorreo } from '../../email/layout/correo';

/** Una rendición de un día anterior que sigue sin cerrarse. */
export interface RendicionSinCerrar {
  numero: number;
  /** Día de la rendición (`AAAA-MM-DD`). */
  dia: string;
  chofer: string | null;
  /** `true` si ya se presentó y falta aprobarla. */
  presentada: boolean;
}

/** El aviso de las 8 (CU-234): rendiciones de días anteriores sin cerrar. */
export function mensajeDeRendicionesSinCerrar(
  rendiciones: readonly RendicionSinCerrar[],
): MensajeDeCorreo {
  return {
    asunto: `Rendiciones sin cerrar: ${rendiciones.length}`,
    preheader: `${rendiciones.length} rendición(es) de días anteriores siguen sin cerrarse.`,
    etiqueta: 'Rendiciones',
    titulo: 'Rendiciones sin cerrar',
    bloques: [
      {
        tipo: 'parrafo',
        texto: 'Estas rendiciones de días anteriores siguen sin cerrarse:',
      },
      {
        tipo: 'tabla',
        columnas: [
          { titulo: 'N°', mono: true },
          { titulo: 'Día', mono: true },
          { titulo: 'Chofer' },
          { titulo: 'Estado' },
        ],
        filas: rendiciones.map((r) => [
          String(r.numero),
          r.dia,
          r.chofer ?? 'chofer',
          r.presentada ? 'presentada, sin aprobar' : 'sin presentar',
        ]),
      },
    ],
  };
}
