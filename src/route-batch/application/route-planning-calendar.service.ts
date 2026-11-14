import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, MoreThanOrEqual, Repository } from 'typeorm';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { RoutePlanningHoliday } from '../../order/entities/route-planning-holiday.entity';
import {
  CalendarioLaboral,
  DIAS_HABILES_POR_OMISION,
  diasDeLaMascara,
  sumarDias,
} from '../domain/calendario-laboral';
import {
  feriadoNoEncontrado,
  feriadoPasado,
  feriadoRepetido,
} from './route-sheet.exceptions';

/** Cuánto hacia adelante se leen los feriados para buscar el próximo día hábil. */
const DIAS_DE_FERIADOS = 400;

/**
 * Los días hábiles de la hoja de ruta de una distribuidora (F34): los días de
 * la semana en que reparte (`route_planning.workingDays`) y sus feriados (alta,
 * listado y baja lógica). Todo filtra por la distribuidora.
 */
@Injectable()
export class RoutePlanningCalendarService {
  constructor(
    @InjectRepository(RoutePlanningHoliday)
    private readonly feriados: Repository<RoutePlanningHoliday>,
    private readonly processConfig: ProcessConfigService,
  ) {}

  /** El calendario para buscar días hábiles después de `desde`. */
  async calendario(
    distributorId: string,
    desde: string,
  ): Promise<CalendarioLaboral> {
    const v = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    const filas = await this.feriados.find({
      where: {
        distributorId,
        date: Between(desde, sumarDias(desde, DIAS_DE_FERIADOS)),
      },
    });
    return {
      diasHabiles: diasDeLaMascara(v.workingDays ?? DIAS_HABILES_POR_OMISION),
      feriados: new Set(filas.map((f) => f.date)),
    };
  }

  /** Los feriados vigentes desde `desde` (por omisión, hoy) hasta `hasta`, por fecha. */
  listar(
    distributorId: string,
    rango: { from?: string; to?: string },
    hoy: string = diaArgentino(),
  ): Promise<RoutePlanningHoliday[]> {
    const desde = rango.from ?? hoy;
    return this.feriados.find({
      where: {
        distributorId,
        date: rango.to ? Between(desde, rango.to) : MoreThanOrEqual(desde),
      },
      order: { date: 'ASC' },
    });
  }

  /** Alta de un feriado: hoy o más adelante, uno solo vigente por día (409). */
  async crear(
    distributorId: string,
    dto: { date: string; description: string },
    hoy: string = diaArgentino(),
  ): Promise<RoutePlanningHoliday> {
    if (dto.date < hoy) throw feriadoPasado();
    try {
      return await this.feriados.save(
        this.feriados.create({
          distributorId,
          date: dto.date,
          description: dto.description.trim(),
        }),
      );
    } catch (error) {
      if (codigoSqlDelError(error) === '23505') throw feriadoRepetido();
      throw error;
    }
  }

  /** Baja lógica; uno de otra distribuidora (o ya dado de baja) es 404. */
  async borrar(distributorId: string, holidayId: string): Promise<void> {
    const feriado = await this.feriados.findOne({
      where: { holidayId, distributorId },
    });
    if (!feriado) throw feriadoNoEncontrado();
    await this.feriados.softDelete({ holidayId, distributorId });
  }
}
