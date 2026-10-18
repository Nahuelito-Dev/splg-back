import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { diaArgentino } from '../common/utils/dias-argentina';
import { CarService } from '../car/car.service';
import { Car } from '../car/entities/car.entity';
import { FleetCostSourceService } from '../fleet/fleet-cost-source.service';
import { CarCostDetailDto, FleetCostSummaryDto } from './dto/fleet-cost.dto';
import {
  calcularCostoDeVehiculo,
  CostoDeVehiculo,
  EntradasDeCosto,
  MAXIMO_DE_DIAS_DEL_RANGO,
} from './domain/vehicle-cost';
import { rangoDeDias } from './domain/rango';
import { FuelLoad } from './entities/fuel-load.entity';
import { TrafficFine, TrafficFineStatus } from './entities/traffic-fine.entity';
import {
  VehicleAccident,
  VehicleAccidentStatus,
} from './entities/vehicle-accident.entity';

/**
 * Costo total de los vehículos (CU-203) y tablero de la flota (CU-204). Es un
 * modelo de lectura: no tiene datos propios, suma lo que registran el
 * mantenimiento y los seguros (`fleet`), el combustible, las multas pagadas
 * que no se imputaron al chofer y los siniestros cerrados. El tablero calcula
 * cada vehículo con las mismas reglas que el costo de uno solo.
 */
@Injectable()
export class FleetCostService {
  constructor(
    @InjectRepository(FuelLoad) private readonly fuel: Repository<FuelLoad>,
    @InjectRepository(TrafficFine)
    private readonly fines: Repository<TrafficFine>,
    @InjectRepository(VehicleAccident)
    private readonly accidents: Repository<VehicleAccident>,
    private readonly cars: CarService,
    private readonly fleet: FleetCostSourceService,
  ) {}

  /** CU-203 */
  async costoDelVehiculo(
    carId: string,
    distributorId: string,
    from: string,
    to: string,
  ): Promise<CarCostDetailDto> {
    const car = await this.cars.findOne(carId, distributorId); // 404 «Vehículo … no encontrado»
    const mapa = await this.calcular(distributorId, [car], from, to);
    const costo = mapa.get(car.carId) as CostoDeVehiculo;

    const dto = new CarCostDetailDto();
    Object.assign(dto, this.resumen(car, costo));
    dto.from = from;
    dto.to = to;
    dto.monthly = costo.monthly;
    return dto;
  }

  /** CU-204: un renglón por vehículo, de mayor a menor costo por km; sin km, al final. */
  async tablero(
    distributorId: string,
    from: string,
    to: string,
  ): Promise<FleetCostSummaryDto[]> {
    rangoDeDias(from, to, MAXIMO_DE_DIAS_DEL_RANGO);
    const vehiculos = await this.cars.findAll(distributorId);
    const mapa = await this.calcular(distributorId, vehiculos, from, to);
    return vehiculos
      .map((car) => this.resumen(car, mapa.get(car.carId) as CostoDeVehiculo))
      .sort(
        (a, b) =>
          (b.costPerKm ?? -1) - (a.costPerKm ?? -1) ||
          b.total - a.total ||
          a.carId.localeCompare(b.carId),
      );
  }

  private resumen(car: Car, c: CostoDeVehiculo): FleetCostSummaryDto {
    const dto = new FleetCostSummaryDto();
    dto.carId = car.carId;
    dto.carPatent = car.carPatent;
    dto.carBrand = car.carBrand;
    dto.carModel = car.carModel;
    dto.maintenance = c.maintenance;
    dto.insurance = c.insurance;
    dto.fuel = c.fuel;
    dto.fines = c.fines;
    dto.accidents = c.accidents;
    dto.total = c.total;
    dto.insuranceEstimated = c.insuranceEstimated;
    dto.km = c.km;
    dto.kmSource = c.kmSource;
    dto.costPerKm = c.costPerKm;
    return dto;
  }

  private async calcular(
    distributorId: string,
    vehiculos: Car[],
    from: string,
    to: string,
  ): Promise<Map<string, CostoDeVehiculo>> {
    const { desde, hasta } = rangoDeDias(from, to, MAXIMO_DE_DIAS_DEL_RANGO);
    const carIds = vehiculos.map((v) => v.carId);
    const resultado = new Map<string, CostoDeVehiculo>();
    if (carIds.length === 0) return resultado;

    const [mantenimiento, seguros, km, combustible, multas, siniestros] =
      await Promise.all([
        this.fleet.mantenimiento(distributorId, carIds, desde, hasta),
        this.fleet.seguros(distributorId, carIds, desde),
        this.fleet.kmDeUso(distributorId, carIds, from, to),
        this.fuel
          .createQueryBuilder('f')
          .where('f.distributor_id = :distributorId', { distributorId })
          .andWhere('f.car_id IN (:...carIds)', { carIds })
          .andWhere('f.loaded_at >= :desde AND f.loaded_at < :hasta', {
            desde,
            hasta,
          })
          .getMany(),
        this.fines
          .createQueryBuilder('m')
          .where('m.distributor_id = :distributorId', { distributorId })
          .andWhere('m.car_id IN (:...carIds)', { carIds })
          .andWhere('m.status = :pagada', { pagada: TrafficFineStatus.PAID })
          .andWhere('m.charged_to_employee = false')
          .andWhere('m.paid_at >= :desde AND m.paid_at < :hasta', {
            desde,
            hasta,
          })
          .getMany(),
        this.accidents
          .createQueryBuilder('s')
          .where('s.distributor_id = :distributorId', { distributorId })
          .andWhere('s.car_id IN (:...carIds)', { carIds })
          .andWhere('s.status = :cerrado', {
            cerrado: VehicleAccidentStatus.CLOSED,
          })
          .andWhere('s.closed_at >= :desde AND s.closed_at < :hasta', {
            desde,
            hasta,
          })
          .getMany(),
      ]);

    const kmPorAuto = new Map(km.map((k) => [k.carId, k.km]));
    for (const carId of carIds) {
      const entradas: EntradasDeCosto = {
        maintenance: mantenimiento.filter((t) => t.carId === carId),
        insurance: seguros.filter((p) => p.carId === carId),
        fuel: combustible.filter((c) => c.carId === carId),
        fines: multas
          .filter((m) => m.carId === carId)
          .map((m) => ({
            paidAt: diaArgentino(m.paidAt as Date),
            paidAmount: m.paidAmount ?? 0,
          })),
        accidents: siniestros
          .filter((s) => s.carId === carId)
          .map((s) => ({
            closedAt: s.closedAt as Date,
            repairCost: s.repairCost ?? 0,
            insurerReimbursement: s.insurerReimbursement ?? 0,
          })),
        usageKm: kmPorAuto.get(carId) ?? 0,
      };
      resultado.set(carId, calcularCostoDeVehiculo(entradas, from, to));
    }
    return resultado;
  }
}
