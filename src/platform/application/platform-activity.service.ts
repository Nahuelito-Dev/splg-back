import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformMetricsRepository } from '../infrastructure/platform-metrics.repository';
import type { FilaDeActividad } from '../infrastructure/platform-metrics.repository';
import { ActivityListResponseDto } from '../presentation/dto/platform-response.dto';
import { PlatformMapper } from '../presentation/platform.mapper';
import { EntityPhotoService } from '../../s3/entity-photo.service';

export interface FiltroDeActividadDto {
  from?: string;
  to?: string;
  actorUserId?: string;
  distributorId?: string;
  limit: number;
  offset: number;
}

/**
 * La actividad de la plataforma (su auditoría propia): lo que escribieron los
 * administradores generales, los cambios de empresas y de sesiones de soporte
 * y los ingresos de los administradores generales. Las más nuevas primero.
 */
@Injectable()
export class PlatformActivityService {
  constructor(
    private readonly repo: PlatformMetricsRepository,
    private readonly fotos: EntityPhotoService,
  ) {}

  async listar(q: FiltroDeActividadDto): Promise<ActivityListResponseDto> {
    const desde = q.from ? new Date(q.from) : null;
    const hasta = q.to ? new Date(q.to) : null;
    if (desde && hasta && desde > hasta) {
      throw new BadRequestException(
        'La fecha «desde» no puede ser posterior a la fecha «hasta»',
      );
    }
    const filtro = {
      desde,
      hasta,
      actorUserId: q.actorUserId ?? null,
      distributorId: q.distributorId ?? null,
      limit: q.limit,
      offset: q.offset,
    };
    const filas = await this.repo.actividad(filtro);
    // El total viaja en cada fila; una página vacía (offset de más) lo pide aparte.
    const total =
      filas[0]?.total ??
      (q.offset > 0 ? await this.repo.totalDeActividad(filtro) : 0);
    const fotos = await this.fotosDeLosActores(filas);
    return {
      items: filas.map((f) =>
        PlatformMapper.actividad(f, fotos.get(f.actor_photo_key ?? '') ?? null),
      ),
      total,
    };
  }

  /**
   * La foto firmada de cada actor de la página, por su key. La key llega en la
   * misma consulta y cada foto se firma una sola vez aunque el actor se repita.
   */
  private async fotosDeLosActores(
    filas: readonly FilaDeActividad[],
  ): Promise<Map<string, string | null>> {
    const keys = [
      ...new Set(
        filas.flatMap((f) => (f.actor_photo_key ? [f.actor_photo_key] : [])),
      ),
    ];
    const urls = await Promise.all(keys.map((k) => this.fotos.urlDe(k)));
    return new Map(keys.map((k, i) => [k, urls[i]]));
  }
}
