import { CylinderRecoveryCasesService } from './cylinder-recovery-cases.service';
import {
  CylinderRecoveryAdminController,
  CylinderRecoveryCustomerController,
  CylinderRecoveryDriverController,
} from './cylinder-recovery.controllers';
import { CylinderRecoveryScoreController } from './cylinder-recovery-v3.controller';
import { CylinderRecoveryService } from './cylinder-recovery.service';
import { RecoveryDecision } from './dto/recovery-request.dto';

describe('controladores del recupero de envases', () => {
  const cases = {
    listar: jest.fn().mockResolvedValue('page'),
    detalle: jest.fn().mockResolvedValue('detalle'),
    resolver: jest.fn().mockResolvedValue('resuelto'),
    reporte: jest.fn().mockResolvedValue('reporte'),
    parametrosVigentes: jest.fn().mockResolvedValue('settings'),
    cambiarParametros: jest.fn().mockResolvedValue('cambiados'),
    delCliente: jest.fn().mockResolvedValue(['caso']),
    aceptarRetiro: jest.fn().mockResolvedValue('aceptado'),
    rechazarRetiro: jest.fn().mockResolvedValue('rechazado'),
    retirosDelChofer: jest.fn().mockResolvedValue(['retiro']),
    confirmarRetiro: jest.fn().mockResolvedValue('confirmado'),
    retiroNoRealizado: jest.fn().mockResolvedValue('no-retirado'),
    puntajeDelCliente: jest.fn().mockResolvedValue('puntaje'),
  };
  const engine = {
    ejecutar: jest.fn().mockResolvedValue({
      abiertos: 2,
      avisos: 3,
      ofertas: 1,
      escalados: 0,
      perdidos: 1,
      cerradosPorDevolucion: 4,
      cerradosPorCuenta: 6,
      revisionManual: 5,
    }),
  };
  const svc = cases as unknown as CylinderRecoveryCasesService;

  describe('puntaje de riesgo (v3)', () => {
    it('lee el puntaje del cliente dentro de la distribuidora', async () => {
      const c = new CylinderRecoveryScoreController(svc);
      expect(await c.puntaje('cli-1', 'd1')).toBe('puntaje');
      expect(cases.puntajeDelCliente).toHaveBeenCalledWith('cli-1', 'd1');
    });
  });

  describe('administrador', () => {
    const c = new CylinderRecoveryAdminController(
      svc,
      engine as unknown as CylinderRecoveryService,
    );

    it('lista, detalla y reporta dentro de su distribuidora', async () => {
      await c.casos({ status: undefined }, 'd1');
      expect(cases.listar).toHaveBeenCalledWith('d1', { status: undefined });
      await c.detalle('id', 'd1');
      expect(cases.detalle).toHaveBeenCalledWith('id', 'd1');
      await c.reporte('d1');
      expect(cases.reporte).toHaveBeenCalledWith('d1');
    });

    it('decide con quién decidió', async () => {
      const dto = { decision: RecoveryDecision.WRITE_OFF, note: 'x' };
      await c.resolver('id', dto, 'd1', 'admin-1');
      expect(cases.resolver).toHaveBeenCalledWith('id', 'd1', dto, 'admin-1');
    });

    it('muestra y cambia los parámetros', async () => {
      await c.settings('d1');
      expect(cases.parametrosVigentes).toHaveBeenCalledWith('d1');
      await c.settingsPatch({ runHour: 5 }, 'd1', 'admin-1');
      expect(cases.cambiarParametros).toHaveBeenCalledWith(
        'd1',
        { runHour: 5 },
        'admin-1',
      );
    });

    it('corre el proceso ahora y devuelve el resumen', async () => {
      expect(await c.correr('d1')).toEqual({
        opened: 2,
        notices: 3,
        offers: 1,
        escalated: 0,
        lost: 1,
        closedByReturn: 4,
        closedCoveredByOwned: 6,
        manualReview: 5,
      });
    });
  });

  describe('cliente', () => {
    const c = new CylinderRecoveryCustomerController(svc);

    it('ve y responde sus propios casos', async () => {
      await c.mios('d1', 'u1');
      expect(cases.delCliente).toHaveBeenCalledWith('u1', 'd1');
      await c.aceptar('id', 'd1', 'u1');
      expect(cases.aceptarRetiro).toHaveBeenCalledWith('id', 'u1', 'd1');
      await c.rechazar('id', 'd1', 'u1');
      expect(cases.rechazarRetiro).toHaveBeenCalledWith('id', 'u1', 'd1');
    });
  });

  describe('chofer', () => {
    const c = new CylinderRecoveryDriverController(svc);

    it('ve, confirma y descarta sus retiros', async () => {
      await c.mios('d1', 'u1');
      expect(cases.retirosDelChofer).toHaveBeenCalledWith('u1', 'd1');
      await c.confirmar('n1', 'd1', 'u1');
      expect(cases.confirmarRetiro).toHaveBeenCalledWith('n1', 'u1', 'd1');
      await c.noRetirado('n1', { reason: 'no estaba' }, 'd1', 'u1');
      expect(cases.retiroNoRealizado).toHaveBeenCalledWith(
        'n1',
        'u1',
        'd1',
        'no estaba',
      );
    });
  });
});
