import mapa from '../../audit/data/auditoria-mapa.datos.json';
import { ETIQUETAS_ENTIDADES } from './etiquetas-entidades';
import { etiquetaDeEntidad } from './etiquetas';

describe('etiquetas de las entidades auditadas', () => {
  it('toda entidad que audita la base tiene su nombre en castellano', () => {
    const sin = mapa.entities
      .map((e) => e.entity)
      .filter((e) => !etiquetaDeEntidad(e));
    expect(sin).toEqual([]);
  });

  it('no hay etiquetas para entidades que ya no se auditan, ni repetidas', () => {
    // «Sesion» no sale de un trigger de tabla: la escribe `SesionAuditService` al iniciar y cerrar sesión.
    const auditadas = new Set([
      ...mapa.entities.map((e) => e.entity),
      'Sesion',
    ]);
    const huerfanas = Object.keys(ETIQUETAS_ENTIDADES).filter(
      (e) => !auditadas.has(e),
    );
    expect(huerfanas).toEqual([]);
    const textos = Object.values(ETIQUETAS_ENTIDADES);
    expect(new Set(textos).size).toBe(textos.length);
  });

  it('no se confunde con las propiedades de Object', () => {
    expect(etiquetaDeEntidad('constructor')).toBeUndefined();
    expect(etiquetaDeEntidad('__proto__')).toBeUndefined();
  });
});
