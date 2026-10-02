import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Admin } from './entities/admin.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { CreateAdminDto } from './dto/create-admin.dto';
import { isUUID } from 'class-validator';
import { UsersService } from '../users/users.service';
import { RoleService } from '../role/role.service';
import { normalizarEmail } from '../common/utils/email.util';

@Injectable()
export class AdminService {
  private readonly logger = new Logger('AdminService');

  constructor(
    @InjectRepository(Admin)
    private readonly adminRepository: Repository<Admin>,
    private readonly usersService: UsersService,
    private readonly roleService: RoleService,
  ) {}

  /**
   * El perfil de administrador de un usuario recién creado, dentro de la
   * transacción del alta (RegistroService). `distributorId` en null sólo
   * para el super administrador.
   */
  async crearPerfil(
    manager: EntityManager,
    userId: string,
    distributorId: string | null,
  ): Promise<void> {
    const repo = manager.getRepository(Admin);
    await repo.save(repo.create({ userId, distributorId }));
  }

  /** Si ya hay algún super administrador (el comando de arranque crea el primero). */
  async existeSuperAdmin(): Promise<boolean> {
    const cantidad = await this.adminRepository.count({
      where: { user: { role: { type: RoleType.SUPER_ADMIN } } },
    });
    return cantidad > 0;
  }

  /**
   * Alta directa de un perfil de administrador sobre un usuario existente
   * (sólo el super administrador). El perfil tiene que coincidir con el rol
   * del usuario: sin esta regla, a un cliente o un chofer se le colgaba un
   * perfil de admin de una empresa y pasaba a "pertenecer" a ella.
   */
  async create(createAdminDto: CreateAdminDto): Promise<Admin> {
    const { user_id, distributor_id } = createAdminDto;
    const usuario = await this.usersService.findById(user_id);
    if (!usuario) {
      throw new NotFoundException(`User with ID: ${user_id} not found`);
    }
    const rol = usuario.roleId
      ? await this.roleService.findOne(usuario.roleId)
      : null;
    // `role.type` es texto libre en la base; se compara contra el valor del enum.
    const esAdminDeEmpresa = rol?.type === String(RoleType.ADMIN);
    const esSuperAdmin = rol?.type === String(RoleType.SUPER_ADMIN);
    if (!esAdminDeEmpresa && !esSuperAdmin) {
      throw new BadRequestException(
        'Sólo un usuario con rol admin o super_admin tiene perfil de administrador',
      );
    }
    if (esAdminDeEmpresa !== Boolean(distributor_id)) {
      throw new BadRequestException(
        'Un admin de empresa lleva distribuidora y el super administrador no',
      );
    }
    if (await this.adminRepository.exists({ where: { userId: user_id } })) {
      throw new ConflictException(
        'El usuario ya tiene perfil de administrador',
      );
    }
    const admin = this.adminRepository.create({
      userId: user_id,
      distributorId: distributor_id ?? null,
    });
    return await this.adminRepository.save(admin);
  }

  /**
   * Lista admins. Scopeado por tenant: si viene `distributorId` (admin de
   * distribuidora, o super_admin con "ver como") devuelve solo los de esa
   * empresa; sin él (super_admin cross-tenant) devuelve todos.
   */
  async findAll(distributorId?: string | null): Promise<Admin[]> {
    return await this.adminRepository.find({
      where: distributorId ? { distributorId } : {},
      relations: ['user', 'user.role', 'distributor'],
    });
  }

  async findOne(id: string): Promise<Admin> {
    const admin = await this.adminRepository.findOne({
      where: { adminId: id },
      relations: ['user', 'user.role'],
    });

    if (!admin) {
      throw new NotFoundException(`Admin with ID: ${id} not found`);
    }

    return admin;
  }

  async findOneByEmail(email: string): Promise<Admin> {
    const admin = await this.adminRepository
      .createQueryBuilder('admin')
      .leftJoinAndSelect('admin.user', 'user')
      .leftJoinAndSelect('user.role', 'role')
      .where('LOWER(user.email) = :email', { email: normalizarEmail(email) })
      .getOne();

    if (!admin) {
      throw new NotFoundException(`Admin with email: ${email} not found`);
    }

    return admin;
  }

  /**
   * Con distribuidora en contexto sólo encuentra a los admins de ella: los de
   * otra, y los super admin, responden 404.
   */
  async findAdminByTerm(
    term: string,
    distributorId: string | null = null,
  ): Promise<Admin> {
    this.logger.debug(`🔍 Buscando admin con term: ${term}`);

    const queryBuilder = this.adminRepository
      .createQueryBuilder('admin')
      .leftJoinAndSelect('admin.user', 'user')
      .leftJoinAndSelect('user.role', 'role');

    const admin = isUUID(term)
      ? await queryBuilder
          .where('admin.adminId = :admin_id', { admin_id: term })
          .getOne()
      : await queryBuilder
          .where('LOWER(user.email) = :email', {
            email: normalizarEmail(term),
          })
          .getOne();

    if (!admin || (distributorId && admin.distributorId !== distributorId)) {
      throw new NotFoundException(`Admin with ${term} not found`);
    }

    return admin;
  }
}
