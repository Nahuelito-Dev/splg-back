import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Employee } from './entities/employee.entity';

/**
 * Una precondición que otro módulo le suma a una operación sobre el legajo:
 * devuelve los motivos por los que NO se puede (lista vacía = se puede).
 * Corre dentro de la transacción de la operación.
 */
export type EmployeeRule = (
  manager: EntityManager,
  empleado: Employee,
) => Promise<string[]>;

/**
 * Punto de extensión del egreso (CU-181) y de la baja de un legajo (CU-178):
 * cargas de camión abiertas, rendiciones pendientes, jornadas o documentación
 * cargada. Cada módulo dueño registra la suya en `onModuleInit` y `employee`
 * no depende de ninguno (mismo patrón que `AttachmentOwnerRegistry`).
 */
@Injectable()
export class EmployeeRulesRegistry {
  private readonly egreso: EmployeeRule[] = [];
  private readonly baja: EmployeeRule[] = [];

  alEgresar(regla: EmployeeRule): void {
    this.egreso.push(regla);
  }

  alDarDeBaja(regla: EmployeeRule): void {
    this.baja.push(regla);
  }

  motivosQueImpidenElEgreso(
    manager: EntityManager,
    empleado: Employee,
  ): Promise<string[]> {
    return this.correr(this.egreso, manager, empleado);
  }

  motivosQueImpidenLaBaja(
    manager: EntityManager,
    empleado: Employee,
  ): Promise<string[]> {
    return this.correr(this.baja, manager, empleado);
  }

  private async correr(
    reglas: EmployeeRule[],
    manager: EntityManager,
    empleado: Employee,
  ): Promise<string[]> {
    const motivos: string[] = [];
    for (const regla of reglas) {
      motivos.push(...(await regla(manager, empleado)));
    }
    return motivos;
  }
}
