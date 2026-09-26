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
   * cliente falla con "Customer role not found".
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
    return await this.roleRepository.save(role);
  }

  async findAll(): Promise<Role[]> {
    return await this.roleRepository.find();
  }

  async findOne(id: string): Promise<Role> {
    const role = await this.roleRepository.findOne({
      where: { roleId: id },
    });

    if (!role) {
      throw new NotFoundException(`Role with ID: ${id} not found`);
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
      throw new NotFoundException(`Role with ID: ${id} not found`);
    }

    return await this.roleRepository.save(role);
  }

  async remove(id: string): Promise<MessageResponseDto> {
    const role = await this.findOne(id);
    this.assertNoEsDelSistema(role.type, 'borrar');

    try {
      await this.roleRepository.remove(role);
    } catch (error) {
      // Borrar un rol que todavia tiene usuarios violaba la clave foranea y
      // salia un 500 sin explicacion. Ahora es un 409 que dice cual es el
      // problema.
      traducirErrorDeBase(error, this.logger, 'roles');
    }
    return MessageResponseDto.of('Role deleted successfully');
  }

  private assertNoEsDelSistema(tipo: string, accion: string): void {
    if (RoleService.ROLES_DEL_SISTEMA.includes(tipo)) {
      throw new ConflictException(
        `El rol '${tipo}' es parte del sistema y no se puede ${accion}: ` +
          'el codigo lo busca por ese nombre y cambiarlo deja sin funcionar ' +
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

    return MessageResponseDto.of('Roles seeded successfully');
  }
}
