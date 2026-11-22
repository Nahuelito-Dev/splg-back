import { Injectable } from '@nestjs/common';
import { EntityPhotoService } from '../../s3/entity-photo.service';
import type { User } from '../../users/entities/user.entity';
import type { SupportSession } from '../entities/support-session.entity';
import type { SupportSessionResponseDto } from './dto/support-session-response.dto';
import { SupportMapper } from './support.mapper';

/**
 * Arma las respuestas de las sesiones de soporte con la foto firmada de quien
 * la pidió, la decidió y la terminó. Las personas ya vienen cargadas con la
 * sesión (su `photoKey` sale en la misma consulta): acá sólo se firma, una vez
 * por persona aunque se repita en la página.
 */
@Injectable()
export class SupportSessionPresenter {
  constructor(private readonly fotos: EntityPhotoService) {}

  async sesiones(
    sesiones: readonly SupportSession[],
  ): Promise<SupportSessionResponseDto[]> {
    const personas = new Map<string, User>();
    for (const s of sesiones) {
      const deLaSesion: Array<[string | null, User | null | undefined]> = [
        [s.requestedBy, s.requester],
        [s.decidedBy, s.decider],
        [s.endedBy, s.ender],
      ];
      for (const [id, persona] of deLaSesion) {
        if (id && persona) personas.set(id, persona);
      }
    }
    const urls = new Map<string, string | null>(
      await Promise.all(
        [...personas].map(
          async ([id, persona]) =>
            [id, await this.fotos.urlDe(persona.photoKey)] as [
              string,
              string | null,
            ],
        ),
      ),
    );
    return sesiones.map((s) => SupportMapper.toDto(s, urls));
  }

  async sesion(sesion: SupportSession): Promise<SupportSessionResponseDto> {
    const [dto] = await this.sesiones([sesion]);
    return dto;
  }
}
