import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { BankDetailsDto, BankDetailsResponseDto } from './dto/bank-details.dto';
import { Distributor } from './entities/distributor.entity';

/**
 * CBU, alias y titular con que la distribuidora cobra por transferencia. El
 * admin los edita; el cliente los lee a través de su pedido (nunca por id de
 * distribuidora: ve sólo los de la que le vende).
 */
@Injectable()
export class DistributorBankService {
  private readonly logger = new Logger(DistributorBankService.name);

  constructor(
    @InjectRepository(Distributor)
    private readonly distributors: Repository<Distributor>,
  ) {}

  async obtener(distributorId: string): Promise<BankDetailsResponseDto> {
    return aDto(await this.cargar(distributorId));
  }

  /** Reemplaza los tres datos; lo que no viene queda sin cargar. */
  async guardar(
    distributorId: string,
    dto: BankDetailsDto,
  ): Promise<BankDetailsResponseDto> {
    const distributor = await this.cargar(distributorId);
    distributor.bankCbu = dto.cbu ?? null;
    distributor.bankAlias = dto.alias ?? null;
    distributor.bankHolder = dto.holder ?? null;
    try {
      return aDto(await this.distributors.save(distributor));
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'datos bancarios');
    }
  }

  private async cargar(distributorId: string): Promise<Distributor> {
    const distributor = await this.distributors.findOne({
      where: { distributorId },
    });
    if (!distributor) {
      throw new NotFoundException('Distribuidora no encontrada');
    }
    return distributor;
  }
}

function aDto(distributor: Distributor): BankDetailsResponseDto {
  return {
    cbu: distributor.bankCbu,
    alias: distributor.bankAlias,
    holder: distributor.bankHolder,
  };
}
