import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { traducirErrorDeBase } from '../../common/errors/db-exceptions';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { sinIndefinidos } from '../../common/utils/sin-indefinidos.util';
import {
  CreateInsurerDto,
  QueryInsurerDto,
  UpdateInsurerDto,
} from '../dto/insurer.dto';
import { InstallmentStatus } from '../domain/insurance.enums';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import { Insurer } from '../entities/insurer.entity';

const NOMBRE_REPETIDO = 'Ya hay una aseguradora con ese nombre';

/** Aseguradoras de la distribuidora: alta, edición y baja lógica. */
@Injectable()
export class InsurerService {
  private readonly logger = new Logger(InsurerService.name);

  constructor(
    @InjectRepository(Insurer) private readonly insurers: Repository<Insurer>,
    @InjectRepository(InsurancePolicy)
    private readonly policies: Repository<InsurancePolicy>,
    @InjectRepository(InsuranceInstallment)
    private readonly installments: Repository<InsuranceInstallment>,
  ) {}

  async findAll(
    distributorId: string,
    query: QueryInsurerDto,
  ): Promise<{ data: Insurer[]; total: number }> {
    const qb = this.insurers
      .createQueryBuilder('i')
      .where('i.distributor_id = :distributorId', { distributorId });
    const term = query.term?.trim();
    if (term) qb.andWhere('i.name ILIKE :term', { term: `%${term}%` });
    const [data, total] = await qb
      .orderBy('i.name', 'ASC')
      .addOrderBy('i.insurer_id', 'ASC')
      .limit(query.limit ?? 10)
      .offset(query.offset ?? 0)
      .getManyAndCount();
    return { data, total };
  }

  async findOne(id: string, distributorId: string): Promise<Insurer> {
    const aseguradora = await this.insurers.findOne({
      where: { insurerId: id, distributorId },
    });
    if (!aseguradora) {
      throw new NotFoundException('Aseguradora no encontrada');
    }
    return aseguradora;
  }

  async create(dto: CreateInsurerDto, distributorId: string): Promise<Insurer> {
    await this.assertNombreLibre(dto.name, distributorId, null);
    try {
      return await this.insurers.save(
        this.insurers.create({
          distributorId,
          name: dto.name,
          taxId: dto.taxId ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          website: dto.website ?? null,
          paymentUrl: dto.paymentUrl ?? null,
          notes: dto.notes ?? null,
        }),
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'aseguradoras');
    }
  }

  async update(
    id: string,
    dto: UpdateInsurerDto,
    distributorId: string,
  ): Promise<Insurer> {
    const aseguradora = await this.findOne(id, distributorId);
    if (dto.name !== undefined && dto.name !== aseguradora.name) {
      await this.assertNombreLibre(dto.name, distributorId, id);
    }
    Object.assign(aseguradora, sinIndefinidos({ ...dto }));
    try {
      return await this.insurers.save(aseguradora);
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'aseguradoras');
    }
  }

  /**
   * Baja lógica. Con pólizas vigentes o futuras no se da de baja (409): primero
   * se cancelan o se esperan a que venzan.
   */
  async remove(id: string, distributorId: string): Promise<void> {
    const aseguradora = await this.findOne(id, distributorId);
    const vivas = await this.policies
      .createQueryBuilder('p')
      .where('p.insurer_id = :id AND p.distributor_id = :distributorId', {
        id,
        distributorId,
      })
      .andWhere('p.cancelled_at IS NULL AND p.valid_to > :hoy', {
        hoy: diaArgentino(),
      })
      .getCount();
    const cuotasPendientes = await this.installments
      .createQueryBuilder('c')
      .innerJoin('c.policy', 'p')
      .where('p.insurer_id = :id AND c.distributor_id = :distributorId', {
        id,
        distributorId,
      })
      .andWhere('c.status = :pendiente', {
        pendiente: InstallmentStatus.PENDING,
      })
      .getCount();
    if (cuotasPendientes > 0) {
      throw new ConflictException(
        `La aseguradora tiene ${cuotasPendientes} cuota(s) pendiente(s) de pago, aunque la póliza haya vencido: pagalas o cancelá la póliza antes de darla de baja`,
      );
    }
    if (vivas > 0) {
      throw new ConflictException(
        `La aseguradora tiene ${vivas} póliza(s) vigente(s) o futura(s): cancelalas antes de darla de baja`,
      );
    }
    await this.insurers.softRemove(aseguradora);
  }

  private async assertNombreLibre(
    name: string,
    distributorId: string,
    excluirId: string | null,
  ): Promise<void> {
    const qb = this.insurers
      .createQueryBuilder('i')
      .where('i.distributor_id = :distributorId', { distributorId })
      .andWhere('lower(btrim(i.name)) = lower(btrim(:name))', { name });
    if (excluirId) qb.andWhere('i.insurer_id <> :excluirId', { excluirId });
    if ((await qb.getCount()) > 0) throw new ConflictException(NOMBRE_REPETIDO);
  }
}
