import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import {
  CylinderInspection,
  CylinderInspectionResult,
} from './entities/cylinder-inspection.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { RegisterInspectionDto } from './dto/register-inspection.dto';
import { normalizarSerial } from './dto/serial-de-envase';
import {
  diaArgentino,
  diaDeTexto,
  finDelDia,
  inicioDelDia,
} from './domain/dia-calendario';
import {
  EstadoDeVigencia,
  Vigencia,
  calcularVigencia,
} from './domain/cylinder-vigencia';

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Estados en los que el envase está fuera de la distribuidora. */
const FUERA_DEL_DEPOSITO: readonly CylinderState[] = [
  CylinderState.DISPATCHED,
  CylinderState.WITH_CUSTOMER,
];

export interface VigenciaDeEnvase {
  cylinder: Cylinder;
  vigencia: Vigencia;
  /** Vencido y todavía afuera: se retira cuando vuelva. */
  retiroPendiente: boolean;
  /** De la más reciente a la más antigua. */
  inspections: CylinderInspection[];
}

export interface EnvaseConVigencia {
  cylinder: Cylinder;
  vigencia: Vigencia;
}

export interface VencimientosDelParque {
  windowDays: number;
  /** Total de cada grupo, sin paginar. */
  totals: { expired: number; expiring: number; unverified: number };
  expired: EnvaseConVigencia[];
  expiring: EnvaseConVigencia[];
  unverified: EnvaseConVigencia[];
}

/**
 * Vigencia de los envases (C-11): registra la revisión periódica, calcula hasta
 * cuándo puede circular cada envase y arma el listado de próximos a vencer. El
 * bloqueo del despacho (CU-135) usa el mismo cálculo (`calcularVigencia`).
 */
@Injectable()
export class CylinderVigenciaService {
  constructor(
    @InjectRepository(Cylinder)
    private readonly cylinders: Repository<Cylinder>,
    @InjectRepository(CylinderInspection)
    private readonly inspections: Repository<CylinderInspection>,
  ) {}

  /**
   * CU-132. Asienta la revisión en el historial y copia en la ficha la última
   * fecha y el vencimiento. Un rechazo deja el vencimiento en la fecha de la
   * revisión, así el envase queda alcanzado por el bloqueo sin otra regla.
   * Una revisión anterior a la última cargada sólo entra al historial: no
   * pisa la ficha.
   */
  async registerInspection(
    cylinderId: string,
    dto: RegisterInspectionDto,
    distributorId: string,
    actorUserId?: string,
  ): Promise<VigenciaDeEnvase> {
    const rechazada = dto.result === CylinderInspectionResult.REJECTED;
    // Fechas de calendario de Buenos Aires: la revisión es de un día y el
    // envase vale hasta el final del día de su vencimiento.
    const diaRevision = diaDeTexto(dto.inspectedAt);
    if (diaRevision > diaArgentino(new Date())) {
      throw new BadRequestException(
        'La fecha de la revisión no puede ser futura',
      );
    }
    let diaVencimiento: string | null = null;
    if (!rechazada) {
      if (!dto.nextDueAt) {
        throw new BadRequestException(
          'La fecha del próximo vencimiento es obligatoria si la revisión no fue rechazada',
        );
      }
      diaVencimiento = diaDeTexto(dto.nextDueAt);
      if (diaVencimiento <= diaRevision) {
        throw new BadRequestException(
          'El vencimiento tiene que ser posterior a la fecha de la revisión',
        );
      }
    }
    const inspectedAt = inicioDelDia(diaRevision);
    const vence = diaVencimiento ? finDelDia(diaVencimiento) : null;

    await this.cylinders.manager.transaction(async (manager) => {
      const cylinder = await this.bloquear(manager, cylinderId, distributorId);
      if (cylinder.state === CylinderState.RETIRED) {
        throw new ConflictException(
          'El envase está dado de baja y no admite revisiones',
        );
      }

      if (
        cylinder.manufacturedAt &&
        inspectedAt.getTime() < cylinder.manufacturedAt.getTime()
      ) {
        throw new BadRequestException(
          'La revisión no puede ser anterior a la fabricación del envase',
        );
      }

      await manager.save(
        manager.create(CylinderInspection, {
          cylinderId,
          distributorId,
          inspectedAt,
          result: dto.result,
          nextDueAt: vence,
          notes: dto.notes ?? null,
        }),
      );

      const esLaMasReciente =
        !cylinder.lastInspectionAt ||
        inspectedAt.getTime() >= cylinder.lastInspectionAt.getTime();
      if (!esLaMasReciente) return;

      cylinder.lastInspectionAt = inspectedAt;
      // Un rechazo vence en el acto: el inicio del día de la revisión ya pasó.
      cylinder.expiresAt = vence ?? inspectedAt;
      await manager.save(cylinder);

      // Rechazado y afuera: no se lo saca de circulación hasta que vuelva, pero
      // queda marcado en el historial del envase.
      if (rechazada && FUERA_DEL_DEPOSITO.includes(cylinder.state)) {
        await manager.save(
          manager.create(CylinderMovement, {
            cylinderId,
            distributorId,
            fromState: cylinder.state,
            toState: cylinder.state,
            actorUserId: actorUserId ?? null,
            note: 'Revisión rechazada: retirar el envase cuando vuelva',
          }),
        );
      }
    });

    return this.getVigencia(cylinderId, distributorId);
  }

