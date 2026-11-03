import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from './entities/role.entity';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RoleType } from '../common/constants/role-type.enum';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { MessageResponseDto } from '../common/dtos/message-response.dto';

@Injectable()
export class RoleService {
  private readonly logger = new Logger(RoleService.name);

  /**
   * Los cuatro roles que el sistema necesita para funcionar. El codigo los
   * busca por su texto (`findOne({ where: { type: 'customer' } })`), asi que
   * renombrarlos o borrarlos rompe el registro de usuarios: el alta de un
   * cliente falla con "No existe el rol customer: falta correr el seed de roles".
   *
   * Se derivan de RoleType para que haya una sola fuente de verdad: antes esta
   * lista estaba repetida a mano dentro de seedRoles().
   */
  private static readonly ROLES_DEL_SISTEMA: string[] = Object.values(RoleType);

  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
  ) {}

  async create(createRoleDto: CreateRoleDto): Promise<Role> {
    const role = this.roleRepository.create(createRoleDto);
    try {
      return await this.roleRepository.save(role);
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'roles');
    }
  }

  async findAll(): Promise<Role[]> {
    return await this.roleRepository.find();
  }

  async findOne(id: string): Promise<Role> {
    const role = await this.roleRepository.findOne({
      where: { roleId: id },
    });

    if (!role) {
      throw new NotFoundException('Rol no encontrado');
    }

    return role;
  }

  async update(id: string, updateRoleDto: UpdateRoleDto): Promise<Role> {
    const actual = await this.findOne(id);
    this.assertNoEsDelSistema(actual.type, 'modificar');

    const role = await this.roleRepository.preload({
      roleId: id,
      ...updateRoleDto,
    });

    if (!role) {
      throw new NotFoundException('Rol no encontrado');
    }

    return await this.roleRepository.save(role);
  }

  async remove(id: string): Promise<MessageResponseDto> {
    const role = await this.findOne(id);
    this.assertNoEsDelSistema(role.type, 'dar de baja');

    // Baja lógica: la clave foránea ya no frena el borrado de un rol con
    // usuarios, así que se chequea a mano (incluye usuarios dados de baja,
    // que volverían a quedar apuntando a un rol borrado si se restauran).
    const usuarios = await this.roleRepository
      .createQueryBuilder('r')
      .innerJoin('r.users', 'u')
      .withDeleted()
      .where('r.roleId = :id', { id })
      .getCount();
    if (usuarios > 0) {
      throw new ConflictException(
        `El rol '${role.type}' todavía tiene ${usuarios} usuario(s): reasignalos antes de darlo de baja`,
      );
    }

    try {
      await this.roleRepository.softRemove(role);
    } catch (error) {
      traducirErrorDeBase(error, this.logger, 'roles');
    }
    return MessageResponseDto.of('Rol dado de baja');
  }

  private assertNoEsDelSistema(tipo: string, accion: string): void {
    if (RoleService.ROLES_DEL_SISTEMA.includes(tipo)) {
      throw new ConflictException(
        `El rol '${tipo}' es parte del sistema y no se puede ${accion}: ` +
          'el código lo busca por ese nombre y cambiarlo deja sin funcionar ' +
          'el registro de usuarios.',
      );
    }
  }

  findById(id: string): Promise<Role | null> {
    return this.roleRepository.findOne({ where: { roleId: id } });
  }

  findByType(type: string): Promise<Role | null> {
    return this.roleRepository.findOne({ where: { type } });
  }

  async seedRoles(): Promise<MessageResponseDto> {
    const roles = RoleService.ROLES_DEL_SISTEMA;

    for (const roleType of roles) {
      const existingRole = await this.findByType(roleType);
      if (!existingRole) {
        await this.create({ type: roleType });
      }
    }

    return MessageResponseDto.of('Roles cargados');
  }
}
