import { Injectable, NotFoundException } from '@nestjs/common';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { DeliveryService } from '../delivery/delivery.service';
import { EmployeeService } from '../employee/employee.service';

/**
 * Quién es el chofer detrás de una cuenta y qué vehículo tiene en uso: lo que
 * necesitan las cargas de combustible y los siniestros que registra el propio
 * chofer (`/mine`), y la deducción del responsable de una multa o un siniestro.
 */
@Injectable()
export class DriverContextService {
  constructor(
    private readonly deliveries: DeliveryService,
    private readonly assignments: VehicleAssignmentService,
    private readonly employees: EmployeeService,
  ) {}

  /** El vehículo que el chofer tiene en uso, o 404 «No tenés un vehículo en uso». */
  async vehiculoEnUso(userId: string, distributorId: string): Promise<string> {
    const [perfil] = await this.deliveries.findDeliveryIdsByUserIds(
      [userId],
      distributorId,
    );
    if (perfil) {
      const [vehiculo] =
        await this.assignments.findVehiculosEnUsoPorDeliveryIds(
          [perfil.deliveryId],
          distributorId,
        );
      if (vehiculo) return vehiculo.carId;
    }
    throw new NotFoundException('No tenés un vehículo en uso');
  }

  /** El legajo vigente de esa cuenta, o `null` si no tiene. */
  async legajoDe(
    userId: string,
    distributorId: string,
  ): Promise<string | null> {
    const empleado = await this.employees.findByUserIdEnDistribuidora(
      userId,
      distributorId,
    );
    return empleado?.employeeId ?? null;
  }

  /**
   * El legajo del chofer que tenía el vehículo en uso en el instante `en`, o
   * `null` si nadie lo tenía o ese chofer ya no tiene legajo vigente.
   */
  async legajoDelVehiculoEn(
    carId: string,
    distributorId: string,
    en: Date,
  ): Promise<string | null> {
    const deliveryId = await this.assignments.choferDelVehiculoEn(
      carId,
      distributorId,
      en,
    );
    if (!deliveryId) return null;
    try {
      const chofer = await this.deliveries.findOne(deliveryId);
      return await this.legajoDe(chofer.userId, distributorId);
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  /** 404 si el legajo no existe o es de otra distribuidora. */
  async assertLegajoDeLaDistribuidora(
    employeeId: string,
    distributorId: string,
  ): Promise<void> {
    await this.employees.findOne(employeeId, distributorId);
  }
}