  /** CU-133. Vigencia de un envase por id. */
  async getVigencia(
    cylinderId: string,
    distributorId?: string | null,
  ): Promise<VigenciaDeEnvase> {
    const cylinder = await this.cylinders.findOne({
      where: {
        cylinderId,
        ...(distributorId ? { distributorId } : {}),
      },
      relations: ['gasCylinder'],
    });
    if (!cylinder) throw new NotFoundException('Envase no encontrado');
    return this.armar(cylinder);
  }

  /** CU-133. Vigencia de un envase por su número de serie (lo que se escanea). */
  async getVigenciaBySerial(
    serial: string,
    distributorId?: string | null,
  ): Promise<VigenciaDeEnvase> {
    const cylinder = await this.cylinders.findOne({
      where: {
        serial: normalizarSerial(serial),
        ...(distributorId ? { distributorId } : {}),
      },
      relations: ['gasCylinder'],
    });
    if (!cylinder) throw new NotFoundException('Envase no encontrado');
    return this.armar(cylinder);
  }

  /**
   * CU-134. Envases que vencen dentro de la ventana, los ya vencidos y los que
   * no tienen revisión registrada (aparte, sin fecha con la cual comparar). Los
   * dados de baja no cuentan: ya no circulan.
   */
  async findExpiring(
    days: number,
    distributorId?: string | null,
    limit = 100,
    offset = 0,
  ): Promise<VencimientosDelParque> {
    const ahora = new Date();
    const limite = new Date(ahora.getTime() + days * MS_POR_DIA);
    const grupo = async (
      condicion: string,
      orden: 'expiresAt' | 'serial',
    ): Promise<[EnvaseConVigencia[], number]> => {
      const qb = this.cylinders
        .createQueryBuilder('cylinder')
        .leftJoinAndSelect('cylinder.gasCylinder', 'gasCylinder')
        .where('cylinder.state != :retirado', {
          retirado: CylinderState.RETIRED,
        })
        .andWhere(condicion, { ahora, limite })
        .orderBy(`cylinder.${orden}`, 'ASC')
        .addOrderBy('cylinder.serial', 'ASC')
        .take(limit)
        .skip(offset);
      if (distributorId) {
        qb.andWhere('cylinder.distributorId = :distributorId', {
          distributorId,
        });
      }
      const [cylinders, total] = await qb.getManyAndCount();
      return [
        cylinders.map((cylinder) => ({
          cylinder,
          vigencia: calcularVigencia(cylinder.expiresAt, ahora),
        })),
        total,
      ];
    };

    const [expired, totalExpired] = await grupo(
      'cylinder.expiresAt <= :ahora',
      'expiresAt',
    );
    const [expiring, totalExpiring] = await grupo(
      'cylinder.expiresAt > :ahora AND cylinder.expiresAt <= :limite',
      'expiresAt',
    );
    const [unverified, totalUnverified] = await grupo(
      'cylinder.expiresAt IS NULL',
      'serial',
    );
    return {
      windowDays: days,
      totals: {
        expired: totalExpired,
        expiring: totalExpiring,
        unverified: totalUnverified,
      },
      expired,
      expiring,
      unverified,
    };
  }

  private async armar(cylinder: Cylinder): Promise<VigenciaDeEnvase> {
    const vigencia = calcularVigencia(cylinder.expiresAt);
    const inspections = await this.inspections.find({
      where: { cylinderId: cylinder.cylinderId },
      order: { inspectedAt: 'DESC' },
    });
    return {
      cylinder,
      vigencia,
      inspections,
      retiroPendiente:
        vigencia.estado === EstadoDeVigencia.VENCIDO &&
        FUERA_DEL_DEPOSITO.includes(cylinder.state),
    };
  }

  private async bloquear(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<Cylinder> {
    const cylinder = await manager
      .createQueryBuilder(Cylinder, 'cylinder')
      .setLock('pessimistic_write')
      .where('cylinder.cylinderId = :id', { id })
      .andWhere('cylinder.distributorId = :distributorId', { distributorId })
      .getOne();
    if (!cylinder) throw new NotFoundException('Envase no encontrado');
    return cylinder;
  }
}
