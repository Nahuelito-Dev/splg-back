import { DepositoConUbicacion } from '../application/warehouse.service';
import { WarehouseDetailDto, WarehouseResponseDto } from '../dto/warehouse.dto';
import { StockBalanceDto } from '../dto/stock-response.dto';

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
}
