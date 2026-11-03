import { MENSAJE_FALTA_DISTRIBUIDORA } from '../common/decorators/current-distributor.decorator';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, IsNull, Not } from 'typeorm';
import { Admin } from './entities/admin.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { CreateAdminDto } from './dto/create-admin.dto';
import { isUUID } from 'class-validator';
import { UsersService } from '../users/users.service';
import { RoleService } from '../role/role.service';
import { normalizarEmail } from '../common/utils/email.util';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { MessageResponseDto } from '../common/dtos/message-response.dto';

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
  async create(
    createAdminDto: CreateAdminDto,
    distribuidoraElegida: string | null = null,
  ): Promise<Admin> {
    const { user_id, distributor_id } = createAdminDto;
    const usuario = await this.usersService.findById(user_id);
    if (!usuario) {
      throw new NotFoundException('Usuario no encontrado');
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
    // Como el resto de las escrituras del super administrador sobre cuentas de
    // una empresa: la distribuidora sale del contexto elegido (X-Distributor), no
    // sólo del cuerpo.
    if (esAdminDeEmpresa) {
      if (!distribuidoraElegida) {
        throw new BadRequestException(MENSAJE_FALTA_DISTRIBUIDORA);
      }
      if (distributor_id !== distribuidoraElegida) {
        throw new BadRequestException(
          'La distribuidora del perfil no coincide con la elegida (X-Distributor)',
        );
      }
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
   * Lista admins (los dados de baja no aparecen). Scopeado por tenant: si viene `distributorId` (admin de
   * distribuidora, o super_admin con "ver como") devuelve solo los de esa
   * empresa; sin él (super_admin cross-tenant) devuelve todos.
   */
  async findAll(distributorId?: string | null): Promise<Admin[]> {
    return await this.adminRepository.find({
      where: {
        ...(distributorId ? { distributorId } : {}),
        user: { userId: Not(IsNull()) },
      },
      relations: ['user', 'user.role', 'distributor'],
    });
  }

  /**
   * Correos de los administradores en actividad de una distribuidora: perfil de
   * admin de ella, usuario no bloqueado ni dado de baja y con correo cargado.
   * El super admin no entra: no es de ninguna distribuidora.
   */
  async emailsDeAdminsActivos(distributorId: string): Promise<string[]> {
    const admins = await this.adminRepository
      .createQueryBuilder('a')
      .innerJoinAndSelect('a.user', 'u')
      .innerJoin('u.role', 'r')
      .where('a.distributorId = :distributorId', { distributorId })
      .andWhere('u.blocked = false')
      .andWhere('u.deletedAt IS NULL')
      .andWhere('u.email IS NOT NULL')
      .andWhere('r.type = :tipo', { tipo: RoleType.ADMIN })
      .getMany();
    return [
      ...new Set(admins.flatMap((a) => (a.user.email ? [a.user.email] : []))),
    ];
  }

  async findOne(id: string): Promise<Admin> {
    const admin = await this.adminRepository.findOne({
      where: { adminId: id },
      relations: ['user', 'user.role'],
    });

    if (!admin) {
      throw new NotFoundException('Administrador no encontrado');
    }

    return admin;
  }

  /**
   * Ficha del administrador (con usuario, rol y distribuidora). Con
   * distribuidora en contexto sólo encuentra a los de ella: los de otra, los
   * super admin y los dados de baja responden 404.
   */
  async findDetail(
    id: string,
    distributorId: string | null = null,
  ): Promise<Admin> {
    const admin = await this.adminRepository.findOne({
      where: {
        adminId: id,
        ...(distributorId ? { distributorId } : {}),
        user: { userId: Not(IsNull()) },
      },
      relations: ['user', 'user.role', 'distributor'],
    });
    if (!admin) {
      throw new NotFoundException('Administrador no encontrado');
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
      throw new NotFoundException('Administrador no encontrado');
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
      throw new NotFoundException('Administrador no encontrado');
    }

    return admin;
  }

  /**
   * Edita los datos de la persona del administrador (nombre y teléfono). El
   * correo no: es su identidad de acceso y cambia por `POST /email/change-email`.
   * Con distribuidora en contexto sólo encuentra a los de ella (404).
   */
  async update(
    id: string,
    dto: UpdateAdminDto,
    distributorId: string | null,
  ): Promise<Admin> {
    const admin = await this.findDetail(id, distributorId);
    await this.usersService.update(admin.userId, {
      full_name: dto.fullName,
      phone_number: dto.phoneNumber,
    });
    return this.findDetail(id, distributorId);
  }

  /**
   * Baja lógica del administrador: es la baja del usuario (`UsersService.remove`:
   * `deletedAt`, cuenta de acceso deshabilitada, nada se borra), con su regla
   * de no dejar a la distribuidora ni a la plataforma sin administrador activo (409).
   */
  async remove(
    id: string,
    distributorId: string | null,
  ): Promise<MessageResponseDto> {
    const admin = await this.findDetail(id, distributorId);
    return this.usersService.remove(admin.userId);
  }
}
