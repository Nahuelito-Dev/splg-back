import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

    const claim = this.claimRepo.create({
      order_id: createClaimDto.orderId,
      customer_id: createClaimDto.customerId,
      reason: createClaimDto.reason,
      description: createClaimDto.description,
      photoUrl: createClaimDto.photoUrl,
    });

    return await this.claimRepo.save(claim);
  }

  async findAll() {
    return await this.claimRepo.find({
      order: { createdAt: 'DESC' },
      relations: ['order', 'customer'],
    });
  }

  async resolve(id: string, resolution: string, status: ClaimStatus) {
    const claim = await this.claimRepo.findOne({ where: { claim_id: id } });
    if (!claim) throw new NotFoundException('Reclamo no encontrado');

    claim.resolutionNote = resolution;
    claim.status = status;

    return await this.claimRepo.save(claim);
  }
}
