/**
 * Catálogo de permisos del personal del panel (F37). Es la fuente de verdad:
 * la base sólo guarda qué permisos tiene cada rol de personal (`staff_role`),
 * y el back valida contra esta lista. Cada permiso es `modulo.accion`; la
 * etiqueta completa la frase «No tenés permiso para <etiqueta>».
 *
 * `gestionar` implica `ver` del mismo prefijo, cuando ese `ver` existe
 * (`pedidos.gestionar` ⇒ `pedidos.ver`; `despacho.gestionar` no implica nada).
 */
export const CATALOGO_DE_PERMISOS = [
  {
    clave: 'pedidos',
    etiqueta: 'Pedidos y despacho',
    permisos: [
      {
        clave: 'pedidos.ver',
        etiqueta: 'ver los pedidos',
        descripcion: 'Listado, ficha e historial de los pedidos.',
      },
      {
        clave: 'pedidos.gestionar',
        etiqueta: 'gestionar los pedidos',
        descripcion: 'Crear, editar, cancelar y cobrar pedidos.',
      },
      {
        clave: 'despacho.gestionar',
        etiqueta: 'gestionar el despacho',
        descripcion: 'Asignar choferes, ofertas y hojas de ruta.',
      },
      {
        clave: 'reintegros.gestionar',
        etiqueta: 'gestionar los reintegros',
        descripcion: 'Registrar y resolver los reintegros de pagos.',
      },
    ],
  },
  {
    clave: 'clientes',
    etiqueta: 'Clientes',
    permisos: [
      {
        clave: 'clientes.ver',
        etiqueta: 'ver los clientes',
        descripcion: 'Listado y ficha de los clientes.',
      },
      {
        clave: 'clientes.gestionar',
        etiqueta: 'gestionar los clientes',
        descripcion: 'Alta, edición y baja de clientes y sus cuentas.',
      },
    ],
  },
  {
    clave: 'personal',
    etiqueta: 'Personal',
    permisos: [
      {
        clave: 'personal.ver',
        etiqueta: 'ver el personal',
        descripcion: 'Choferes, legajos, puestos, asistencia y licencias.',
      },
      {
        clave: 'personal.gestionar',
        etiqueta: 'gestionar el personal',
        descripcion:
          'Alta y edición de choferes, legajos, puestos, asistencia y licencias.',
      },
    ],
  },
  {
    clave: 'flota',
    etiqueta: 'Flota',
    permisos: [
      {
        clave: 'flota.ver',
        etiqueta: 'ver la flota',
        descripcion: 'Vehículos, mantenimiento, seguros y gastos.',
      },
      {
        clave: 'flota.gestionar',
        etiqueta: 'gestionar la flota',
        descripcion:
          'Alta y edición de vehículos, mantenimiento, seguros y gastos.',
      },
    ],
  },
  {
    clave: 'stock',
    etiqueta: 'Stock y compras',
    permisos: [
      {
        clave: 'stock.ver',
        etiqueta: 'ver el stock',
        descripcion: 'Depósitos, existencias y movimientos.',
      },
      {
        clave: 'stock.gestionar',
        etiqueta: 'gestionar el stock',
        descripcion: 'Ajustes, transferencias y cargas de camión.',
      },
      {
        clave: 'compras.gestionar',
        etiqueta: 'gestionar las compras',
        descripcion: 'Proveedores, órdenes de compra y recepciones.',
      },
    ],
  },
  {
    clave: 'finanzas',
    etiqueta: 'Finanzas',
    permisos: [
      {
        clave: 'finanzas.ver',
        etiqueta: 'ver las finanzas',
        descripcion: 'Cajas, cuentas corrientes, rendiciones e informes.',
      },
      {
        clave: 'finanzas.gestionar',
        etiqueta: 'gestionar las finanzas',
        descripcion:
          'Movimientos de caja, rendiciones, comisiones y conciliaciones.',
      },
      {
        clave: 'caja.anular',
        etiqueta: 'anular movimientos de caja',
        descripcion: 'Revertir un movimiento de caja ya registrado.',
      },
    ],
  },
  {
    clave: 'catalogo',
    etiqueta: 'Catálogo y cobertura',
    permisos: [
      {
        clave: 'catalogo.ver',
        etiqueta: 'ver el catálogo y la cobertura',
        descripcion: 'Productos, precios, zonas de cobertura y franjas.',
      },
      {
        clave: 'catalogo.gestionar',
        etiqueta: 'gestionar el catálogo y la cobertura',
        descripcion:
          'Alta y edición de productos, precios, zonas de cobertura y franjas.',
      },
    ],
  },
  {
    clave: 'lectura',
    etiqueta: 'Lectura de documentos',
    permisos: [
      {
        clave: 'lectura.ver',
        etiqueta: 'ver las lecturas de documentos',
        descripcion: 'Documentos escaneados y lo que se leyó de cada uno.',
      },
      {
        clave: 'lectura.decidir',
        etiqueta: 'decidir las lecturas de documentos',
        descripcion: 'Confirmar, corregir o rechazar una lectura.',
      },
    ],
  },
  {
    clave: 'configuracion',
    etiqueta: 'Configuración',
    permisos: [
      {
        clave: 'configuracion.ver',
        etiqueta: 'ver la configuración',
        descripcion: 'Datos de la distribuidora y parámetros de los procesos.',
      },
      {
        clave: 'configuracion.gestionar',
        etiqueta: 'gestionar la configuración',
        descripcion:
          'Cambiar los datos de la distribuidora y los parámetros de los procesos.',
      },
    ],
  },
  {
    clave: 'reclamos',
    etiqueta: 'Reclamos e incidencias',
    permisos: [
      {
        clave: 'reclamos.ver',
        etiqueta: 'ver los reclamos e incidencias',
        descripcion: 'Listado y ficha de reclamos e incidencias.',
      },
      {
        clave: 'reclamos.gestionar',
        etiqueta: 'gestionar los reclamos e incidencias',
        descripcion: 'Tomar, resolver y reabrir reclamos e incidencias.',
      },
    ],
  },
  {
    clave: 'mensajes',
    etiqueta: 'Mensajes',
    permisos: [
      {
        clave: 'mensajes.clientes',
        etiqueta: 'atender los mensajes de los clientes',
        descripcion:
          'Ver la cola y las conversaciones con los clientes, tomarlas, asignarlas, responder, cerrarlas y crear reclamos desde el hilo.',
      },
      {
        clave: 'mensajes.choferes',
        etiqueta: 'atender los mensajes de los choferes',
        descripcion:
          'Ver la cola y las conversaciones con los choferes, tomarlas, asignarlas, responder, cerrarlas y mandar un mensaje a varios choferes.',
      },
      {
        clave: 'mensajes.configurar',
        etiqueta: 'configurar los mensajes',
        descripcion:
          'Horario de atención, respuestas automáticas y respuestas rápidas de la empresa.',
      },
    ],
  },
  {
    clave: 'auditoria',
    etiqueta: 'Auditoría y reportes',
    permisos: [
      {
        clave: 'auditoria.ver',
        etiqueta: 'ver la auditoría',
        descripcion: 'Quién cambió qué y cuándo.',
      },
      {
        clave: 'reportes.ver',
        etiqueta: 'ver los reportes',
        descripcion: 'Tablero, informes y exportaciones.',
      },
    ],
  },
  {
    clave: 'administracion',
    etiqueta: 'Administración',
    permisos: [
      {
        clave: 'administradores.gestionar',
        etiqueta: 'gestionar los administradores',
        descripcion: 'Alta, edición, baja y rol de los administradores.',
      },
      {
        clave: 'roles.gestionar',
        etiqueta: 'gestionar los roles y permisos',
        descripcion: 'Crear, editar y dar de baja los roles del personal.',
      },
      {
        clave: 'soporte.ver',
        etiqueta: 'ver los accesos de soporte',
        descripcion:
          'Pedidos y sesiones del soporte de la plataforma, y qué miró cada una.',
      },
      {
        clave: 'soporte.gestionar',
        etiqueta: 'gestionar los accesos de soporte',
        descripcion:
          'Aprobar, rechazar y revocar accesos de soporte, y fijar la política de la empresa.',
      },
    ],
  },
] as const;

