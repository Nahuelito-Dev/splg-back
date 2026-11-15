import {
  CATALOGO_DE_PERMISOS,
  esPermiso,
  etiquetaDelPermiso,
  ordenarPermisos,
  PERMISO_ROLES,
  PERMISOS,
  permisoImplicado,
  permisosDesconocidos,
  permisosEfectivos,
} from './catalogo';

describe('catálogo de permisos del personal', () => {
  it('trae los permisos del diseño, con clave modulo.accion y sin repetidos', () => {
    expect(PERMISOS).toHaveLength(33);
    expect(new Set(PERMISOS).size).toBe(PERMISOS.length);
    for (const p of PERMISOS) {
      expect(p).toMatch(/^[a-z]+\.[a-z]+$/);
    }
    expect(PERMISOS).toEqual(
      expect.arrayContaining([
        'pedidos.ver',
        'despacho.gestionar',
        'caja.anular',
        'lectura.decidir',
        'administradores.gestionar',
        'roles.gestionar',
        'soporte.ver',
        'soporte.gestionar',
      ]),
    );
    expect(PERMISO_ROLES).toBe('roles.gestionar');
  });

  it('cada módulo y cada permiso tiene etiqueta y descripción en castellano', () => {
    for (const modulo of CATALOGO_DE_PERMISOS) {
      expect(modulo.etiqueta.length).toBeGreaterThan(3);
      for (const p of modulo.permisos) {
        expect(p.etiqueta).toMatch(/^[a-z]/);
        expect(p.descripcion).toMatch(/\.$/);
      }
    }
    expect(etiquetaDelPermiso('pedidos.gestionar')).toBe(
      'gestionar los pedidos',
    );
  });

  it('reconoce lo que está en el catálogo y lista lo que no, sin repetir', () => {
    expect(esPermiso('flota.ver')).toBe(true);
    expect(esPermiso('flota.borrar')).toBe(false);
    expect(
      permisosDesconocidos(['flota.ver', 'x.y', 'x.y', 'pedidos.todo']),
    ).toEqual(['x.y', 'pedidos.todo']);
  });

  it('gestionar implica ver del mismo módulo, si ese ver existe', () => {
    expect(permisoImplicado('pedidos.gestionar')).toBe('pedidos.ver');
    expect(permisoImplicado('despacho.gestionar')).toBeNull();
    expect(permisoImplicado('compras.gestionar')).toBeNull();
    expect(permisoImplicado('pedidos.ver')).toBeNull();
    expect(permisoImplicado('caja.anular')).toBeNull();
  });

  it('los efectivos suman los ver implícitos y descartan lo que no está en el catálogo', () => {
    expect([
      ...permisosEfectivos(['stock.gestionar', 'compras.gestionar', 'viejo.x']),
    ]).toEqual(['stock.gestionar', 'stock.ver', 'compras.gestionar']);
  });

  it('ordena como el catálogo', () => {
    expect(
      ordenarPermisos(['roles.gestionar', 'pedidos.ver', 'clientes.ver']),
    ).toEqual(['pedidos.ver', 'clientes.ver', 'roles.gestionar']);
  });
});
