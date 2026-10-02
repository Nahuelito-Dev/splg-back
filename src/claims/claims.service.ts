import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import { Claim, ClaimStatus } from './entities/claim.entity';
import { CreateClaimDto } from './dto/create-claim.dto';
import { OrderService } from '../order/order.service';
import { assertClaimTransition } from './claim-status.machine';

@Injectable()
export class ClaimsService {
  constructor(
    @InjectRepository(Claim) private readonly claimRepo: Repository<Claim>,
    private readonly orderService: OrderService,
  ) {}

  async create(
    createClaimDto: CreateClaimDto,
    distributorId: string | null = null,
  ): Promise<Claim> {
    // Con distribuidora en contexto, el pedido de otra no existe.
    await this.orderService.assertDeLaDistribuidora(
      createClaimDto.orderId,
      distributorId,
    );
    const order = await this.orderService.findOne(createClaimDto.orderId);

    if (order.customerId !== createClaimDto.customerId) {
      throw new BadRequestException(
        'Esta orden no pertenece al cliente indicado',
      );
    }

    // El `distributor_id` del reclamo se denormaliza desde la orden asociada:
    // el cliente no elige distribuidora acá, hereda la del pedido reclamado.
    const claim = this.claimRepo.create({
      orderId: createClaimDto.orderId,
      customerId: createClaimDto.customerId,
      distributorId: order.distributorId,
      reason: createClaimDto.reason,
      description: createClaimDto.description,
      photoUrl: createClaimDto.photoUrl,
    });

    return await this.claimRepo.save(claim);
  }

  async findAll(distributorId?: string | null): Promise<Claim[]> {
    const where: FindOptionsWhere<Claim> = {};
    if (distributorId) where.distributorId = distributorId;

    return await this.claimRepo.find({
      where,
      order: { createdAt: 'DESC' },
      // Historial: el chofer, el cliente o la dirección dados de baja siguen
      // apareciendo en lo que ya pasó (H-74).
      withDeleted: true,
      relations: ['order', 'customer'],
    });
  }

  /**
   * `distributorId` opcional: si viene, el reclamo debe pertenecer a ese
   * tenant (evita que un admin lea/resuelva reclamos de otra distribuidora).
   */
  async findOne(id: string, distributorId?: string | null): Promise<Claim> {
    const where: FindOptionsWhere<Claim> = { claimId: id };
    if (distributorId) where.distributorId = distributorId;

    const claim = await this.claimRepo.findOne({ where });
    if (!claim) throw new NotFoundException('Reclamo no encontrado');

    return claim;
  }

  /**
   * Lee el reclamo con lock pesimista (`FOR UPDATE`), aplica el cambio y lo
   * guarda, todo en una transacción: dos admins que resuelven, toman o
   * reabren el mismo reclamo a la vez se serializan, y el segundo valida la
   * transición contra el estado que dejó el primero (no contra una lectura
   * vieja) en lugar de pisarle la nota.
   */
  private modificar(
    id: string,
    distributorId: string | null | undefined,
    aplicar: (claim: Claim) => void,
  ): Promise<Claim> {
    return this.claimRepo.manager.transaction(async (manager) => {
      const consulta = manager
        .createQueryBuilder(Claim, 'claim')
        .setLock('pessimistic_write')
        .where('claim.claimId = :id', { id });
      if (distributorId) {
        consulta.andWhere('claim.distributorId = :distributorId', {
          distributorId,
        });
      }
      const claim = await consulta.getOne();
      if (!claim) throw new NotFoundException('Reclamo no encontrado');

      aplicar(claim);
      return manager.save(claim);
    });
  }

  async resolve(
    id: string,
    resolution: string,
    status: ClaimStatus,
    distributorId?: string | null,
  ): Promise<Claim> {
    // Máquina de estados: un reclamo RESOLVED/REJECTED no se "re-resuelve" de
    // taquito, hay que reabrirlo primero (`reopen`).
    return this.modificar(id, distributorId, (claim) => {
      assertClaimTransition(claim.status, status);
      claim.resolutionNote = resolution;
      claim.status = status;
    });
  }

  /**
   * El admin toma un reclamo pendiente para empezar a revisarlo. A diferencia
   * de `resolve`, no exige nota: es sólo marcar que alguien ya lo está mirando.
   */
  async take(id: string, distributorId?: string | null): Promise<Claim> {
    return this.modificar(id, distributorId, (claim) => {
      if (claim.status !== ClaimStatus.PENDING) {
        throw new BadRequestException(
          'Sólo se puede tomar un reclamo pendiente',
        );
      }
      assertClaimTransition(claim.status, ClaimStatus.IN_PROCESS);
      claim.status = ClaimStatus.IN_PROCESS;
    });
  }

  /**
   * Reabre un reclamo ya resuelto o rechazado (error del admin, el cliente
   * aportó datos nuevos, etc.). Vuelve a IN_PROCESS, nunca a PENDING: alguien
   * ya lo había tomado. Exige el motivo de la reapertura, que pisa la nota de
   * resolución anterior (el historial completo queda en la auditoría).
   */
  async reopen(
    id: string,
    reason: string,
    distributorId?: string | null,
  ): Promise<Claim> {
    return this.modificar(id, distributorId, (claim) => {
      if (
        claim.status !== ClaimStatus.RESOLVED &&
        claim.status !== ClaimStatus.REJECTED
      ) {
        throw new BadRequestException(
          'Sólo se puede reabrir un reclamo resuelto o rechazado',
        );
      }
      assertClaimTransition(claim.status, ClaimStatus.IN_PROCESS);
      claim.status = ClaimStatus.IN_PROCESS;
      claim.resolutionNote = reason;
    });
  }
}
