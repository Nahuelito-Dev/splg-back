import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import { OrderStatus } from '../../order/entities/order.entity';
import { OrderRecoveryRef } from '../../order/lookup/order-lookup.service';
import { Cylinder, CylinderState } from '../entities/cylinder.entity';
import {
  CylinderRecoveryCase,
  RecoveryCaseStatus,
} from '../entities/cylinder-recovery-case.entity';
import {
  CylinderRecoveryNotice,
  RecoveryNoticeKind,
} from '../entities/cylinder-recovery-notice.entity';

export const DIST = 'dist-1';
export const AHORA = new Date('2026-10-31T12:00:00Z');
export const DIA = 24 * 60 * 60 * 1000;

export const PARAMETROS = {
  toleranceDays: 30,
  escalationStepDays: 7,
  escalationAmountThreshold: 50000,
  pickupOfferTtlHours: 72,
  pickupWindowDays: 7,
  runHour: 10,
  enabled: 1,
};

export function unEnvase(over: Partial<Cylinder> = {}): Cylinder {
  return {
    cylinderId: 'cyl-1',
    distributorId: DIST,
    serial: 'SN-001',
    state: CylinderState.WITH_CUSTOMER,
    currentCustomerId: 'cust-1',
    deposit: 70000,
    ...over,
  } as Cylinder;
}

export function unCaso(
  over: Partial<CylinderRecoveryCase> = {},
): CylinderRecoveryCase {
  return {
    caseId: 'case-1',
    distributorId: DIST,
    cylinderId: 'cyl-1',
    userId: 'cust-1',
    deliveredAt: new Date(AHORA.getTime() - 40 * DIA),
    depositAmount: 70000,
    step: 1,
    status: RecoveryCaseStatus.OPEN,
    stepDueAt: AHORA,
    exhaustedAt: null,
    openedAt: AHORA,
    closedAt: null,
    resolvedByUserId: null,
    resolutionNote: null,
    ...over,
  } as CylinderRecoveryCase;
}

export function unAviso(
  over: Partial<CylinderRecoveryNotice> = {},
): CylinderRecoveryNotice {
  return {
    noticeId: 'n-1',
    caseId: 'case-1',
    step: 1,
    kind: RecoveryNoticeKind.REMINDER,
    status: null,
    orderId: null,
    sentAt: AHORA,
    expiresAt: new Date(AHORA.getTime() + 7 * DIA),
    respondedAt: null,
    responseNote: null,
    ...over,
  } as CylinderRecoveryNotice;
}

export function unaOferta(
  over: Partial<CylinderRecoveryNotice> = {},
): CylinderRecoveryNotice {
  return unAviso({
    noticeId: 'n-oferta',
    kind: RecoveryNoticeKind.PICKUP_OFFER,
    status: ProposalStatus.PENDING,
    orderId: 'ord-1',
    ...over,
  });
}

export function unPedido(
  over: Partial<OrderRecoveryRef> = {},
): OrderRecoveryRef {
  return {
    orderId: 'ord-1',
    customerId: 'cust-1',
    status: OrderStatus.PENDING,
    deliveryId: null,
    scheduledDate: '2026-11-03',
    deliveredAt: null,
    ...over,
  };
}

/**
 * Una "base" en memoria para el motor: el caso, el envase y los avisos. Lo
 * suficiente de `EntityManager` para que `procesarCaso` y las decisiones
 * corran sin Postgres.
 */
export class BaseEnMemoria {
  casos: CylinderRecoveryCase[] = [];
  avisos: CylinderRecoveryNotice[] = [];
  envases: Cylinder[] = [];
  usuarios = [{ userId: 'cust-1', fullName: 'Ana Pérez' }];
  guardados: unknown[] = [];
  private n = 0;

  manager = {
    query: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn((entidad?: unknown) => this.consulta(entidad)),
    getRepository: jest.fn((entidad: unknown) => ({
      findOne: jest.fn(({ where }: { where: Record<string, string> }) => {
        if (entidad === Cylinder) {
          return Promise.resolve(
            this.envases.find((e) => e.cylinderId === where.cylinderId) ?? null,
          );
        }
        return Promise.resolve(
          this.usuarios.find((u) => u.userId === where.userId) ?? null,
        );
      }),
    })),
    find: jest.fn(
      (_entidad: unknown, { where }: { where: { caseId: string } }) =>
        Promise.resolve(
          this.avisos
            .filter((a) => a.caseId === where.caseId)
            .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime()),
        ),
    ),
    findOne: jest.fn(
      (
        _entidad: unknown,
        { where }: { where: Partial<CylinderRecoveryNotice> },
      ) =>
        Promise.resolve(
          this.avisos.find((a) =>
            Object.entries(where).every(
              ([k, v]) => (a as unknown as Record<string, unknown>)[k] === v,
            ),
          ) ?? null,
        ),
    ),
    create: jest.fn(
      (_entidad: unknown, datos: Partial<CylinderRecoveryNotice>) =>
        unAviso({
          noticeId: `n-${++this.n}`,
          sentAt: new Date(AHORA.getTime() + this.n),
          ...datos,
        }),
    ),
    save: jest.fn((entidad: CylinderRecoveryCase | CylinderRecoveryNotice) => {
      this.guardados.push(entidad);
      if ('noticeId' in entidad && !this.avisos.includes(entidad)) {
        this.avisos.push(entidad);
      }
      return Promise.resolve(entidad);
    }),
  };

  /** `UPDATE ... SET status = expired` de las ofertas pendientes al cerrar. */
  actualizaciones: Array<Record<string, unknown>> = [];

  private consulta(entidad: unknown) {
    const qb: Record<string, jest.Mock> = {};
    let caseId: string | undefined;
    for (const metodo of ['setLock', 'andWhere', 'update', 'where', 'set']) {
      qb[metodo] = jest.fn((...args: unknown[]) => {
        if (metodo === 'where' && args[1] && typeof args[1] === 'object') {
          const p = args[1] as Record<string, string>;
          caseId = p.caseId ?? caseId;
        }
        if (metodo === 'set') this.actualizaciones.push(args[0] as never);
        return qb;
      });
    }
    qb.getOne = jest.fn(() => {
      if (entidad === Cylinder) return Promise.resolve(this.envases[0] ?? null);
      return Promise.resolve(
        entidad === CylinderRecoveryCase
          ? (this.casos.find((c) => c.caseId === caseId) ??
              this.casos[0] ??
              null)
          : null,
      );
    });
    qb.execute = jest.fn(() => Promise.resolve());
    return qb;
  }
}
