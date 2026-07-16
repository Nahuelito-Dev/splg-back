import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Admin } from './entities/admin.entity';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UsersService } from '../users/users.service';
import { RegisterAdminDto } from './dto/register-admin.dto';
import * as AdminRegistrationHelper from './helpers/admin-registration.helper';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { isUUID } from 'class-validator';

@Injectable()
export class AdminService {
  private readonly logger = new Logger('AdminService');

  constructor(
    @InjectRepository(Admin)
    private readonly adminRepository: Repository<Admin>,
    private readonly usersService: UsersService,
  ) {}

  // ✅ CORREGIR el tipo del parámetro
  async registerAdmin(registerAdminDto: RegisterAdminDto) {
    this.logger.log('🚀 [CREATE] Iniciando creación de Admin');

    // 1. Validar unicidad
    await AdminRegistrationHelper.validateUniqueness(
      registerAdminDto,
      this.usersService,
    );

    // 2. Crear en Firebase
    const firebaseUser = await AdminRegistrationHelper.createUserInFirebase(
      registerAdminDto,
      this.usersService,
    );

    // 3. Crear en base de datos local
    const user = await AdminRegistrationHelper.createUserInDatabase(
      registerAdminDto,
      firebaseUser.uid,
      this.usersService,
    );

    // 4. Crear entidad Admin (user_id se obtiene del user creado). El
    // distributor_id define el tenant del admin (null = super_admin cross-tenant).
    const adminData: CreateAdminDto = {
      user_id: user.user_id, // ✅ Se obtiene del user recién creado
      role_id: registerAdminDto.role_id,
      distributor_id: registerAdminDto.distributorId,
    };

    const admin = await this.create(adminData);

    this.logger.log(`✅ Admin creado exitosamente: ${admin.admin_id}`);
    return {
      message: 'Admin registered successfully',
      admin,
      user,
    };
  }

  async create(createAdminDto: CreateAdminDto) {
    const admin = this.adminRepository.create(createAdminDto);
    return await this.adminRepository.save(admin);
  }

  /**
   * Lista admins. Scopeado por tenant: si viene `distributorId` (admin de
   * distribuidora, o super_admin con "ver como") devuelve solo los de esa
   * empresa; sin él (super_admin cross-tenant) devuelve todos.
   */
  async findAll(distributorId?: string | null) {
    return await this.adminRepository.find({
      where: distributorId ? { distributor_id: distributorId } : {},
      relations: ['user', 'role', 'distributor'],
    });
  }

  async findOne(id: string) {
    const admin = await this.adminRepository.findOne({
      where: { admin_id: id },
      relations: ['user', 'role'],
    });

    if (!admin) {
      throw new NotFoundException(`Admin with ID: ${id} not found`);
    }

    return admin;
  }

  // ✅ MÉTODO REQUERIDO: Buscar admin por email del usuario
  async findOneByEmail(email: string): Promise<Admin> {
    const admin = await this.adminRepository
      .createQueryBuilder('admin')
      .leftJoinAndSelect('admin.user', 'user')
      .leftJoinAndSelect('admin.role', 'role')
      .where('user.email = :email', { email })
      .getOne();

    if (!admin) {
      throw new NotFoundException(`Admin with email: ${email} not found`);
    }

    return admin;
  }

  async findAdminByTerm(term: string) {
    console.log(`🔍 Buscando admin con term: ${term}`);

    const queryBuilder = this.adminRepository
      .createQueryBuilder('admin')
      .leftJoinAndSelect('admin.user', 'user') // ✅ CORRECTO
      .leftJoinAndSelect('admin.role', 'role'); // ✅ CORRECTO

    const admin = isUUID(term)
      ? await queryBuilder
          .where('admin.admin_id = :admin_id', { admin_id: term })
          .getOne()
      : await queryBuilder
          .where('user.email = :email', { email: term }) // ✅ CORRECTO - busca en user.email
          .getOne();

    console.log(`🔍 Resultado de búsqueda:`, admin);

    if (!admin) throw new NotFoundException(`Admin with ${term} not found`);

    const result = {
      admin_id: admin.admin_id,
      email: admin.user?.email, // ✅ Del User
      displayName: admin.user?.full_name, // ✅ Del User
      fullName: admin.user?.full_name, // ✅ Del User
      rol: admin.role?.type, // ✅ Del Role
      uid: admin.user?.firebase_uid, // ✅ Del User
    };

    console.log(`🔍 Datos formateados:`, result);
    return result;
  }

  async update(id: string, updateAdminDto: UpdateAdminDto) {
    const admin = await this.adminRepository.preload({
      admin_id: id,
      ...updateAdminDto,
    });

    if (!admin) {
      throw new NotFoundException(`Admin with ID: ${id} not found`);
    }

    return await this.adminRepository.save(admin);
  }

  async remove(id: string) {
    const admin = await this.findOne(id);
    await this.adminRepository.delete(id);
    return { message: 'Admin deleted successfully' };
  }
}
