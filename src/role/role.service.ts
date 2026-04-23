import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from './entities/role.entity';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

@Injectable()
export class RoleService {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
  ) {}

  async create(createRoleDto: CreateRoleDto) {
    const role = this.roleRepository.create(createRoleDto);
    return await this.roleRepository.save(role);
  }

  async findAll() {
    return await this.roleRepository.find();
  }

  async findOne(id: string) {
    const role = await this.roleRepository.findOne({
      where: { role_id: id },
    });

    if (!role) {
      throw new NotFoundException(`Role with ID: ${id} not found`);
    }

    return role;
  }

  async update(id: string, updateRoleDto: UpdateRoleDto) {
    const role = await this.roleRepository.preload({
      role_id: id,
      ...updateRoleDto,
    });

    if (!role) {
      throw new NotFoundException(`Role with ID: ${id} not found`);
    }

    return await this.roleRepository.save(role);
  }

  async remove(id: string) {
    const role = await this.findOne(id);
    await this.roleRepository.remove(role);
    return { message: 'Role deleted successfully' };
  }

  async findByType(type: string) {
    const role = await this.roleRepository.findOne({
      where: { type },
    });
    return role;
  }

  async seedRoles() {
    const roles = ['customer', 'delivery', 'admin', 'super_admin'];

    for (const roleType of roles) {
      const existingRole = await this.findByType(roleType);
      if (!existingRole) {
        await this.create({ type: roleType });
      }
    }

    return { message: 'Roles seeded successfully' };
  }
}
