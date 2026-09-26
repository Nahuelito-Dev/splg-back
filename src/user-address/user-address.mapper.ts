import { coordenadasDePunto } from '../common/geo/punto';
import { UserAddress } from './entities/user-address.entity';
import { UserAddressResponseDto } from './dto/user-address-response.dto';
import { UserAddressConUsuarioDto } from './dto/user-address-listado.dto';
import { UserMapper } from '../users/user.mapper';

export class UserAddressMapper {
  static toDto(address: UserAddress): UserAddressResponseDto {
    const dto = new UserAddressResponseDto();
    dto.address_id = address.address_id;
    dto.user_id = address.user_id;
    dto.street = address.street;
    dto.city = address.city;
    dto.postalCode = address.postalCode;
    const punto = coordenadasDePunto(address.location);
    dto.latitude = punto ? String(punto.lat) : null;
    dto.longitude = punto ? String(punto.lng) : null;
    dto.floor = address.floor;
    dto.apartment = address.apartment;
    dto.placeId = address.placeId;
    dto.geocodePrecision = address.geocodePrecision;
    dto.formattedAddress = address.formattedAddress;
    dto.isDefault = address.isDefault;
    dto.additionalInstructions = address.additionalInstructions;
    dto.createdAt = address.createdAt;
    dto.updatedAt = address.updatedAt;
    return dto;
  }

  /** Con el usuario, si el endpoint lo cargó. */
  static toDtoConUsuario(address: UserAddress): UserAddressConUsuarioDto {
    const dto = Object.assign(
      new UserAddressConUsuarioDto(),
      UserAddressMapper.toDto(address),
    );
    if (address.user) dto.user = UserMapper.toDto(address.user);
    return dto;
  }
}
