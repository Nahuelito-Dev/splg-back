import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CoverageZone, PoligonoGeoJson } from './entities/coverage-zone.entity';
import { CreateCoverageZoneDto } from './dto/create-coverage-zone.dto';
import { CoverageCheckResponseDto } from './dto/coverage-zone-response.dto';

/** Resultado de chequear si una dirección está cubierta por la distribuidora. */
export type CoverageResult = CoverageCheckResponseDto;

/** Lo que devuelve la consulta de PostGIS de checkCoverage. */
interface FilaZona {
  coverage_zone_id: string;
  name: string;
  surcharge: string;
}

@Injectable()
export class CoverageZoneService {
  constructor(
    @InjectRepository(CoverageZone)
    private readonly repo: Repository<CoverageZone>,
  ) {}

  /** Convierte el anillo [lng,lat][] del DTO en GeoJSON Polygon cerrado. */
  private toGeoJsonPolygon(ring: number[][]): PoligonoGeoJson {
    for (const p of ring) {
      if (
        !Array.isArray(p) ||
        p.length !== 2 ||
        p.some((n) => typeof n !== 'number')
      ) {
        throw new BadRequestException(
          'Cada vértice del polígono debe ser [lng, lat] numérico',
        );
      }
    }
    const closed = [...ring];
    const first = closed[0];
    const last = closed[closed.length - 1];
    // GeoJSON exige el anillo cerrado (primer punto === último).
    if (first[0] !== last[0] || first[1] !== last[1]) {
      closed.push(first);
    }
    return { type: 'Polygon', coordinates: [closed] };
  }

  async create(
    dto: CreateCoverageZoneDto,
    distributorId: string,
  ): Promise<CoverageZone> {
    const zone = this.repo.create({
      name: dto.name,
      distributor_id: distributorId,
      area: this.toGeoJsonPolygon(dto.polygon),
      surcharge: dto.surcharge ?? 0,
      isActive: dto.isActive ?? true,
    });
    return this.repo.save(zone);
  }

  findAll(distributorId: string): Promise<CoverageZone[]> {
    return this.repo.find({
      where: { distributor_id: distributorId },
      order: { createdAt: 'ASC' },
    });
  }

  async findOne(
    id: string,
    distributorId?: string | null,
  ): Promise<CoverageZone> {
    const zone = await this.repo.findOne({
      where: {
        coverage_zone_id: id,
        ...(distributorId ? { distributor_id: distributorId } : {}),
      },
    });
    if (!zone) throw new NotFoundException(`Zona ${id} no encontrada`);
    return zone;
  }

  async remove(id: string, distributorId: string): Promise<void> {
    const zone = await this.findOne(id, distributorId);
    await this.repo.softRemove(zone);
  }

  /**
   * ¿La dirección (lat/lng) cae dentro de alguna zona ACTIVA de la
   * distribuidora? Devuelve la de MENOR recargo entre las que la contienen
   * (ST_Contains). Si la distribuidora NO tiene zonas definidas, se considera
   * cubierta con recargo 0 (no bloquea a empresas que aún no cargaron zonas).
   */
  async checkCoverage(
    distributorId: string,
    lat: number,
    lng: number,
  ): Promise<CoverageResult> {
    const total = await this.repo.count({
      where: { distributor_id: distributorId, isActive: true },
    });
    if (total === 0) {
      return { covered: true, surcharge: 0 };
    }

    // Consulta cruda de PostGIS: TypeORM la devuelve sin tipo y la forma de
    // la fila es la del SELECT de acá abajo.
    const rows: FilaZona[] = await this.repo.query(
      `SELECT coverage_zone_id, name, surcharge
         FROM coverage_zone
        WHERE distributor_id = $1
          AND "isActive" = true
          AND "deletedAt" IS NULL
          AND ST_Contains(area, ST_SetSRID(ST_MakePoint($2, $3), 4326))
        ORDER BY surcharge ASC
        LIMIT 1`,
      [distributorId, lng, lat],
    );

    const zone = rows[0];
    if (!zone) {
      return { covered: false, surcharge: 0 };
    }
    return {
      covered: true,
      zoneId: zone.coverage_zone_id,
      zoneName: zone.name,
      surcharge: Number(zone.surcharge),
    };
  }
}
