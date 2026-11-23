import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CarService } from '../../car/car.service';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { estadoDeLaPoliza } from '../domain/insurance-rules';
import { PolicyStatus } from '../domain/insurance.enums';
import { QueryInsuranceInstallmentDto } from '../dto/insurance-installment.dto';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';

/** Lecturas de seguros: la póliza de un vehículo con su historial y el listado general de cuotas. */
@Injectable()
export class InsuranceQueryService {
  constructor(
    @InjectRepository(InsurancePolicy)
    private readonly policies: Repository<InsurancePolicy>,
    @InjectRepository(InsuranceInstallment)
    private readonly installments: Repository<InsuranceInstallment>,
    private readonly cars: CarService,
  ) {}

  async findPolicy(
    id: string,
    distributorId: string,
  ): Promise<InsurancePolicy> {
    const poliza = await this.policies.findOne({
      where: { policyId: id, distributorId },
      relations: { insurer: true, car: true, installments: true },
      withDeleted: true, // la aseguradora dada de baja sigue figurando en la póliza
    });
    if (!poliza) throw new NotFoundException('Póliza no encontrada');
    return poliza;
  }

  /**
   * La póliza que cubre hoy; si no hay, la próxima que empieza; el resto, del
   * más nuevo al más viejo, como historial (vencidas y canceladas incluidas).
   */
  async ofCar(
    carId: string,
    distributorId: string,
  ): Promise<{ current: InsurancePolicy | null; history: InsurancePolicy[] }> {
    await this.cars.findOne(carId, distributorId); // 404 si no existe o es de otra distribuidora
    const todas = await this.policies.find({
      where: { carId, distributorId },
      relations: { insurer: true, car: true, installments: true },
      order: { validFrom: 'DESC', policyId: 'ASC' },
      withDeleted: true,
    });
    const hoy = diaArgentino();
    const estado = (p: InsurancePolicy) => estadoDeLaPoliza(p, hoy);
    const current =
      todas.find((p) => estado(p) === PolicyStatus.ACTIVE) ??
      [...todas].reverse().find((p) => estado(p) === PolicyStatus.UPCOMING) ??
      null;
    return { current, history: todas.filter((p) => p !== current) };
  }

  async findInstallments(
    distributorId: string,
    query: QueryInsuranceInstallmentDto,
  ): Promise<{ data: InsuranceInstallment[]; total: number }> {
    const qb = this.installments
      .createQueryBuilder('c')
      .withDeleted() // la aseguradora dada de baja sigue figurando en el historial
      .innerJoinAndSelect('c.policy', 'p')
      .innerJoinAndSelect('p.insurer', 'i')
      .leftJoinAndSelect('p.car', 'car')
      .where('c.distributor_id = :distributorId', { distributorId });
    if (query.status)
      qb.andWhere('c.status = :status', { status: query.status });
    if (query.approvalStatus) {
      qb.andWhere('c.approval_status = :approvalStatus', {
        approvalStatus: query.approvalStatus,
      });
    }
    if (query.dueFrom)
      qb.andWhere('c.due_date >= :dueFrom', { dueFrom: query.dueFrom });
    if (query.dueTo)
      qb.andWhere('c.due_date <= :dueTo', { dueTo: query.dueTo });
    if (query.carId) qb.andWhere('p.car_id = :carId', { carId: query.carId });
    const [data, total] = await qb
      .orderBy('c.due_date', 'ASC')
      .addOrderBy('c.installment_id', 'ASC')
      .limit(query.limit ?? 10)
      .offset(query.offset ?? 0)
      .getManyAndCount();
    return { data, total };
  }
}
