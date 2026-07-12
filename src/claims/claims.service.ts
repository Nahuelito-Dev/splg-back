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

  async create(createClaimDto: CreateClaimDto) {
    const order = await this.orderService.findOne(createClaimDto.orderId);
    if (!order) throw new NotFoundException('Orden no encontrada');

    if (order.customer_id !== createClaimDto.customerId) {
      throw new BadRequestException(
        'Esta orden no pertenece al cliente indicado',
      );
    }

    // El `distributor_id` del reclamo se denormaliza desde la orden asociada:
    // el cliente no elige distribuidora acá, hereda la del pedido reclamado.
    const claim = this.claimRepo.create({
      order_id: createClaimDto.orderId,
      customer_id: createClaimDto.customerId,
      distributor_id: order.distributor_id,
      reason: createClaimDto.reason,
      description: createClaimDto.description,
      photoUrl: createClaimDto.photoUrl,
    });

    return await this.claimRepo.save(claim);
  }

  async findAll(distributorId?: string | null) {
    const where: FindOptionsWhere<Claim> = {};
    if (distributorId) where.distributor_id = distributorId;

    return await this.claimRepo.find({
      where,
      order: { createdAt: 'DESC' },
      relations: ['order', 'customer'],
    });
  }

  /**
   * `distributorId` opcional: si viene, el reclamo debe pertenecer a ese
   * tenant (evita que un admin lea/resuelva reclamos de otra distribuidora).
   */
  async findOne(id: string, distributorId?: string | null) {
    const where: FindOptionsWhere<Claim> = { claim_id: id };
    if (distributorId) where.distributor_id = distributorId;

    const claim = await this.claimRepo.findOne({ where });
    if (!claim) throw new NotFoundException('Reclamo no encontrado');

    return claim;
  }

  async resolve(
    id: string,
    resolution: string,
    status: ClaimStatus,
    distributorId?: string | null,
  ) {
    // Verifica pertenencia al tenant antes de resolver.
    const claim = await this.findOne(id, distributorId);

    claim.resolutionNote = resolution;
    claim.status = status;

    return await this.claimRepo.save(claim);
  }
}
