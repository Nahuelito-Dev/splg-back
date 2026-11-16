import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Employee } from './entities/employee.entity';
import { AttachmentOwnerRegistry } from '../attachment/attachment-owner.registry';
import { AttachmentOwnerResolver } from '../attachment/ports/attachment-owner-resolver.port';
import { AttachmentOwnerType } from '../attachment/entities/attachment.entity';

/** Dueño `employee` de los adjuntos del legajo (`/attachments/employee/:id`). */
@Injectable()
export class EmployeeAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.EMPLOYEE;

  constructor(
    @InjectRepository(Employee)
    private readonly employees: Repository<Employee>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.employees.exists({
      where: { employeeId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException('Empleado no encontrado');
    }
  }
}
