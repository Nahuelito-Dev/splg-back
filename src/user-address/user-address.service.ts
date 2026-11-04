import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Not, Repository } from 'typeorm';
import { UserAddress } from './entities/user-address.entity';
import { CreateUserAddressDto } from './dto/create-user-address.dto';
import { UpdateUserAddressDto } from './dto/update-user-address.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { UsersService } from '../users/users.service';
import { puntoDesdeCoordenadas } from '../common/geo/punto';
import { DireccionBorradaDto } from './dto/user-address-listado.dto';

@Injectable()
export class UserAddressService {
  constructor(
    @InjectRepository(UserAddress)
    private readonly userAddressRepository: Repository<UserAddress>,

    private readonly usersService: UsersService,
  ) {}

  /**
   * Enforcement de ownership (anti-IDOR): si `requesterUserId` viene (rol NO
   * admin), el dueño de la dirección debe ser ese usuario; si no, 403. Los
   * admins pasan `undefined`/`null` y saltan el check.
   */
  private assertOwnership(
    ownerUserId: string,
    requesterUserId?: string | null,
  ): void {
    if (requesterUserId && ownerUserId !== requesterUserId) {
      throw new ForbiddenException(
        'No autorizado a acceder a direcciones de otro usuario',
      );
    }
  }

  async create(
    createUserAddressDto: CreateUserAddressDto,
    requesterUserId?: string | null,
  ): Promise<UserAddress> {
    // Un cliente solo puede crear direcciones PARA SÍ MISMO: el dueño es el de
    // su token. Si además manda un `user_id` y es el de otro, es un error (no
    // se ignora en silencio).
    let dueño = createUserAddressDto.user_id;
    if (requesterUserId) {
      if (dueño && dueño.toLowerCase() !== requesterUserId.toLowerCase()) {
        throw new ForbiddenException(
          'No podés crear direcciones para otro usuario',
        );
      }
      dueño = requesterUserId;
    }
    if (!dueño) {
      throw new BadRequestException(
        'Usuario: indicá el usuario dueño de la dirección',
      );
    }

    const user = await this.usersService.findById(dueño);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (createUserAddressDto.isDefault) {
      await this.removeDefaultFromOtherAddresses(dueño);
    }

    // Sin `user_id`: la entidad lo lleva en camelCase y volcarlo con el resto
    // lo perdería en silencio.
    const { latitude, longitude, user_id, ...campos } = createUserAddressDto;
    void user_id; // el dueño ya se resolvió arriba (`dueño`)
    const address = this.userAddressRepository.create({
      ...campos,
      userId: dueño,
      location: puntoDesdeCoordenadas(latitude, longitude),
    });
    return await this.userAddressRepository.save(address);
  }

