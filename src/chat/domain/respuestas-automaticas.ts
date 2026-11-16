/** Lo que se sabe del chat al llegar un mensaje de la empresa. */
export interface SituacionDelChat {
  /** La plataforma atiende en este momento (horario). */
  enHorario: boolean;
  /** El aviso de recibido está prendido en la configuración. */
  avisoDeRecibidoHabilitado: boolean;
  /** Ya se mandó el aviso de recibido en esta apertura del chat. */
  yaSeAvisoRecibido: boolean;
  /** Alguien de la plataforma ya escribió en esta apertura. */
  plataformaYaEscribio: boolean;
  /** Ya se respondió fuera de horario desde la última respuesta de la plataforma. */
  yaSeRespondioFueraDeHorario: boolean;
}

/**
 * La respuesta automática al mensaje de la empresa en el chat (D-C29):
 *  - en horario, el aviso «Recibimos tu mensaje…» una sola vez por apertura,
 *    salvo que la plataforma ya esté escribiendo en ese chat;
 *  - fuera de horario, la que ofrece pasarlo a un ticket, una vez hasta que la
 *    plataforma vuelva a responder.
 */
export function respuestaAutomatica(
  s: SituacionDelChat,
): 'recibido' | 'fuera_de_horario' | null {
  if (s.enHorario) {
    return s.avisoDeRecibidoHabilitado &&
      !s.yaSeAvisoRecibido &&
      !s.plataformaYaEscribio
      ? 'recibido'
      : null;
  }
  return s.yaSeRespondioFueraDeHorario ? null : 'fuera_de_horario';
}

/** El aviso de recibido por defecto, con el nombre de la plataforma. */
export function avisoDeRecibidoPorDefecto(plataforma: string): string {
  return `Recibimos tu mensaje. Alguien del equipo de ${plataforma} te va a atender a la brevedad.`;
}
