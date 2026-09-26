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

  async resolve(
    id: string,
    resolution: string,
    status: ClaimStatus,
    distributorId?: string | null,
  ): Promise<Claim> {
    // Verifica pertenencia al tenant antes de resolver.
    const claim = await this.findOne(id, distributorId);

    claim.resolutionNote = resolution;
    claim.status = status;

    return await this.claimRepo.save(claim);
  }
}
