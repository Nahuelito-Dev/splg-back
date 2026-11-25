import { AHORA, enDias, unEnvase } from '../application/dobles-de-puertos';
import { CylinderInspectionResult } from './cylinder-inspection-result';
import { CylinderState } from './cylinder-state';
import { movimientoDeAlta, nuevoEnvase } from './envase';
import {
  EnvaseEnConflictoError,
  EnvasesVencidosError,
  ReglaDeEnvaseError,
} from './errors/cylinder-rule.errors';
import { InvalidCylinderTransitionError } from './errors/invalid-cylinder-transition.error';
import { RevisionPlanificada } from './revision-de-envase';

describe('Envase (agregado)', () => {
  describe('alta', () => {
    it('nace en el depósito, sin dueño y con el serial en su forma canónica', () => {
      expect(nuevoEnvase('dist-1', { serial: ' sn-9 ' })).toEqual({
        distributorId: 'dist-1',
        serial: 'SN-9',
        gasCylinderId: null,
        deposit: 0,
        state: CylinderState.IN_DEPOT,
      });
    });

    it('un serial en blanco no es un serial', () => {
      expect(() => nuevoEnvase('dist-1', { serial: '   ' })).toThrow(
        ReglaDeEnvaseError,
      );
    });

    it('el primer movimiento no tiene estado de origen', () => {
      expect(movimientoDeAlta(unEnvase())).toMatchObject({
        cylinderId: 'cyl-1',
        fromState: null,
        toState: CylinderState.IN_DEPOT,
      });
    });
  });

  describe('transicionar', () => {
    it('devuelve el movimiento con origen, destino, pedido, actor y nota', () => {
      const envase = unEnvase({ state: CylinderState.FILLED });

      const movimiento = envase.transicionar(
        CylinderState.DISPATCHED,
        { orderId: 'ord-1', actorUserId: 'u-1', note: 'sale' },
        AHORA,
      );

      expect(envase.state).toBe(CylinderState.DISPATCHED);
      expect(movimiento).toEqual({
        cylinderId: 'cyl-1',
        distributorId: 'dist-1',
        fromState: CylinderState.FILLED,
        toState: CylinderState.DISPATCHED,
        orderId: 'ord-1',
        actorUserId: 'u-1',
        note: 'sale',
      });
    });

    it('una transición que la máquina de estados no admite se rechaza y el envase no cambia', () => {
      const envase = unEnvase({ state: CylinderState.IN_DEPOT });

      expect(() =>
        envase.transicionar(CylinderState.DISPATCHED, {}, AHORA),
      ).toThrow(InvalidCylinderTransitionError);
      expect(envase.snapshot()).toMatchObject({
        state: CylinderState.IN_DEPOT,
        currentOrderId: null,
      });
    });

    it('al despacharse queda atado al pedido; al entregarse, a nombre del titular', () => {
      const envase = unEnvase({ state: CylinderState.FILLED });

      envase.transicionar(
        CylinderState.DISPATCHED,
        { orderId: 'ord-1' },
        AHORA,
      );
      expect(envase.currentOrderId).toBe('ord-1');
      expect(envase.currentCustomerId).toBeNull();

      envase.transicionar(
        CylinderState.WITH_CUSTOMER,
        { customerId: 'cust-1' },
        AHORA,
      );
      // Sin pedido en la entrega conserva el del despacho.
      expect(envase.currentOrderId).toBe('ord-1');
      expect(envase.currentCustomerId).toBe('cust-1');
    });

    it('al volver vacío ya no es de nadie pero conserva el pedido; en el depósito queda libre', () => {
      const envase = unEnvase({
        state: CylinderState.WITH_CUSTOMER,
        currentCustomerId: 'cust-1',
        currentOrderId: 'ord-1',
      });

      envase.transicionar(CylinderState.EMPTY_RETURNED, {}, AHORA);
      expect(envase.currentCustomerId).toBeNull();
      expect(envase.currentOrderId).toBe('ord-1');

      envase.transicionar(CylinderState.IN_DEPOT, {}, AHORA);
      expect(envase.currentOrderId).toBeNull();
    });

    describe('bloqueo del despacho por vigencia (CU-135)', () => {
      it('con la revisión vencida no sale a reparto, e informa su serial', () => {
        const envase = unEnvase({
          state: CylinderState.FILLED,
          serial: 'SN-VENCIDO',
          expiresAt: enDias(-1),
        });

        let error: unknown;
        try {
          envase.transicionar(
            CylinderState.DISPATCHED,
            { orderId: 'ord-1' },
            AHORA,
          );
        } catch (e) {
          error = e;
        }

        expect(error).toBeInstanceOf(EnvasesVencidosError);
        expect((error as EnvasesVencidosError).serials).toEqual(['SN-VENCIDO']);
        expect((error as EnvasesVencidosError).code).toBe('CYLINDER_EXPIRED');
        expect(envase.state).toBe(CylinderState.FILLED);
        expect(envase.currentOrderId).toBeNull();
      });

      it('el que vence en este instante ya está vencido', () => {
        const envase = unEnvase({
          state: CylinderState.FILLED,
          expiresAt: AHORA,
        });
        expect(() =>
          envase.transicionar(CylinderState.DISPATCHED, {}, AHORA),
        ).toThrow(EnvasesVencidosError);
      });

      it.each([
        ['vigente', enDias(30)],
        ['sin revisión registrada', null],
      ])('%s se despacha', (_, expiresAt) => {
        const envase = unEnvase({ state: CylinderState.FILLED, expiresAt });
        envase.transicionar(CylinderState.DISPATCHED, {}, AHORA);
        expect(envase.state).toBe(CylinderState.DISPATCHED);
      });

      it('un vencido sí puede volver al depósito: no es un despacho', () => {
        const envase = unEnvase({
          state: CylinderState.DISPATCHED,
          expiresAt: enDias(-1),
        });
        envase.transicionar(CylinderState.IN_DEPOT, {}, AHORA);
        expect(envase.state).toBe(CylinderState.IN_DEPOT);
      });
    });
  });

  describe('baja', () => {
    it('desde el depósito queda dado de baja, con el motivo en el movimiento', () => {
      const envase = unEnvase();
      const movimiento = envase.darDeBaja('válvula rota', 'admin-1', AHORA);

      expect(envase.state).toBe(CylinderState.RETIRED);
      expect(movimiento).toMatchObject({
        toState: CylinderState.RETIRED,
        actorUserId: 'admin-1',
        note: 'Baja: válvula rota',
      });
    });

    it('uno en poder de un cliente no se da de baja por la vía común', () => {
      const envase = unEnvase({
        state: CylinderState.WITH_CUSTOMER,
        currentCustomerId: 'cust-1',
      });
      expect(() => envase.darDeBaja('x', 'admin-1', AHORA)).toThrow(
        InvalidCylinderTransitionError,
      );
      expect(envase.state).toBe(CylinderState.WITH_CUSTOMER);
    });

    it('darlo por perdido lo libera del cliente y deja el motivo', () => {
      const envase = unEnvase({
        state: CylinderState.WITH_CUSTOMER,
        currentCustomerId: 'cust-1',
        currentOrderId: 'ord-1',
      });
      const movimiento = envase.darPorPerdido('extraviado', 'admin-1', AHORA);

      expect(envase.snapshot()).toMatchObject({
        state: CylinderState.RETIRED,
        currentCustomerId: null,
        currentOrderId: null,
      });
      expect(movimiento.note).toBe('Baja por pérdida: extraviado');
    });

    it('no se da por perdido un envase que ya no está con un cliente', () => {
      const envase = unEnvase({ state: CylinderState.EMPTY_RETURNED });
      expect(() => envase.darPorPerdido('x', 'admin-1', AHORA)).toThrow(
        EnvaseEnConflictoError,
      );
    });

    it('dado de baja es terminal', () => {
      const envase = unEnvase({ state: CylinderState.RETIRED });
      expect(() =>
        envase.transicionar(CylinderState.IN_DEPOT, {}, AHORA),
      ).toThrow(InvalidCylinderTransitionError);
    });
  });

  describe('editar', () => {
    it('cambia los datos maestros y no toca el estado', () => {
      const envase = unEnvase({ state: CylinderState.FILLED });
      envase.editar({ serial: ' sn-nuevo ', deposit: 10 }, AHORA);

      expect(envase.snapshot()).toMatchObject({
        serial: 'SN-NUEVO',
        deposit: 10,
        state: CylinderState.FILLED,
      });
    });

    it('dado de baja no se edita', () => {
      const envase = unEnvase({ state: CylinderState.RETIRED });
      expect(() => envase.editar({ deposit: 1 }, AHORA)).toThrow(
        EnvaseEnConflictoError,
      );
    });

    it('la fabricación no puede ser futura (con cinco minutos de tolerancia de reloj)', () => {
      const envase = unEnvase();
      const enMinutos = (n: number) => new Date(AHORA.getTime() + n * 60000);

      envase.editar({ manufacturedAt: enMinutos(4) }, AHORA);
      expect(envase.snapshot().manufacturedAt).toEqual(enMinutos(4));
      expect(() =>
        envase.editar({ manufacturedAt: enMinutos(6) }, AHORA),
      ).toThrow('la fecha de fabricación no puede ser futura');
    });

    it('la fabricación no puede ser posterior al vencimiento', () => {
      const envase = unEnvase({ expiresAt: enDias(-10) });
      expect(() =>
        envase.editar({ manufacturedAt: enDias(-5) }, AHORA),
      ).toThrow(ReglaDeEnvaseError);
    });
  });

  describe('registrarRevision (CU-132)', () => {
    const plan = (over: Partial<RevisionPlanificada> = {}) => ({
      inspectedAt: enDias(-1),
      vence: enDias(365),
      rechazada: false,
      result: CylinderInspectionResult.APPROVED,
      notes: null,
      ...over,
    });
    const rechazo = (over: Partial<RevisionPlanificada> = {}) =>
      plan({
        vence: null,
        rechazada: true,
        result: CylinderInspectionResult.REJECTED,
        ...over,
      });

    it('copia en la ficha la última revisión y el vencimiento', () => {
      const envase = unEnvase();
      const r = envase.registrarRevision(plan());

      expect(r.actualizaFicha).toBe(true);
      expect(r.movimiento).toBeNull();
      expect(r.revision).toMatchObject({
        cylinderId: 'cyl-1',
        result: CylinderInspectionResult.APPROVED,
        nextDueAt: enDias(365),
      });
      expect(envase.snapshot()).toMatchObject({
        lastInspectionAt: enDias(-1),
        expiresAt: enDias(365),
      });
    });

    it('un rechazo vence en el acto: el envase queda alcanzado por el bloqueo del despacho', () => {
      const envase = unEnvase({
        state: CylinderState.FILLED,
        expiresAt: enDias(100),
      });
      envase.registrarRevision(rechazo());

      expect(envase.expiresAt).toEqual(enDias(-1));
      expect(() =>
        envase.transicionar(CylinderState.DISPATCHED, {}, AHORA),
      ).toThrow(EnvasesVencidosError);
    });

    it('rechazado y afuera: no cambia de estado y queda marcado para retirarlo', () => {
      const envase = unEnvase({
        state: CylinderState.WITH_CUSTOMER,
        currentCustomerId: 'cust-1',
      });
      const r = envase.registrarRevision(rechazo(), 'admin-1');

      expect(envase.state).toBe(CylinderState.WITH_CUSTOMER);
      expect(r.movimiento).toMatchObject({
        fromState: CylinderState.WITH_CUSTOMER,
        toState: CylinderState.WITH_CUSTOMER,
        actorUserId: 'admin-1',
        note: 'Revisión rechazada: retirar el envase cuando vuelva',
      });
    });

    it('rechazado en el depósito no deja marca', () => {
      expect(unEnvase().registrarRevision(rechazo()).movimiento).toBeNull();
    });

    it('una revisión anterior a la última cargada sólo va al historial', () => {
      const envase = unEnvase({
        lastInspectionAt: enDias(-1),
        expiresAt: enDias(300),
      });
      const r = envase.registrarRevision(
        plan({ inspectedAt: enDias(-30), vence: enDias(5) }),
      );

      expect(r.actualizaFicha).toBe(false);
      expect(envase.snapshot()).toMatchObject({
        lastInspectionAt: enDias(-1),
        expiresAt: enDias(300),
      });
    });

    it('no admite revisiones anteriores a la fabricación ni sobre un envase dado de baja', () => {
      expect(() =>
        unEnvase({ manufacturedAt: AHORA }).registrarRevision(plan()),
      ).toThrow(ReglaDeEnvaseError);
      expect(() =>
        unEnvase({ state: CylinderState.RETIRED }).registrarRevision(plan()),
      ).toThrow(EnvaseEnConflictoError);
    });
  });
});
