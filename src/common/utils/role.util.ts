// src/utils/role.util.ts
import { Repository } from 'typeorm';
import { Role } from '../../role/entities/role.entity';

export async function findRoleIdByType(
  roleRepo: Repository<Role>,
  type: string,
) {
  const role = await roleRepo.findOne({ where: { type } });
  if (!role) throw new Error(`Role ${type} not found`);
  return role.role_id;
}
