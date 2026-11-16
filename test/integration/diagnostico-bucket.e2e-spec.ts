import {
  codigoDeSalida,
  evaluarBucket,
  EntradasDelDiagnostico,
  pasosParaNahu,
} from '../../scripts/lib/diagnostico-bucket';

const CERRADO: EntradasDelDiagnostico = {
  publicAccessBlock: {
    ok: true,
    valor: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  },
  politicaPublica: { ok: true, valor: false },
  gruposDeLaAcl: { ok: true, valor: [] },
};

const DENEGADO = {
  ok: false as const,
  denegado: true,
  mensaje: 'AccessDenied: no autorizado',
};

describe('diagnóstico del bucket', () => {
  it('cerrado: todo ok y salida 0', () => {
    const h = evaluarBucket(CERRADO);
    expect(h.map((x) => x.veredicto)).toEqual(['ok', 'ok', 'ok']);
    expect(codigoDeSalida(h)).toBe(0);
  });

  it('sin política: ok', () => {
    const h = evaluarBucket({
      ...CERRADO,
      politicaPublica: { ok: true, valor: null },
    });
    expect(h[1]).toMatchObject({
      veredicto: 'ok',
      detalle: 'No hay política.',
    });
  });

  it('una opción de Block Public Access apagada es MAL y dice cuál', () => {
    const h = evaluarBucket({
      ...CERRADO,
      publicAccessBlock: {
        ok: true,
        valor: { BlockPublicAcls: true, IgnorePublicAcls: true },
      },
    });
    expect(h[0].veredicto).toBe('mal');
    expect(h[0].detalle).toContain('BlockPublicPolicy');
    expect(h[0].detalle).toContain('RestrictPublicBuckets');
    expect(codigoDeSalida(h)).toBe(1);
  });

  it('sin configuración de Block Public Access es MAL', () => {
    const h = evaluarBucket({
      ...CERRADO,
      publicAccessBlock: { ok: true, valor: null },
    });
    expect(h[0].veredicto).toBe('mal');
  });

  it('política pública o ACL con AllUsers: MAL', () => {
    const h = evaluarBucket({
      ...CERRADO,
      politicaPublica: { ok: true, valor: true },
      gruposDeLaAcl: {
        ok: true,
        valor: ['http://acs.amazonaws.com/groups/global/AllUsers'],
      },
    });
    expect(h.map((x) => x.veredicto)).toEqual(['ok', 'mal', 'mal']);
    expect(codigoDeSalida(h)).toBe(1);
  });

  it('AccessDenied: sin-permiso, nunca ok, salida 2', () => {
    const h = evaluarBucket({ ...CERRADO, publicAccessBlock: DENEGADO });
    expect(h[0].veredicto).toBe('sin-permiso');
    expect(codigoDeSalida(h)).toBe(2);
  });

  it('lo abierto gana sobre lo no verificable', () => {
    const h = evaluarBucket({
      ...CERRADO,
      publicAccessBlock: DENEGADO,
      politicaPublica: { ok: true, valor: true },
    });
    expect(codigoDeSalida(h)).toBe(1);
  });

  it('los pasos para nahu nombran el bucket y los comandos de lectura', () => {
    const pasos = pasosParaNahu('splg-tesis', 'sa-east-1');
    expect(pasos).toContain('get-public-access-block --bucket splg-tesis');
    expect(pasos).toContain('Bloquear todo el acceso público');
  });
});
