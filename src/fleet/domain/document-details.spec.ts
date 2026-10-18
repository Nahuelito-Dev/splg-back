import { MaintenanceDocumentKind } from '../entities/maintenance-plan.entity';
import { exigeDetalle, validarDetalle } from './document-details';

describe('validarDetalle', () => {
  it('el curso de mercancías peligrosas pide número de certificado y emisor', () => {
    expect(
      validarDetalle(MaintenanceDocumentKind.HAZMAT_DRIVER_COURSE, {
        certificateNumber: ' 123/26 ',
        issuer: 'CNRT',
      }),
    ).toEqual({
      ok: true,
      detalle: { certificateNumber: '123/26', issuer: 'CNRT' },
    });
  });

  it('nombra el campo que falta, que está vacío o que se pasa de largo', () => {
    const falta = validarDetalle(MaintenanceDocumentKind.HAZMAT_DRIVER_COURSE, {
      certificateNumber: '1',
    });
    expect(falta).toEqual({
      ok: false,
      motivo: 'detalle.issuer (emisor) es obligatorio',
    });
    const largo = validarDetalle(MaintenanceDocumentKind.ART_COVERAGE, {
      insurer: 'x'.repeat(81),
      policyNumber: '1',
    });
    expect(largo.ok).toBe(false);
    expect(!largo.ok && largo.motivo).toContain('detalle.insurer');
  });

  it('el psicofísico pide una fecha de examen real', () => {
    expect(
      validarDetalle(MaintenanceDocumentKind.PSYCHOPHYSICAL, {
        examDate: '2026-02-30',
      }).ok,
    ).toBe(false);
    expect(
      validarDetalle(MaintenanceDocumentKind.PSYCHOPHYSICAL, {
        examDate: '2026-02-27',
      }),
    ).toEqual({ ok: true, detalle: { examDate: '2026-02-27' } });
  });

  it('rechaza claves de más y detalle ausente donde se exige', () => {
    const extra = validarDetalle(MaintenanceDocumentKind.ART_COVERAGE, {
      insurer: 'Galeno',
      policyNumber: '9',
      otro: 'x',
    });
    expect(!extra.ok && extra.motivo).toContain('detalle.otro');
    const sin = validarDetalle(MaintenanceDocumentKind.ART_COVERAGE, undefined);
    expect(!sin.ok && sin.motivo).toContain('insurer');
    expect(validarDetalle(MaintenanceDocumentKind.ART_COVERAGE, ['x']).ok).toBe(
      false,
    );
  });

  it('los tipos sin esquema no llevan detalle', () => {
    expect(validarDetalle(MaintenanceDocumentKind.VTV, undefined)).toEqual({
      ok: true,
      detalle: null,
    });
    expect(validarDetalle(null, { a: 'b' }).ok).toBe(false);
  });

  it('exigeDetalle distingue los tipos con esquema', () => {
    expect(exigeDetalle(MaintenanceDocumentKind.PSYCHOPHYSICAL)).toBe(true);
    expect(exigeDetalle(MaintenanceDocumentKind.VTV)).toBe(false);
    expect(exigeDetalle(null)).toBe(false);
  });
});