/** Un permiso del catálogo (`'pedidos.ver'`, `'roles.gestionar'`…). */
export type Permiso =
  (typeof CATALOGO_DE_PERMISOS)[number]['permisos'][number]['clave'];

/** Todos los permisos, en el orden del catálogo. */
export const PERMISOS: readonly Permiso[] = CATALOGO_DE_PERMISOS.flatMap((m) =>
  m.permisos.map((p) => p.clave),
);

const CONJUNTO = new Set<string>(PERMISOS);

const ETIQUETAS = new Map<string, string>(
  CATALOGO_DE_PERMISOS.flatMap((m) =>
    m.permisos.map((p) => [p.clave, p.etiqueta] as const),
  ),
);

/** El permiso que gobierna los roles: siempre tiene que quedar alguien con él. */
export const PERMISO_ROLES: Permiso = 'roles.gestionar';

export function esPermiso(valor: string): valor is Permiso {
  return CONJUNTO.has(valor);
}

/** Lo que no está en el catálogo, sin repetidos y en el orden en que llegó. */
export function permisosDesconocidos(valores: readonly string[]): string[] {
  return [...new Set(valores.filter((v) => !esPermiso(v)))];
}

/** La frase que completa «No tenés permiso para …». */
export function etiquetaDelPermiso(permiso: Permiso): string {
  return ETIQUETAS.get(permiso) ?? permiso;
}

/** El `ver` que implica un `gestionar` del mismo prefijo, si existe. */
export function permisoImplicado(permiso: Permiso): Permiso | null {
  const [modulo, accion] = permiso.split('.');
  if (accion !== 'gestionar') return null;
  const ver = `${modulo}.ver`;
  return esPermiso(ver) ? ver : null;
}

/**
 * Los permisos efectivos de una lista guardada: descarta lo que ya no está en
 * el catálogo y suma el `ver` de cada `gestionar`.
 */
export function permisosEfectivos(guardados: readonly string[]): Set<Permiso> {
  const efectivos = new Set<Permiso>();
  for (const valor of guardados) {
    if (!esPermiso(valor)) continue;
    efectivos.add(valor);
    const implicado = permisoImplicado(valor);
    if (implicado) efectivos.add(implicado);
  }
  return efectivos;
}

/** Ordena una lista de permisos como el catálogo (para guardar y responder). */
export function ordenarPermisos(permisos: Iterable<Permiso>): Permiso[] {
  const elegidos = new Set<Permiso>(permisos);
  return PERMISOS.filter((p) => elegidos.has(p));
}
