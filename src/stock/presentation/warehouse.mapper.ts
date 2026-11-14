import { DepositoConUbicacion } from '../application/warehouse.service';
import {
  WarehouseDetailDto,
  WarehouseResponseDto,
  WarehouseV2DetailDto,
  WarehouseV2ResponseDto,
} from '../dto/warehouse.dto';
import { StockBalanceDto } from '../dto/stock-response.dto';
import { coordenadasDePunto } from '../../common/geo/punto';

export class WarehouseMapper {
  static toDto({
    warehouse,
    locationId,
  }: DepositoConUbicacion): WarehouseResponseDto {
    const dto = new WarehouseResponseDto();
    dto.warehouseId = warehouse.warehouseId;
    dto.locationId = locationId;
    dto.name = warehouse.name;
    dto.code = warehouse.code;
    dto.kind = warehouse.kind;
    dto.address = warehouse.address;
    dto.isDefault = warehouse.isDefault;
    dto.isActive = warehouse.isActive;
    dto.createdAt = warehouse.createdAt;
    dto.updatedAt = warehouse.updatedAt;
    return dto;
  }

  static toDetailDto(
    deposito: DepositoConUbicacion,
    balances: StockBalanceDto[],
  ): WarehouseDetailDto {
    return Object.assign(
      new WarehouseDetailDto(),
      WarehouseMapper.toDto(deposito),
      {
        balances,
      },
    );
  }

  /** v2: lo mismo más la ubicación del depósito (null si no está ubicado). */
  static toV2Dto(deposito: DepositoConUbicacion): WarehouseV2ResponseDto {
    const punto = coordenadasDePunto(deposito.warehouse.location);
    return Object.assign(
      new WarehouseV2ResponseDto(),
      WarehouseMapper.toDto(deposito),
      { latitude: punto?.lat ?? null, longitude: punto?.lng ?? null },
    );
  }

  static toV2DetailDto(
    deposito: DepositoConUbicacion,
    balances: StockBalanceDto[],
  ): WarehouseV2DetailDto {
    return Object.assign(
      new WarehouseV2DetailDto(),
      WarehouseMapper.toV2Dto(deposito),
      { balances },
    );
  }
}
