import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';
import {
  CoverageZone,
  CoverageZoneSurchargeType,
  PoligonoGeoJson,
} from './entities/coverage-zone.entity';
import { CreateCoverageZoneDto } from './dto/create-coverage-zone.dto';
import { UpdateCoverageZoneDto } from './dto/update-coverage-zone.dto';
import {
  CoverageCheckResponseDto,
  CoverageZoneResumenDto,
} from './dto/coverage-zone-response.dto';
import { CoverageZonePricingService } from './coverage-zone-pricing.service';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';

/** Resultado de chequear si una dirección está cubierta por la distribuidora. */
export type CoverageResult = CoverageCheckResponseDto;

/** Lo que devuelve la consulta de PostGIS de la zona ganadora. */
interface FilaZonaGanadora {
  coverage_zone_id: string;
  name: string;
  surcharge_type: CoverageZoneSurchargeType;
  surcharge_value: string;
  color: string | null;
}

@Injectable()
export class CoverageZoneService {
  private readonly logger = new Logger(CoverageZoneService.name);

  constructor(
    @InjectRepository(CoverageZone)
    private readonly repo: Repository<CoverageZone>,
    private readonly pricing: CoverageZonePricingService,
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

  /**
   * Un anillo con puntos válidos igual puede describir un polígono inválido
   * (que se autointersecta, por ejemplo). Antes de guardar se lo valida contra
   * PostGIS, que además explica POR QUÉ no sirve.
   */
  private async validarPoligono(area: PoligonoGeoJson): Promise<void> {
    const filas: { valid: boolean; reason: string }[] = await this.repo.query(
      `SELECT ST_IsValid(ST_GeomFromGeoJSON($1)) AS valid,
              ST_IsValidReason(ST_GeomFromGeoJSON($1)) AS reason`,
      [JSON.stringify(area)],
    );
    const fila = filas[0];
    if (!fila?.valid) {
      throw new BadRequestException(
        `El polígono no es válido: ${fila?.reason ?? 'geometría inválida'}`,
      );
    }
  }

  /** `percentage` sólo admite 0-100; `fixed` sólo no puede ser negativo. */
  private validarRecargo(type: CoverageZoneSurchargeType, value: number): void {
    if (value < 0) {
      throw new BadRequestException(
        'surchargeValue: un recargo no puede ser negativo',
      );
    }
    if (type === CoverageZoneSurchargeType.PERCENTAGE && value > 100) {
      throw new BadRequestException(
        'surchargeValue: un recargo porcentual tiene que estar entre 0 y 100',
      );
    }
  }

  /**
   * `new Date(null)` NO da un error: da 1970-01-01 (trata `null` como `0`).
   * Por eso una fecha de vigencia se parsea siempre por acá: cadena con
   * valor → esa fecha; `null` (o vacío) → sin límite.
   */
  private parseFechaVigencia(valor: string | null | undefined): Date | null {
    return valor ? new Date(valor) : null;
  }

  private validarVigencia(desde: Date | null, hasta: Date | null): void {
    if (desde && hasta && hasta <= desde) {
      throw new BadRequestException(
        'validUntil tiene que ser posterior a validFrom',
      );
    }
  }

  /** Una zona que va a quedar activa no puede tener la fecha de fin vencida. */
  private validarNoVencida(hasta: Date | null, activa: boolean): void {
    if (activa && hasta && hasta.getTime() <= Date.now()) {
      throw new BadRequestException(
        'validUntil ya pasó: una zona vencida no puede quedar activa',
      );
    }
  }

  async create(
    dto: CreateCoverageZoneDto,
    distributorId: string,
  ): Promise<CoverageZone> {
    const area = this.toGeoJsonPolygon(dto.polygon);
    await this.validarPoligono(area);

    const surchargeType =
      dto.surchargeType ?? CoverageZoneSurchargeType.PERCENTAGE;
    const surchargeValue = dto.surchargeValue ?? 0;
    this.validarRecargo(surchargeType, surchargeValue);

    const validFrom = this.parseFechaVigencia(dto.validFrom);
    const validUntil = this.parseFechaVigencia(dto.validUntil);
    this.validarVigencia(validFrom, validUntil);
    this.validarNoVencida(validUntil, dto.isActive ?? true);

    const activa = dto.isActive ?? true;
    return this.repo.manager.transaction(async (manager) => {
      await this.bloquearZonasDe(manager, distributorId);
      // Sin prioridad en el alta: la zona queda por encima de las que ya hay.
      const priority =
        dto.priority ?? (await this.siguientePrioridad(manager, distributorId));
      if (activa) {
        await this.asegurarNombreYPrioridadLibres(manager, distributorId, {
          id: null,
          name: dto.name,
          priority,
        });
      }
      const zone = manager.create(CoverageZone, {
        name: dto.name,
        distributorId,
        area,
        surchargeType,
        surchargeValue,
        label: dto.label ?? null,
        color: dto.color ?? null,
        priority,
        validFrom,
        validUntil,
        isActive: activa,
      });
      try {
        return await manager.save(zone);
      } catch (error) {
        return this.handleDBExceptions(error);
      }
    });
  }

  /**
   * Serializa las altas y cambios de zonas de una distribuidora: el control de
   * nombre y prioridad lee y después escribe, y dos al mismo tiempo no se verían.
   */
  private async bloquearZonasDe(
    manager: EntityManager,
    distributorId: string,
  ): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `coverage_zone:${distributorId}`,
    ]);
  }

  private async siguientePrioridad(
    manager: EntityManager,
    distributorId: string,
  ): Promise<number> {
    const { max } = (await manager
      .createQueryBuilder(CoverageZone, 'z')
      .select('MAX(z.priority)', 'max')
      .where('z.distributorId = :distributorId', { distributorId })
      .getRawOne<{ max: string | null }>()) ?? { max: null };
    return max === null ? 0 : Number(max) + 1;
  }

  /**
   * Entre las zonas activas de una distribuidora el nombre (sin distinguir
   * mayúsculas) y la prioridad no se repiten (409). La base lo garantiza igual
   * (`UQ_coverage_zone_nombre_activa`, `UQ_coverage_zone_prioridad_activa`);
   * esto devuelve el motivo.
   */
  private async asegurarNombreYPrioridadLibres(
    manager: EntityManager,
    distributorId: string,
    zona: { id: string | null; name: string; priority: number },
  ): Promise<void> {
    const otras = (
      await manager.find(CoverageZone, {
        where: { distributorId, isActive: true },
      })
    ).filter((otra) => otra.coverageZoneId !== zona.id);
    const mismoNombre = otras.find(
      (otra) =>
        otra.name.trim().toLowerCase() === zona.name.trim().toLowerCase(),
    );
    if (mismoNombre) {
      throw new ConflictException(
        `Ya existe una zona activa con el nombre «${mismoNombre.name}»`,
      );
    }
    const mismaPrioridad = otras.find(
      (otra) => otra.priority === zona.priority,
    );
    if (mismaPrioridad) {
      throw new ConflictException(
        `La zona «${mismaPrioridad.name}» ya tiene la prioridad ${zona.priority}: cada zona activa tiene una prioridad distinta`,
      );
    }
  }

  /** Zonas de la distribuidora. Por default sólo las activas (no borradas). */
  async findAll(
    distributorId: string,
    includeInactive = false,
  ): Promise<[CoverageZone[], number]> {
    return this.repo.findAndCount({
      where: {
        distributorId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      order: { priority: 'DESC', createdAt: 'ASC' },
    });
  }

  async findOne(
    id: string,
    distributorId?: string | null,
  ): Promise<CoverageZone> {
    const zone = await this.repo.findOne({
      where: {
        coverageZoneId: id,
        ...(distributorId ? { distributorId } : {}),
      },
    });
    if (!zone) throw new NotFoundException(`Zona ${id} no encontrada`);
    return zone;
  }

  async update(
    id: string,
    dto: UpdateCoverageZoneDto,
    distributorId: string,
  ): Promise<CoverageZone> {
    // Pertenencia al tenant: de otra distribuidora, no existe (404).
    const actual = await this.findOne(id, distributorId);

    const area = dto.polygon ? this.toGeoJsonPolygon(dto.polygon) : undefined;
    if (area) await this.validarPoligono(area);

    // `PartialType` deja pasar `null` en todos los campos, y el recargo no
    // admite nulos: sin esto llegaba a la base y rebotaba contra la columna.
    if (dto.surchargeType === null || dto.surchargeValue === null) {
      throw new BadRequestException(
        'surchargeType y surchargeValue no pueden ser null: omitilos para no cambiarlos',
      );
    }

    // La validación de negocio corre sobre el estado FUSIONADO: patchear sólo
    // `surchargeValue` en una zona ya `percentage` (o viceversa) tiene que
    // seguir respetando el rango 0-100.
    const surchargeType = dto.surchargeType ?? actual.surchargeType;
    const surchargeValue = dto.surchargeValue ?? actual.surchargeValue;
    this.validarRecargo(surchargeType, surchargeValue);

    const validFrom =
      dto.validFrom !== undefined
        ? this.parseFechaVigencia(dto.validFrom)
        : actual.validFrom;
    const validUntil =
      dto.validUntil !== undefined
        ? this.parseFechaVigencia(dto.validUntil)
        : actual.validUntil;
    this.validarVigencia(validFrom, validUntil);
    // Sólo se exige si el cambio activa la zona o toca su fecha de fin: renombrar
    // una zona vencida que sigue activa (el barrido todavía no pasó) no se bloquea.
    if (
      (dto.isActive === true && !actual.isActive) ||
      dto.validUntil !== undefined
    ) {
      this.validarNoVencida(validUntil, dto.isActive ?? actual.isActive);
    }

    const cambios: DeepPartial<CoverageZone> = sinIndefinidos({
      name: dto.name,
      area,
      surchargeType: dto.surchargeType,
      surchargeValue: dto.surchargeValue,
      label: dto.label,
      color: dto.color,
      priority: dto.priority,
      validFrom: dto.validFrom !== undefined ? validFrom : undefined,
      validUntil: dto.validUntil !== undefined ? validUntil : undefined,
      isActive: dto.isActive,
    });

    return this.repo.manager.transaction(async (manager) => {
      await this.bloquearZonasDe(manager, distributorId);
      const zone = await manager.getRepository(CoverageZone).preload({
        coverageZoneId: id,
        ...cambios,
      });
      if (!zone) throw new NotFoundException(`Zona ${id} no encontrada`);
      if (zone.isActive) {
        await this.asegurarNombreYPrioridadLibres(manager, distributorId, {
          id,
          name: zone.name,
          priority: zone.priority,
        });
      }
      try {
        return await manager.save(zone);
      } catch (error) {
        return this.handleDBExceptions(error);
      }
    });
  }

  async remove(id: string, distributorId: string): Promise<void> {
    const zone = await this.findOne(id, distributorId);
    await this.repo.softRemove(zone);
  }

  /**
   * ¿La dirección (lat/lng) cae dentro de alguna zona ACTIVA y VIGENTE de la
   * distribuidora? Entre zonas superpuestas gana la de mayor `priority` y, a
   * igual prioridad, la de MENOR área (la más específica: p. ej. un barrio
   * chico dentro del área general de la ciudad). Si la distribuidora NUNCA
   * definió zonas (cuenta cualquier zona no borrada, activa o no, vigente o
   * no), se considera cubierta con recargo 0 (no bloquea a empresas que aún no
   * cargaron zonas). Si tiene zonas pero ninguna activa y vigente, no cubre
   * nada; una zona con `valid_until` pasado no cuenta aunque el barrido
   * (CU-151) todavía no la haya apagado.
   *
   * `subtotalItems`, si se manda, hace que la respuesta traiga `amount`: el
   * recargo YA calculado sobre ese subtotal (para que el cliente lo vea antes
   * de confirmar el pedido).
   */
  async checkCoverage(
    distributorId: string,
    lat: number,
    lng: number,
    subtotalItems?: number,
  ): Promise<CoverageResult> {
    // "Nunca definió zonas": cuenta cualquier zona no borrada, esté activa o no
    // y sea vigente o no. Con zonas pero ninguna activa y vigente, no cubre nada.
    const total = await this.repo.count({ where: { distributorId } });
    if (total === 0) {
      return { covered: true, surcharge: 0, zone: null };
    }

    // Consulta cruda de PostGIS: TypeORM la devuelve sin tipo y la forma de la
    // fila es la del SELECT de acá abajo. ST_Covers (no ST_Contains): un punto
    // justo sobre el borde de la zona también cuenta como cubierto.
    const filas: FilaZonaGanadora[] = await this.repo.query(
      `SELECT coverage_zone_id, name, surcharge_type, surcharge_value, color
         FROM coverage_zone
        WHERE distributor_id = $1
          AND "isActive" = true
          AND "deletedAt" IS NULL
          AND (valid_from IS NULL OR valid_from <= now())
          AND (valid_until IS NULL OR valid_until > now())
          AND ST_Covers(area, ST_SetSRID(ST_MakePoint($2, $3), 4326))
        ORDER BY priority DESC, ST_Area(area) ASC
        LIMIT 1`,
      [distributorId, lng, lat],
    );

    const fila = filas[0];
    if (!fila) {
      return { covered: false, surcharge: 0, zone: null };
    }

    const zone: CoverageZoneResumenDto = {
      id: fila.coverage_zone_id,
      name: fila.name,
      type: fila.surcharge_type,
      value: Number(fila.surcharge_value),
      color: fila.color,
    };

    const resultado: CoverageResult = {
      covered: true,
      // Compat: campos previos a que existiera `zone`. `surcharge` es el
      // valor CRUDO de la zona (nunca el monto calculado), igual que antes.
      zoneId: zone.id,
      zoneName: zone.name,
      surcharge: zone.value,
      zone,
    };

    if (subtotalItems !== undefined) {
      resultado.amount = this.pricing
        .zoneSurcharge(subtotalItems, zone)
        .toNumber();
    }

    return resultado;
  }

  /**
   * Delega en el traductor compartido: registra el error real y lo convierte
   * en una respuesta HTTP que explique qué pasó (nunca un 500 mudo).
   */
  private handleDBExceptions(error: unknown): never {
    return traducirErrorDeBase(error, this.logger, 'zonas de cobertura');
  }
}