  async findAll(paginationDto: PaginationDto): Promise<{
    addresses: UserAddress[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const { limit = 10, offset = 0 } = paginationDto;

    const [addresses, total] = await this.userAddressRepository.findAndCount({
      take: limit,
      skip: offset,
      relations: ['user'],
      order: { isDefault: 'DESC', createdAt: 'DESC' },
    });

    return {
      addresses,
      total,
      limit,
      offset,
    };
  }

  /** La dirección si es de ese usuario, o null. Para validar un pedido. */
  buscarDelUsuario(
    addressId: string,
    userId: string,
  ): Promise<UserAddress | null> {
    return this.userAddressRepository.findOne({
      where: { addressId, userId },
    });
  }

  /**
   * Aislamiento entre distribuidoras: el dueño de la dirección tiene que ser
   * usuario de la distribuidora en contexto (para un cliente, que le haya
   * comprado). Si no, 404.
   */
  async assertDeLaDistribuidora(
    ref: { userId: string } | { addressId: string },
    distributorId: string,
  ): Promise<void> {
    let userId: string;
    if ('userId' in ref) {
      userId = ref.userId;
    } else {
      const direccion = await this.userAddressRepository.findOne({
        where: { addressId: ref.addressId },
      });
      if (!direccion) return; // el servicio responde el 404 de siempre
      userId = direccion.userId;
    }
    if (!(await this.usersService.perteneceA(userId, distributorId))) {
      throw new NotFoundException('Dirección no encontrada');
    }
  }

  async findOne(
    id: string,
    requesterUserId?: string | null,
  ): Promise<UserAddress> {
    const address = await this.userAddressRepository.findOne({
      where: { addressId: id },
      relations: ['user'],
    });

    if (!address) {
      throw new NotFoundException('Dirección no encontrada');
    }

    this.assertOwnership(address.userId, requesterUserId);
    return address;
  }

  async findByUserId(
    userId: string,
    requesterUserId?: string | null,
  ): Promise<UserAddress[]> {
    this.assertOwnership(userId, requesterUserId);
    const addresses = await this.userAddressRepository.find({
      where: { userId },
      relations: ['user'],
      order: { isDefault: 'DESC', createdAt: 'DESC' },
    });

    return addresses;
  }

  async findDefaultByUserId(
    userId: string,
    requesterUserId?: string | null,
  ): Promise<UserAddress> {
    this.assertOwnership(userId, requesterUserId);
    const address = await this.userAddressRepository.findOne({
      where: { userId, isDefault: true },
      relations: ['user'],
    });

    if (!address) {
      const addresses = await this.findByUserId(userId);
      if (addresses.length > 0) {
        return addresses[0];
      }
      throw new NotFoundException('El usuario no tiene direcciones');
    }

    return address;
  }

  async update(
    id: string,
    updateUserAddressDto: UpdateUserAddressDto,
    requesterUserId?: string | null,
  ): Promise<UserAddress> {
    // Ownership: valida que la dirección sea del que pide (si no es admin).
    const previa = await this.findOne(id, requesterUserId);

    // Latitud y longitud se cambian juntas: son un solo punto.
    const { latitude, longitude, ...campos } = updateUserAddressDto;
    if ((latitude === undefined) !== (longitude === undefined)) {
      throw new BadRequestException('latitude y longitude se cambian juntas');
    }
    const address = await this.userAddressRepository.preload({
      addressId: id,
      ...campos,
      ...(latitude !== undefined &&
        longitude !== undefined && {
          location: puntoDesdeCoordenadas(latitude, longitude),
        }),
    });

    if (!address) {
      throw new NotFoundException('Dirección no encontrada');
    }

    if (updateUserAddressDto.isDefault) {
      await this.removeDefaultFromOtherAddresses(address.userId, id);
    } else if (updateUserAddressDto.isDefault === false && previa.isDefault) {
      // Desmarcar la principal no puede dejar al usuario sin ninguna: pasa a
      // serlo la más reciente de las otras. Si es la única, lo sigue siendo.
      const promovida = await this.promoverOtraPrincipal(
        address.userId,
        id,
        address,
      );
      if (!promovida) address.isDefault = true;
    }

    return await this.userAddressRepository.save(address);
  }

  async remove(
    id: string,
    requesterUserId?: string | null,
  ): Promise<DireccionBorradaDto> {
    const address = await this.findOne(id, requesterUserId);

    if (address.isDefault) {
      await this.promoverOtraPrincipal(address.userId, id, address);
    }

    await this.userAddressRepository.softRemove(address);

    return {
      message: 'Dirección dada de baja',
      addressId: id,
    };
  }

  async setAsDefault(
    id: string,
    requesterUserId?: string | null,
  ): Promise<UserAddress> {
    const address = await this.findOne(id, requesterUserId);
    await this.removeDefaultFromOtherAddresses(address.userId, id);

    address.isDefault = true;
    return await this.userAddressRepository.save(address);
  }

  /**
   * La dirección más reciente del usuario, salvo `exceptId`, pasa a ser la
   * principal. Devuelve false si no hay otra. `soltar` es la principal actual:
   * se desmarca ANTES de promover a la otra, porque la base no admite dos
   * principales a la vez (`UQ_user_address_principal`).
   */
  private async promoverOtraPrincipal(
    userId: string,
    exceptId: string,
    soltar?: UserAddress,
  ): Promise<boolean> {
    const [otra] = await this.userAddressRepository.find({
      where: { userId, addressId: Not(exceptId) },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    if (!otra) return false;
    if (soltar) {
      soltar.isDefault = false;
      await this.userAddressRepository.save(soltar);
    }
    otra.isDefault = true;
    await this.userAddressRepository.save(otra);
    return true;
  }

  private async removeDefaultFromOtherAddresses(
    userId: string,
    excludeAddressId?: string,
  ): Promise<void> {
    const whereClause: FindOptionsWhere<UserAddress> = {
      userId,
      isDefault: true,
    };

    if (excludeAddressId) {
      // TypeORM (Postgres), NO Mongo: usar Not(), no `{ $not: ... }` (rompía
      // con 500 al marcar una dirección como predeterminada).
      whereClause.addressId = Not(excludeAddressId);
    }

    const defaultAddresses = await this.userAddressRepository.find({
      where: whereClause,
    });

    for (const address of defaultAddresses) {
      address.isDefault = false;
      await this.userAddressRepository.save(address);
    }
  }
}
