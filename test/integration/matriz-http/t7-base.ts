import { DataSource } from 'typeorm';
import { CashBox } from '../../../src/cash/entities/cash-box.entity';
import { CashBoxKind } from '../../../src/cash/domain/cash.enums';
import { Car } from '../../../src/car/entities/car.entity';
import { Insurer } from '../../../src/insurance/entities/insurer.entity';
import { InsuranceInstallment } from '../../../src/insurance/entities/insurance-installment.entity';
import { InsurancePolicy } from '../../../src/insurance/entities/insurance-policy.entity';
import { InstallmentStatus } from '../../../src/insurance/domain/insurance.enums';
import {
  MaintenanceCriticality,
  MaintenanceDocumentKind,
  MaintenancePlan,
  MaintenanceSubject,
  MaintenanceTrigger,
} from '../../../src/fleet/entities/maintenance-plan.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from '../../../src/fleet/entities/maintenance-task.entity';
import { patenteDePrueba, TestEnv } from '../setup/test-env';
import { reiniciarCuposDelThrottler, sembrarEscenario } from './matriz';
import { EscenarioT2, sembrarBaseT2 } from './t2-base';

/** Escenario compartido de T7: dos vehículos y dos aseguradoras aislados por tenant. */
export interface EscenarioT7 extends EscenarioT2 {
  autoA: string;
  autoB: string;
  aseguradoraA: string;
  aseguradoraB: string;
  aseguradoraPolizaA: string;
  aseguradoraPolizaB: string;
  planA: string;
  planB: string;
  tareaA: string;
  tareaB: string;
  polizaA: string;
  polizaB: string;
  cuotaA: string;
  cuotaB: string;
  /** Caja bancaria de A: admite los egresos de las mutaciones v2. */
  cajaA: string;
  env: TestEnv;
}

export async function sembrarBaseT7(env: TestEnv): Promise<EscenarioT7> {
  const base = await sembrarBaseT2(env.app, await sembrarEscenario(env.app));
  const ds = env.app.get(DataSource);
  const auto = async (distributorId: string, userId: string) =>
    (
      await ds.getRepository(Car).save({
        distributorId,
        userId,
        carPatent: patenteDePrueba(),
        typeCar: 'Camioneta',
      } as Partial<Car>)
    ).carId;
  const aseguradora = async (distributorId: string, name: string) =>
    (
      await ds.getRepository(Insurer).save({
        distributorId,
        name,
      } as Partial<Insurer>)
    ).insurerId;

  const autoA = await auto(base.distA.id, base.choferA.userId);
  const autoB = await auto(base.distB.id, base.choferB.userId);
  const aseguradoraA = await aseguradora(base.distA.id, 'Seguros T7 A');
  const aseguradoraB = await aseguradora(base.distB.id, 'Seguros T7 B');
  const aseguradoraPolizaA = await aseguradora(base.distA.id, 'Pólizas T7 A');
  const aseguradoraPolizaB = await aseguradora(base.distB.id, 'Pólizas T7 B');
  const plan = async (distributorId: string, name: string) =>
    (
      await ds.getRepository(MaintenancePlan).save({
        distributorId,
        name,
        subject: MaintenanceSubject.VEHICLE,
        trigger: MaintenanceTrigger.BY_TIME,
        intervalKm: null,
        intervalMonths: 12,
        leadTimeDays: 30,
        criticality: MaintenanceCriticality.NON_BLOCKING,
        carType: null,
        documentKind: MaintenanceDocumentKind.GENERIC,
        appliesToCategories: null,
        isActive: true,
      } as Partial<MaintenancePlan>)
    ).planId;
  const planA = await plan(base.distA.id, 'Plan T7 A');
  const planB = await plan(base.distB.id, 'Plan T7 B');
  const tarea = async (distributorId: string, planId: string, carId: string) =>
    (
      await ds.getRepository(MaintenanceTask).save({
        distributorId,
        planId,
        carId,
        deliveryId: null,
        employeeId: null,
        status: MaintenanceTaskStatus.FORECAST,
        validFrom: null,
        dueAt: new Date('2030-01-01T00:00:00.000Z'),
        dueKm: null,
        predictedDueAt: null,
        scheduledAt: null,
        performedAt: null,
        odometerKm: null,
        cost: null,
        cashMovementId: null,
        paidAt: null,
        paidAmount: null,
        provider: null,
        referenceNumber: null,
        category: null,
        alertedAt: null,
        notes: null,
        details: null,
      } as Partial<MaintenanceTask>)
    ).taskId;
  const tareaA = await tarea(base.distA.id, planA, autoA);
  const tareaB = await tarea(base.distB.id, planB, autoB);
  const poliza = async (
    distributorId: string,
    carId: string,
    insurerId: string,
    policyNumber: string,
  ) =>
    (
      await ds.getRepository(InsurancePolicy).save({
        distributorId,
        carId,
        insurerId,
        policyNumber,
        coverage: 'Todo riesgo T7',
        validFrom: '2026-01-01',
        validTo: '2030-01-01',
        paymentCode: null,
        cancelledAt: null,
        cancelReason: null,
        fleetTaskId: null,
        fleetClosedTasks: [],
        fleetPending: false,
      } as Partial<InsurancePolicy>)
    ).policyId;
  const polizaA = await poliza(
    base.distA.id,
    autoA,
    aseguradoraPolizaA,
    'T7-A-001',
  );
  const polizaB = await poliza(
    base.distB.id,
    autoB,
    aseguradoraPolizaB,
    'T7-B-001',
  );
  const cuota = async (distributorId: string, policyId: string) =>
    (
      await ds.getRepository(InsuranceInstallment).save({
        distributorId,
        policyId,
        number: 1,
        total: 1,
        dueDate: '2027-01-01',
        graceUntil: '2027-01-06',
        amount: 1000,
        status: InstallmentStatus.PENDING,
        paidAt: null,
        paidAmount: null,
        operationNumber: null,
        paidByUserId: null,
        cashMovementId: null,
        receiptAttachmentId: null,
      } as Partial<InsuranceInstallment>)
    ).installmentId;
  const cuotaA = await cuota(base.distA.id, polizaA);
  const cuotaB = await cuota(base.distB.id, polizaB);
  const cajaA = (
    await ds.getRepository(CashBox).save({
      distributorId: base.distA.id,
      name: 'Banco T7 A',
      kind: CashBoxKind.BANK,
      requiresSession: false,
      isActive: true,
    } as Partial<CashBox>)
  ).cashBoxId;

  return {
    ...base,
    env,
    autoA,
    autoB,
    aseguradoraA,
    aseguradoraB,
    aseguradoraPolizaA,
    aseguradoraPolizaB,
    planA,
    planB,
    tareaA,
    tareaB,
    polizaA,
    polizaB,
    cuotaA,
    cuotaB,
    cajaA,
    reiniciarCupos: () => reiniciarCuposDelThrottler(env),
  };
}
