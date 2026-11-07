/**
 * Seed de datos de demostración.
 *
 *   npm run seed:demo
 *
 * Deja la base local con una operación realista de una distribuidora de
 * Posadas, Misiones, para recorrer el panel y las dos apps: catálogo, clientes
 * con direcciones, franjas, zonas, personal con legajo, flota con mantenimiento,
 * depósitos con stock, compras, cargas del camión, sesenta días de pedidos con
 * todos sus estados y medios de pago, reclamos, incidencias, calificaciones,
 * envases con trazabilidad y auditoría.
 *
 * Presupone que `npm run seed` ya corrió: de ahí salen los roles, la
 * distribuidora y los usuarios que tienen login real contra Firebase. Este
 * script no toca Firebase: las personas que crea existen solo en la base.
 *
 * Es reproducible y reentrante. PURGA todo lo que hay de la distribuidora (en
 * una transacción, ver `lib/purga-demo.ts`) y lo vuelve a generar igual, porque
 * el azar sale de una semilla fija. Los usuarios con login sobreviven y toman su
 * nombre real. Antes de correrlo contra una base con datos que importen, hacé el
 * backup (ver splg-docs/sistema/back/DEMO.md).
 *
 * Se configura por variables de entorno:
 *
 *   SEED_CUSTOMERS=30   clientes en total, contando el que tiene login
 *   SEED_DRIVERS=5      choferes con vehículo, legajo y carga (máx. 5)
 *   SEED_ORDERS=340     pedidos repartidos en los últimos 60 días
 *   SEED_DISTRIBUTOR=demo   slug de la distribuidora que recibe todo
 *   SEED_S3=1           sube las fotos de ejemplo (a MinIO o al bucket del .env)
 *   SEED_PURGE_S3=1     borra los objetos de la demo anterior (sólo bajo su prefijo)
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { diaArgentino } from '../src/common/utils/dias-argentina';
import {
  CUENTAS_CON_LOGIN,
  darDeBajaFueraDeLaLista,
  renombrarCuentasEnBase,
} from './lib/cuentas-demo';
import { FiguraDemo, generarImagenDemo } from './lib/imagenes-demo';
import { sembrarAuditoria, EventoDeAuditoria } from './lib/auditoria-demo';
import {
  CHOFERES_DE_LA_DEMO,
  sembrarMantenimiento,
  sembrarPersonal,
  sembrarUsoDeFlota,
} from './lib/personal-flota-demo';
import {
  huerfanosSinLogin,
  personasSinLoginDeAlcance,
  purgarDistribuidoras,
  purgarPersonasSinLogin,
} from './lib/purga-demo';
import {
  purgaS3Habilitada,
  resguardoDeProduccion,
} from './lib/resguardo-de-produccion';
import { generateDeliveryCode } from '../src/order/domain/delivery-code.util';
import { sembrarStockHistoria } from './lib/stock-historia-demo';
import {
  AlmacenDemo,
  crearAlmacenDemo,
  keyEsDeLaDemo,
} from './lib/storage-demo';

const CANT_CLIENTES = Number(process.env.SEED_CUSTOMERS ?? 30);
const CANT_CHOFERES = Math.min(
  Number(process.env.SEED_DRIVERS ?? CHOFERES_DE_LA_DEMO.length),
  CHOFERES_DE_LA_DEMO.length,
);
const CANT_PEDIDOS = Number(process.env.SEED_ORDERS ?? 340);
const DIAS_DE_HISTORIA = 60;
/** El administrador que firma la auditoría, los cobros y los documentos. */
const EMAIL_DEL_ADMIN = 'admin@splg.com';
const SLUG = process.env.SEED_DISTRIBUTOR ?? 'demo';
/** Con esto en true la base queda con una sola distribuidora, la de SLUG. */
const SOLO_UNA = (process.env.SEED_SINGLE_TENANT ?? 'true') === 'true';

// ─────────────────────────────────────────────────────────────────────────────
// Azar reproducible: misma semilla, mismos datos en cada corrida.
// ─────────────────────────────────────────────────────────────────────────────
let semilla = 20260906;
const azar = (): number => {
  semilla = (semilla + 0x6d2b79f5) >>> 0;
  let t = semilla;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const entre = (min: number, max: number) =>
  min + Math.floor(azar() * (max - min + 1));
const alguno = <T>(xs: readonly T[]): T => xs[Math.floor(azar() * xs.length)];
/** true con probabilidad p. */
const quizas = (p: number) => azar() < p;

// ─────────────────────────────────────────────────────────────────────────────
// Datos de referencia: Posadas, Misiones.
// ─────────────────────────────────────────────────────────────────────────────
const NOMBRES = [
  'Sofía',
  'Mateo',
  'Valentina',
  'Benjamín',
  'Camila',
  'Thiago',
  'Martina',
  'Lautaro',
  'Emilia',
  'Joaquín',
  'Catalina',
  'Bautista',
  'Julieta',
  'Santino',
  'Renata',
  'Ignacio',
  'Delfina',
  'Tomás',
  'Guadalupe',
  'Facundo',
  'Agustina',
  'Lorenzo',
  'Pilar',
  'Ramiro',
  'Zoe',
  'Nicolás',
  'Abril',
  'Franco',
  'Malena',
  'Gonzalo',
];
const APELLIDOS = [
  'Gómez',
  'Fernández',
  'Rodríguez',
  'López',
  'Martínez',
  'Sosa',
  'Benítez',
  'Acosta',
  'Silva',
  'Cabrera',
  'Ramírez',
  'Duarte',
  'Villalba',
  'Ojeda',
  'Vera',
  'Aguirre',
  'Escobar',
  'Maidana',
  'Ferreyra',
  'Zaracho',
  'Insaurralde',
  'Rojas',
  'Coronel',
  'Britos',
  'Almirón',
  'Núñez',
  'Paredes',
  'Segovia',
];
const CALLES = [
  'Bolívar',
  'Ayacucho',
  'Junín',
  'Córdoba',
  'Colón',
  'San Lorenzo',
  'Buenos Aires',
  'La Rioja',
  'Sarmiento',
  'Tucumán',
  'Santa Fe',
  'Entre Ríos',
  'Corrientes',
  'Salta',
  'Jujuy',
  'Catamarca',
  'San Martín',
  'Uruguay',
  'Rivadavia',
  'Mitre',
  'Belgrano',
  'French',
  'Alberdi',
  'Azara',
  'Tacuarí',
  'Chacabuco',
  'Alvear',
  'Roque Pérez',
  'Larrea',
  'Santiago del Estero',
];
const INDICACIONES = [
  'Portón negro, tocar timbre dos veces',
  'Casa del fondo, pasillo a la izquierda',
  'Al lado del almacén, rejas verdes',
  'Timbre roto, llamar por teléfono al llegar',
  'Dejar en la despensa de la esquina si no hay nadie',
  'Segundo piso, departamento B',
  'Frente a la plaza, casa de material sin revoque',
  null,
];

/**
 * Barrios de Posadas como rectángulos. El pedido valida que la dirección caiga
 * dentro de una zona activa, así que los clientes se ubican adentro a propósito:
 * si mañana se crea un pedido desde la app, la validación pasa.
 */
const BARRIOS = [
  {
    nombre: 'Centro',
    lngMin: -55.91,
    lngMax: -55.88,
    latMin: -27.38,
    latMax: -27.355,
    recargo: 0,
  },
  {
    nombre: 'Villa Cabello',
    lngMin: -55.94,
    lngMax: -55.905,
    latMin: -27.41,
    latMax: -27.38,
    recargo: 900,
  },
  {
    nombre: 'Itaembé Miní',
    lngMin: -55.99,
    lngMax: -55.94,
    latMin: -27.43,
    latMax: -27.39,
    recargo: 1800,
  },
];

/** El catálogo del negocio: 5, 10, 15, 25 y 45 kg. */
const CATALOGO = [
  {
    type: 'Garrafa 5kg',
    weight: 5,
    price: 16000,
    containerPrice: 120000,
    stock: 140,
    description:
      'Envase de 5 kg. El más chico, para consumo puntual, camping o un anafe.',
    promotions: [{ quantity: 4, discountPercentage: 8 }],
  },
  {
    type: 'Garrafa 10kg',
    weight: 10,
    price: 29000,
    containerPrice: 165000,
    stock: 260,
    description:
      'Envase de 10 kg. El de mayor rotación: cocina y calefacción de un hogar chico.',
    promotions: [
      { quantity: 2, discountPercentage: 5 },
      { quantity: 4, discountPercentage: 12 },
    ],
  },
  {
    type: 'Garrafa 15kg',
    weight: 15,
    price: 44000,
    containerPrice: 210000,
    stock: 95,
    description:
      'Envase de 15 kg. Familias grandes y comercios con consumo sostenido.',
    promotions: [{ quantity: 2, discountPercentage: 7 }],
  },
  {
    type: 'Garrafa 25kg',
    weight: 25,
    price: 72000,
    containerPrice: 300000,
    stock: 40,
    description:
      'Envase de 25 kg. Uso comercial: parrillas, panaderías y hotelería.',
    promotions: [{ quantity: 3, discountPercentage: 10 }],
  },
  {
    type: 'Garrafa 45kg',
    weight: 45,
    price: 110000,
    containerPrice: 420000,
    stock: 24,
    description:
      'Envase de 45 kg. Industria y gran consumo: cocinas de restaurante, lavaderos y secaderos.',
    promotions: [{ quantity: 2, discountPercentage: 6 }],
  },
] as const;

const FRANJAS = [
  { name: 'Mañana', startTime: '08:00', endTime: '12:00', capacity: 60 },
  { name: 'Mediodía', startTime: '12:00', endTime: '16:00', capacity: 40 },
  { name: 'Tarde', startTime: '16:00', endTime: '20:00', capacity: 60 },
  { name: 'Noche', startTime: '20:00', endTime: '22:00', capacity: 20 },
];

const MOTIVOS_RECLAMO = [
  'Garrafa con pérdida de gas',
  'Entrega fuera de la franja acordada',
  'Envase abollado',
  'Cobraron un precio distinto al de la app',
  'Faltó una garrafa del pedido',
  'Mala atención del repartidor',
];
const MOTIVOS_CANCELACION = [
  'El cliente ya no necesitaba el pedido',
  'Sin stock del producto solicitado',
  'Dirección fuera de la zona de cobertura',
  'El cliente no respondió al llamado',
  'Demora excesiva, el cliente compró en otro lado',
];

const DOMINIOS_DE_CORREO = [
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'yahoo.com.ar',
];

/** `nombre.apellido` sin tildes ni caracteres raros, para armar un correo verosímil. */
const correoDe = (pila: string, apellido: string): string =>
  `${pila}.${apellido}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z.]/g, '');

const hoy = new Date();
const diasAtras = (d: number, hora = 10) => {
  const f = new Date(hoy);
  f.setDate(f.getDate() - d);
  f.setHours(hora, entre(0, 59), entre(0, 59), 0);
  return f;
};
const soloFecha = (f: Date) => f.toISOString().slice(0, 10);
const masMinutos = (f: Date, m: number) => new Date(f.getTime() + m * 60000);

// ─────────────────────────────────────────────────────────────────────────────

const ds = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  synchronize: false,
  // Mantenimiento: el seed purga y reconstruye la demo, y su auditoría la deja
  // armada a propósito (`lib/auditoria-demo.ts`). Las conexiones del seed no
  // dejan los asientos de los triggers (altas y bajas «de sistema» que taparían
  // la auditoría curada); el guardia de producción ya frenó antes de llegar acá.
  // El trigger sólo lo respeta si el usuario es superusuario o miembro del rol
  // `splg_mantenimiento`; en local `postgres` es superusuario.
  extra: {
    application_name: 'splg-script:seed-demo',
    options: '-c splg.audit_off=on',
  },
});

const resumen: Array<[string, number]> = [];

/** S3 (o MinIO) para las fotos de ejemplo; `null` si el entorno no lo configura. */
// Subir o borrar en el bucket es destructivo si la base es una copia de otra
// (los ids apuntan a los mismos objetos): sólo con la bandera explícita.
const almacen: AlmacenDemo | null =
  process.env.SEED_S3 === '1' ? crearAlmacenDemo() : null;
if (process.env.SEED_S3 !== '1') {
  console.log(
    '  · S3 apagado: el seed no sube ni borra archivos (SEED_S3=1 para usarlo)',
  );
}
let fotosSubidas = 0;

/**
 * Sube una imagen de ejemplo y deja la key en la fila. Sin S3 configurado no
 * hace nada: la fila queda sin foto (nunca con una URL inventada).
 */
async function adjuntarFoto(
  q: Q,
  fila: {
    tabla: string;
    columnaId: string;
    id: string;
    columnaKey: string;
  },
  carpeta: string,
  figura: FiguraDemo,
  variante: number,
): Promise<void> {
  if (!almacen) return;
  const key = almacen.nuevaKey(carpeta);
  // Se anota antes de subir (como la app): si algo cae a mitad, el cron o una
  // purga pueden limpiar el objeto. Se confirma cuando la fila ya lo referencia.
  await q(
    `INSERT INTO storage_orphan (storage_key, kind, status, next_attempt_at)
     VALUES ($1, 'upload', 'pending', now() + interval '1 hour')
     ON CONFLICT (storage_key) DO NOTHING`,
    [key],
  );
  await almacen.subirPng(key, generarImagenDemo({ figura, variante }));
  await q(
    `UPDATE "${fila.tabla}" SET "${fila.columnaKey}" = $1 WHERE "${fila.columnaId}" = $2`,
    [key, fila.id],
  );
  await q(`DELETE FROM storage_orphan WHERE storage_key = $1`, [key]);
  fotosSubidas += 1;
}

/** Dónde guarda cada entidad la key de su foto en el bucket. */
const COLUMNAS_DE_FOTO: Array<[tabla: string, columna: string]> = [
  ['claims', 'photo_key'],
  ['incident', 'photo_key'],
  ['gas_cylinder', 'photo_key'],
  ['car', 'photo_key'],
  ['distributor', 'logo_key'],
  ['user', 'photo_key'],
  ['employee', 'photo_key'],
  ['attachment', 'storage_key'],
  ['maintenance_task_attachment', 'storage_key'],
];

let avisoDePurgaDado = false;

/** Objetos de corridas anteriores que hay que borrar cuando sus filas ya no estén. */
const clavesAnteriores = new Set<string>();

/**
 * Anota (sin borrar nada) las fotos que el seed anterior dejó en la
 * distribuidora y en sus usuarios de demostración. El objeto se borra recién
 * en `borrarObjetosSinFila`, cuando la base ya confirmó que la fila no está.
 */
async function anotarFotosAnteriores(
  q: Q,
  distId: string,
  personas: string[],
): Promise<void> {
  if (!almacen) return;
  if (!purgaS3Habilitada()) {
    if (!avisoDePurgaDado) {
      console.warn(
        '  ! No se borra ningún objeto de S3 (falta SEED_PURGE_S3=1): las fotos de corridas anteriores quedan en el bucket.',
      );
      avisoDePurgaDado = true;
    }
    return;
  }
  const consultas = [
    `SELECT photo_key AS key FROM claims WHERE distributor_id = $1`,
    `SELECT photo_key AS key FROM incident WHERE distributor_id = $1`,
    `SELECT photo_key AS key FROM gas_cylinder WHERE distributor_id = $1`,
    `SELECT photo_key AS key FROM car WHERE distributor_id = $1`,
    `SELECT logo_key AS key FROM distributor WHERE distributor_id = $1`,
    `SELECT photo_key AS key FROM employee WHERE distributor_id = $1`,
    `SELECT storage_key AS key FROM attachment WHERE distributor_id = $1`,
    `SELECT storage_key AS key FROM maintenance_task_attachment WHERE distributor_id = $1`,
  ];
  for (const sql of consultas) {
    const filas: Array<{ key: string | null }> = await q(sql, [distId]);
    for (const f of filas) if (f.key) clavesAnteriores.add(f.key);
  }
  const usuarios: Array<{ key: string | null }> = await q(
    `SELECT photo_key AS key FROM "user" WHERE user_id = ANY($1::uuid[])`,
    [personas],
  );
  for (const f of usuarios) if (f.key) clavesAnteriores.add(f.key);
}

/**
 * Borra de S3 las fotos anotadas que ninguna fila referencia ya. Va DESPUÉS de
 * los borrados de filas: si el seed falla a mitad de camino, las filas que
 * sobrevivan siguen apuntando a un objeto que existe.
 */
async function borrarObjetosSinFila(
  q: Q,
  distIds: string[],
  personas: string[],
): Promise<void> {
  if (!almacen || !purgaS3Habilitada() || clavesAnteriores.size === 0) return;
  const vigentes = new Set<string>();
  for (const [tabla, columna] of COLUMNAS_DE_FOTO) {
    const filas: Array<{ key: string | null }> = await q(
      `SELECT "${columna}" AS key FROM "${tabla}" WHERE "${columna}" IS NOT NULL`,
    );
    for (const f of filas) if (f.key) vigentes.add(f.key);
  }
  // Sólo se borra lo que está bajo un prefijo EXACTO de la demo
  // (`<carpeta>/<id de la distribuidora>/`, o `users/<id>/` de las personas que
  // se quitan): nunca un objeto de otro origen.
  const aBorrar: string[] = [];
  const ajenas: string[] = [];
  for (const key of clavesAnteriores) {
    if (vigentes.has(key)) continue;
    const propia = keyEsDeLaDemo(key, distIds, personas);
    (propia ? aBorrar : ajenas).push(key);
  }
  if (ajenas.length > 0) {
    console.warn(
      `  ! ${ajenas.length} objetos de S3 no están bajo el prefijo de la demo y no se tocaron`,
    );
  }
  await almacen.borrar(aBorrar);
  console.log(`  · S3: ${aBorrar.length} objetos de la demo anterior borrados`);
  clavesAnteriores.clear();
}

async function main() {
  resguardoDeProduccion();
  await ds.initialize();
  const q = (sql: string, params: any[] = []) => ds.query(sql, params);

  // ── 1. La distribuidora ────────────────────────────────────────────────────
  const [dist] = await q(
    `SELECT distributor_id, name FROM distributor WHERE slug = $1 AND "deletedAt" IS NULL`,
    [SLUG],
  );
  if (!dist) {
    throw new Error(
      `No existe la distribuidora '${SLUG}'. Corré primero: npm run seed`,
    );
  }
  const distId: string = dist.distributor_id;
  console.log(`\nDistribuidora: ${dist.name} (${SLUG})`);

  // ── 2. Purga completa y nombres reales de las cuentas con login ────────────
  const purga = await purgar(q, distId);
  resumen.push([
    'usuarios de demostración anteriores quitados',
    purga.usuariosBorrados,
  ]);
  if (purga.usuariosArchivados > 0) {
    console.log(
      `  · ${purga.usuariosArchivados} usuarios quedaron archivados: algo ajeno al seed los referencia`,
    );
  }
  await renombrarCuentasEnBase(ds.manager);

  // ── 3. Catálogo ────────────────────────────────────────────────────────────
  const productos: Array<{
    id: string;
    type: string;
    price: number;
    weight: number;
  }> = [];
  for (const p of CATALOGO) {
    const [row] = await q(
      `INSERT INTO gas_cylinder
         (distributor_id, type, weight, price, container_price, stock, description, "isActive")
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       RETURNING gas_cylinder_id`,
      [
        distId,
        p.type,
        p.weight,
        p.price,
        p.containerPrice,
        p.stock,
        p.description,
      ],
    );
    for (const promo of p.promotions) {
      await q(
        `INSERT INTO gas_cylinder_promotion (gas_cylinder_id, quantity, discount_percentage)
         VALUES ($1,$2,$3)`,
        [row.gas_cylinder_id, promo.quantity, promo.discountPercentage],
      );
    }
    productos.push({
      id: row.gas_cylinder_id,
      type: p.type,
      price: p.price,
      weight: p.weight,
    });
    // Foto a todos menos al último, para ver también el producto sin imagen.
    if (productos.length < CATALOGO.length) {
      await adjuntarFoto(
        q,
        {
          tabla: 'gas_cylinder',
          columnaId: 'gas_cylinder_id',
          id: row.gas_cylinder_id,
          columnaKey: 'photo_key',
        },
        `gascylinders/${distId}/${row.gas_cylinder_id}`,
        'garrafa',
        productos.length,
      );
    }
  }
  resumen.push(['gas_cylinder (catálogo)', productos.length]);

  // Logo de la distribuidora (reemplaza al `logo_url` de texto).
  await adjuntarFoto(
    q,
    {
      tabla: 'distributor',
      columnaId: 'distributor_id',
      id: distId,
      columnaKey: 'logo_key',
    },
    `distributors/${distId}/logo`,
    'logo',
    0,
  );

  // ── 4. Franjas horarias ────────────────────────────────────────────────────
  const franjas: string[] = [];
  for (const f of FRANJAS) {
    const [row] = await q(
      `INSERT INTO time_slot (distributor_id, name, "startTime", "endTime", capacity, "isActive")
       VALUES ($1,$2,$3,$4,$5,true) RETURNING time_slot_id`,
      [distId, f.name, f.startTime, f.endTime, f.capacity],
    );
    franjas.push(row.time_slot_id);
  }
  resumen.push(['time_slot (franjas)', franjas.length]);

  // ── 5. Zonas de cobertura ──────────────────────────────────────────────────
  const zonas = new Map<string, string>();
  for (const [i, b] of BARRIOS.entries()) {
    const anillo = [
      [b.lngMin, b.latMin],
      [b.lngMax, b.latMin],
      [b.lngMax, b.latMax],
      [b.lngMin, b.latMax],
      [b.lngMin, b.latMin],
    ];
    const [zona] = await q(
      `INSERT INTO coverage_zone (distributor_id, name, area, surcharge_type, surcharge_value, "isActive", priority)
       VALUES ($1,$2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), 'fixed', $4, true, $5)
       RETURNING coverage_zone_id`,
      [
        distId,
        b.nombre,
        JSON.stringify({ type: 'Polygon', coordinates: [anillo] }),
        b.recargo,
        // Una prioridad distinta por zona activa (UQ_coverage_zone_prioridad_activa).
        i + 1,
      ],
    );
    zonas.set(b.nombre, zona.coverage_zone_id);
  }
  resumen.push(['coverage_zone (zonas)', BARRIOS.length]);

  // ── 6. Clientes ────────────────────────────────────────────────────────────
  const [rolCliente] = await q(
    `SELECT role_id FROM role WHERE type = 'customer'`,
  );
  const clientes = await sembrarClientes(q, rolCliente?.role_id ?? null, zonas);
  resumen.push(['customer (clientes)', clientes.length]);
  resumen.push([
    'user_address (direcciones)',
    clientes.reduce((n, c) => n + c.direcciones.length, 0),
  ]);

  // ── 7. Choferes y vehículos ────────────────────────────────────────────────
  const [admin] = await q(
    `SELECT u.user_id, u.full_name FROM "user" u
       JOIN admin a ON a.user_id = u.user_id
      WHERE a.distributor_id = $1 AND lower(u.email) = $2 AND u."deletedAt" IS NULL`,
    [distId, EMAIL_DEL_ADMIN],
  );
  if (!admin) {
    throw new Error(
      `La distribuidora '${SLUG}' no tiene al administrador ${EMAIL_DEL_ADMIN}. Corré primero: npm run seed`,
    );
  }
  const choferes = await sembrarChoferes(q, distId, admin.user_id);

  // ── 8. Pedidos y todo lo que cuelga de ellos ───────────────────────────────
  const pedidos = await sembrarPedidos(
    q,
    distId,
    admin.user_id,
    clientes,
    productos,
    franjas,
    choferes,
  );
  await bloquearAlgunosClientes(q, clientes, pedidos);
  await sembrarReclamos(q, distId, pedidos);
  await sembrarIncidencias(q, distId, admin.user_id, pedidos, choferes);
  await sembrarCalificaciones(q, distId, pedidos);

  // ── 9. Envases físicos ─────────────────────────────────────────────────────
  await sembrarEnvases(q, distId, productos, clientes, pedidos);
  await ajustarStock(q, distId);

  // ── 10. Personal, flota, stock, compras, cargas y auditoría ────────────────
  const eventos: EventoDeAuditoria[] = [];
  const personal = await ds.transaction((m) =>
    sembrarPersonal(
      m,
      distId,
      choferes.map((c) => ({
        userId: c.userId,
        nombre: c.nombre,
        dni: c.dni,
        telefono: c.telefono,
      })),
      admin.user_id,
      admin.full_name,
    ),
  );
  resumen.push(['employee (legajos)', personal.total]);
  choferes.forEach((c, i) => {
    c.ayudanteId = i < 2 ? (personal.ayudantes[i] ?? null) : null;
  });
  for (const e of personal.empleados) {
    eventos.push({
      entidad: 'Employee',
      recordId: e.id,
      accion: 1,
      cuando: e.ingreso,
      campos: [['fullName', null, e.nombre]],
    });
  }

  const pedidosParaStock = pedidos.map((p) => ({
    id: p.id,
    estado: p.estado,
    entregadoEl: p.entregadoEl,
    deliveryId: p.deliveryId,
    carId: p.carId,
    items: p.items,
  }));
  const stock = await sembrarStockHistoria(ds, {
    distributorId: distId,
    adminUserId: admin.user_id,
    productos,
    pedidos: pedidosParaStock,
    choferes: choferes.map((c) => ({
      deliveryId: c.deliveryId,
      userId: c.userId,
      carId: c.carId,
      ayudanteId: c.ayudanteId,
    })),
  });
  resumen.push(['warehouse (depósitos)', stock.depositos]);
  resumen.push(['stock_threshold (mínimos)', stock.umbrales]);
  resumen.push([
    'stock_movement: conteo inicial (renglones)',
    stock.conteoInicial,
  ]);
  resumen.push(['stock_movement: entregas en el libro', stock.entregasEnLibro]);
  resumen.push(['transferencias entre depósitos', stock.transferencias]);
  resumen.push(['stock_adjustment (ajustes)', stock.ajustes]);
  resumen.push(['supplier (proveedores)', stock.proveedores]);
  resumen.push(['purchase_order (órdenes de compra)', stock.ordenesDeCompra]);
  resumen.push(['purchase_receipt (recepciones)', stock.recepciones]);
  resumen.push(['truck_load (cargas del camión)', stock.cargasDeCamion]);
  eventos.push(
    ...stock.documentos.map((d) => ({
      entidad: d.entidad,
      recordId: d.id,
      accion: 1 as const,
      cuando: d.cuando,
      campos: Object.entries(d.detalle).map(
        ([campo, valor]): [string, string | null, string | null] => [
          campo,
          null,
          valor,
        ],
      ),
    })),
  );

  // El remito de algunas recepciones, como archivo en S3.
  for (const r of stock.recepcionesIds.slice(0, 2)) {
    await adjuntarRemito(q, distId, admin.user_id, r.receiptId, r.numero);
  }

  // Mantenimiento y uso de la flota.
  const flota = choferes.map((c) => ({
    carId: c.carId,
    deliveryId: c.deliveryId,
    km: c.km,
  }));
  const mantenimiento = await ds.transaction((m) =>
    sembrarMantenimiento(m, distId, flota),
  );
  resumen.push([
    'maintenance_plan / maintenance_task',
    mantenimiento.planes + mantenimiento.tareas,
  ]);
  const uso = await ds.transaction((m) =>
    sembrarUsoDeFlota(
      m,
      distId,
      pedidos
        .filter((p) => p.estado === 'delivered' && p.carId && p.entregadoEl)
        .map((p) => ({ carId: p.carId!, dia: diaArgentino(p.entregadoEl!) })),
    ),
  );
  resumen.push(['vehicle_usage_log (uso diario)', uso]);

  // Auditoría: altas de los vehículos, y un cambio de precio con valor anterior.
  for (const c of choferes) {
    eventos.push({
      entidad: 'Car',
      recordId: c.carId,
      accion: 1,
      cuando: diasAtras(entre(120, 300)),
      campos: [
        ['carPatent', null, c.patente],
        ['carBrand', null, c.marca],
      ],
    });
  }
  const chica = productos.find((p) => p.weight === 10);
  if (chica) {
    eventos.push({
      entidad: 'GasCylinder',
      recordId: chica.id,
      accion: 2,
      cuando: diasAtras(75),
      campos: [
        ['price', String(Math.round(chica.price * 0.92)), String(chica.price)],
      ],
    });
  }
  const auditoria = await ds.transaction((m) =>
    sembrarAuditoria(m, {
      distributorId: distId,
      adminUserId: admin.user_id,
      eventos,
    }),
  );
  resumen.push([
    'audit / audit_detail / audit_log',
    auditoria.audit + auditoria.detalles + auditoria.bitacora,
  ]);

  await verificarConciliacion(q, distId);
  // Recién ahora, con la siembra y la conciliación cerradas, se borra de S3.
  await borrarObjetosSinFila(q, distribuidorasPurgadas, personasPurgadas);
  imprimirResumen();
}

async function purgar(q: Q, distId: string) {
  const otras: Array<{
    distributor_id: string;
    name: string;
    slug: string;
    pedidos: number;
    productos: number;
    choferes: number;
    admins: number;
  }> = SOLO_UNA
    ? await q(
        `SELECT d.distributor_id, d.name, d.slug,
                (SELECT count(*) FROM "order" o WHERE o.distributor_id = d.distributor_id)::int AS pedidos,
                (SELECT count(*) FROM gas_cylinder g WHERE g.distributor_id = d.distributor_id)::int AS productos,
                (SELECT count(*) FROM delivery x WHERE x.distributor_id = d.distributor_id)::int AS choferes,
                (SELECT count(*) FROM admin a WHERE a.distributor_id = d.distributor_id)::int AS admins
           FROM distributor d WHERE d.distributor_id <> $1 ORDER BY d.slug`,
        [distId],
      )
    : [];
  if (otras.length > 0) {
    const esperado = otras.map((d) => d.slug).join(',');
    const dado = (process.env.CONFIRMAR_DISTRIBUIDORAS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .sort()
      .join(',');
    if (dado !== esperado) {
      throw new Error(
        'Con SEED_SINGLE_TENANT=true el seed BORRA las otras distribuidoras:\n' +
          otras
            .map(
              (d) =>
                `    - ${d.slug} (${d.name}): ${d.pedidos} pedidos, ${d.productos} productos, ${d.choferes} choferes, ${d.admins} admins`,
            )
            .join('\n') +
          `\n  Si es lo que querés, repetí con CONFIRMAR_DISTRIBUIDORAS=${esperado}` +
          '\n  (o con SEED_SINGLE_TENANT=false para no tocarlas). No se cambió nada.',
      );
    }
  }
  const idsDeDistribuidoras = [distId, ...otras.map((d) => d.distributor_id)];

  // Alcance explícito de las personas que se quitan (nunca "todo usuario sin login").
  // Con una sola distribuidora también salen las cuentas con login fuera de la lista.
  const fuera: Array<{ user_id: string }> = SOLO_UNA
    ? await q(
        `SELECT user_id FROM "user" WHERE firebase_uid IS NOT NULL AND NOT (lower(email) = ANY($1::text[]))`,
        [CUENTAS_CON_LOGIN.map((c) => c.email.toLowerCase())],
      )
    : [];
  const personas = await personasSinLoginDeAlcance(
    ds.manager,
    idsDeDistribuidoras,
    fuera.map((f) => f.user_id),
  );
  // Usuarios sin login ni perfil ni pedidos en ninguna distribuidora: no se sabe de
  // quién son. Se listan y NO se tocan, salvo confirmación aparte.
  const huerfanos = await huerfanosSinLogin(ds.manager, personas);
  if (huerfanos.length > 0) {
    console.log(
      `\n  ! ${huerfanos.length} usuarios sin login, sin perfil y sin pedidos (no se sabe de quién son):`,
    );
    for (const h of huerfanos.slice(0, 20)) {
      console.log(`      - ${h.email ?? '(sin correo)'}  ${h.full_name ?? ''}`);
    }
    if (huerfanos.length > 20)
      console.log(`      ... y ${huerfanos.length - 20} más`);
    if (
      SOLO_UNA &&
      process.env.CONFIRMAR_HUERFANOS === String(huerfanos.length)
    ) {
      personas.push(...huerfanos.map((h) => h.user_id));
      console.log('    CONFIRMAR_HUERFANOS coincide: también se quitan.');
    } else {
      console.log(
        `    No se tocan. Para quitarlos: CONFIRMAR_HUERFANOS=${huerfanos.length} (sólo con SEED_SINGLE_TENANT=true).`,
      );
    }
  }
  await anotarFotosAnteriores(q, distId, personas);
  for (const d of otras)
    await anotarFotosAnteriores(q, d.distributor_id, personas);

  const [cliente] = await q(
    `SELECT user_id FROM "user" WHERE lower(email) = 'cliente@splg.com'`,
  );
  const resultado = await ds.transaction(async (m) => {
    // Con una sola distribuidora, las únicas cuentas con login son las conocidas.
    if (SOLO_UNA) {
      const sacadas = await darDeBajaFueraDeLaLista(m);
      if (sacadas.length > 0) {
        console.log(
          `  · ${sacadas.length} cuentas con login fuera de la lista quedaron dadas de baja`,
        );
      }
    }
    if (otras.length > 0) {
      await purgarDistribuidoras(
        m,
        otras.map((d) => d.distributor_id),
        { borrarDistribuidoras: true },
      );
    }
    await purgarDistribuidoras(m, [distId], { auditoriaGlobal: SOLO_UNA });
    // El logo se reemplaza en el lugar (la fila de la distribuidora queda).
    await m.query(
      `UPDATE distributor SET logo_key = NULL WHERE distributor_id = $1`,
      [distId],
    );
    if (CANT_CHOFERES === 0) {
      await m.query(`DELETE FROM delivery WHERE distributor_id = $1`, [distId]);
    }
    return purgarPersonasSinLogin(
      m,
      personas,
      cliente ? [cliente.user_id] : [],
      idsDeDistribuidoras,
    );
  });
  personasPurgadas = personas;
  for (const d of otras) console.log(`  · se quitó la distribuidora ${d.name}`);
  distribuidorasPurgadas = [distId, ...otras.map((d) => d.distributor_id)];
  return resultado;
}

/** Para borrar de S3 al final, cuando la siembra y la conciliación ya cerraron. */
let distribuidorasPurgadas: string[] = [];
let personasPurgadas: string[] = [];

/**
 * La conciliación de stock tiene que dar consistente: el vendible de cada
 * producto es lo físico menos lo reservado (`vendible − déficit = llenas −
 * reservadas`). Es la misma cuenta de `GET /stock/reconciliation`. Si no cierra,
 * el seed falla en lugar de dejar una demo inconsistente.
 */
async function verificarConciliacion(q: Q, distId: string) {
  const filas: Array<{
    type: string;
    stock: number;
    deficit: number;
    llenas: number;
    reservadas: number;
  }> = await q(
    `SELECT g.type, g.stock, g.reservation_deficit AS deficit,
            COALESCE((SELECT SUM(b.quantity) FROM stock_balance b
                       WHERE b.gas_cylinder_id = g.gas_cylinder_id AND b.condition = 'full'), 0)::int AS llenas,
            COALESCE((SELECT SUM(i.quantity) FROM order_item i JOIN "order" o ON o.order_id = i.order_id
                       WHERE i.gas_cylinder_id = g.gas_cylinder_id
                         AND o.status IN ('reserved','pending','accepted','on_the_way')), 0)::int AS reservadas
       FROM gas_cylinder g WHERE g.distributor_id = $1 ORDER BY g.type`,
    [distId],
  );
  const malas = filas.filter(
    (f) => f.stock - f.deficit !== f.llenas - f.reservadas,
  );
  if (malas.length > 0) {
    throw new Error(
      'La conciliación de stock no cierra: ' +
        malas
          .map(
            (f) =>
              `${f.type} (vendible ${f.stock}, déficit ${f.deficit}, llenas ${f.llenas}, reservadas ${f.reservadas})`,
          )
          .join('; '),
    );
  }
  console.log('\nConciliación de stock: consistente');
  for (const f of filas) {
    console.log(
      `  ${f.type.padEnd(14)} vendible ${String(f.stock).padStart(4)} = llenas ${String(f.llenas).padStart(4)} − reservadas ${String(f.reservadas).padStart(3)}`,
    );
  }
}

/** Sube el remito (PNG de ejemplo) de una recepción como adjunto de la compra. */
async function adjuntarRemito(
  q: Q,
  distId: string,
  adminId: string,
  receiptId: string,
  numero: string,
): Promise<void> {
  if (!almacen) return;
  const key = `attachments/${distId}/purchase_receipt/${receiptId}/${randomUUID()}.png`;
  await q(
    `INSERT INTO storage_orphan (storage_key, kind, status, next_attempt_at)
     VALUES ($1, 'upload', 'pending', now() + interval '1 hour')
     ON CONFLICT (storage_key) DO NOTHING`,
    [key],
  );
  const png = generarImagenDemo({ figura: 'aviso', variante: 3 });
  await almacen.subirPng(key, png);
  await q(
    `INSERT INTO attachment
       (distributor_id, owner_type, owner_id, label, storage_key, original_name, mime_type, size_bytes, uploaded_by_user_id)
     VALUES ($1, 'purchase_receipt', $2, 'Remito de la planta', $3, $4, 'image/png', $5, $6)`,
    [distId, receiptId, key, `remito-${numero}.png`, png.length, adminId],
  );
  await q(`DELETE FROM storage_orphan WHERE storage_key = $1`, [key]);
  fotosSubidas += 1;
}

// ─────────────────────────────────────────────────────────────────────────────

type Q = (sql: string, params?: any[]) => Promise<any>;

interface ClienteSembrado {
  userId: string;
  nombre: string;
  direcciones: Array<{
    id: string;
    lat: number;
    lng: number;
    recargo: number;
    zonaId: string | null;
    zona: string;
  }>;
}

interface ChoferSembrado {
  deliveryId: string;
  userId: string;
  nombre: string;
  dni: string;
  telefono: string;
  carId: string;
  patente: string;
  marca: string;
  modelo: string;
  km: number;
  ayudanteId: string | null;
}

interface PedidoSembrado {
  id: string;
  clienteUserId: string;
  choferUserId: string | null;
  deliveryId: string | null;
  carId: string | null;
  estado: string;
  entregadoEl: Date | null;
  creadoEl: Date;
  total: number;
  items: Array<{ gasCylinderId: string; quantity: number }>;
}

async function sembrarClientes(
  q: Q,
  roleId: string | null,
  zonas: Map<string, string>,
): Promise<ClienteSembrado[]> {
  const clientes: ClienteSembrado[] = [];

  // El cliente con login real ya existe; entra como uno más de los 25 para que
  // tenga direcciones y pedidos como el resto.
  const conLogin = await q(
    `SELECT u.user_id, u.full_name
       FROM "user" u
       JOIN customer c ON c.user_id = u.user_id
      WHERE u.firebase_uid IS NOT NULL AND u."deletedAt" IS NULL
        AND lower(u.email) = ANY($1::text[])`,
    [CUENTAS_CON_LOGIN.map((c) => c.email.toLowerCase())],
  );
  for (const u of conLogin) {
    clientes.push({ userId: u.user_id, nombre: u.full_name, direcciones: [] });
  }

  const usados = new Set<string>();
  let i = 0;
  while (clientes.length < CANT_CLIENTES) {
    const pila = alguno(NOMBRES);
    const apellido = alguno(APELLIDOS);
    const nombre = `${pila} ${apellido}`;
    const clave = correoDe(pila, apellido);
    if (usados.has(clave)) continue;
    usados.add(clave);
    i += 1;

    const email = `${clave}${i}@${alguno(DOMINIOS_DE_CORREO)}`;
    const telefono = `+54376${String(4500000 + i).slice(0, 7)}`;
    const alta = diasAtras(entre(95, 400));

    const [u] = await q(
      `INSERT INTO "user"
         (role_id, full_name, email, phone_number, phone_verified, email_verified, blocked, "createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING user_id`,
      [roleId, nombre, email, telefono, quizas(0.7), quizas(0.85), false, alta],
    );
    await q(
      `INSERT INTO customer (user_id, "createdAt")
       VALUES ($1,$2)`,
      [u.user_id, alta],
    );
    clientes.push({ userId: u.user_id, nombre, direcciones: [] });
  }

  // Direcciones: una principal y, a veces, una segunda.
  for (const c of clientes) {
    const cuantas = quizas(0.35) ? 2 : 1;
    for (let n = 0; n < cuantas; n++) {
      const b = alguno(BARRIOS);
      const lat = b.latMin + azar() * (b.latMax - b.latMin);
      const lng = b.lngMin + azar() * (b.lngMax - b.lngMin);
      const calle = `${alguno(CALLES)} ${entre(100, 4200)}`;
      const [a] = await q(
        `INSERT INTO user_address
           (user_id, street, city, "postalCode", location,
            "formattedAddress", "isDefault", "additionalInstructions")
         VALUES ($1,$2,'Posadas','3300',ST_SetSRID(ST_MakePoint($4,$3),4326),$5,$6,$7)
         RETURNING address_id`,
        [
          c.userId,
          calle,
          Number(lat.toFixed(6)),
          Number(lng.toFixed(6)),
          `${calle}, ${b.nombre}, Posadas, Misiones`,
          n === 0,
          alguno(INDICACIONES),
        ],
      );
      c.direcciones.push({
        id: a.address_id,
        lat,
        lng,
        recargo: b.recargo,
        zonaId: zonas.get(b.nombre) ?? null,
        zona: b.nombre,
      });
    }
  }
  return clientes;
}

/**
 * Choferes con su vehículo en uso. La cuenta con login (`chofer@splg.com`) se
 * conserva y toma el primer lugar de la lista; el resto son personas sembradas
 * sin cuenta en Firebase (el panel las muestra igual).
 */
async function sembrarChoferes(
  q: Q,
  distId: string,
  adminUserId: string,
): Promise<ChoferSembrado[]> {
  const choferes: ChoferSembrado[] = [];
  if (CANT_CHOFERES <= 0) return choferes;

  const [rolChofer] = await q(
    `SELECT role_id FROM role WHERE type = 'delivery'`,
  );
  const conLogin: Array<{
    user_id: string;
    delivery_id: string;
    email: string;
  }> = await q(
    `SELECT u.user_id, d.delivery_id, lower(u.email) AS email
       FROM "user" u JOIN delivery d ON d.user_id = u.user_id
      WHERE d.distributor_id = $1 AND u.firebase_uid IS NOT NULL AND u."deletedAt" IS NULL`,
    [distId],
  );

  for (let i = 0; i < CANT_CHOFERES; i++) {
    const c = CHOFERES_DE_LA_DEMO[i];
    const v = c.vehiculo;
    const login = c.emailLogin
      ? conLogin.find((l) => l.email === c.emailLogin)
      : undefined;
    const alta = diasAtras(entre(300, 900));
    let userId: string;
    let deliveryId: string;
    const ubicacion = [
      Number((BARRIOS[0].latMin + azar() * 0.02).toFixed(6)),
      Number((BARRIOS[0].lngMin + azar() * 0.02).toFixed(6)),
    ];
    if (login) {
      userId = login.user_id;
      deliveryId = login.delivery_id;
      await q(
        `UPDATE delivery
            SET validated = true, "isActive" = true, "isEnabled" = true, "isAvailable" = true,
                calification = $2, balance = 0,
                location = ST_SetSRID(ST_MakePoint($4,$3),4326)
          WHERE delivery_id = $1`,
        [deliveryId, 4.8, ubicacion[0], ubicacion[1]],
      );
    } else {
      const [pila, ...resto] = c.nombre.split(' ');
      const correo = `${correoDe(pila, resto.join(''))}@gmail.com`;
      const [u] = await q(
        `INSERT INTO "user"
           (role_id, full_name, email, phone_number, phone_verified, email_verified, "createdAt")
         VALUES ($1,$2,$3,$4,true,true,$5) RETURNING user_id`,
        [rolChofer?.role_id ?? null, c.nombre, correo, c.telefono, alta],
      );
      userId = u.user_id;
      const [d] = await q(
        `INSERT INTO delivery
           (distributor_id, user_id, validated, "isActive", calification, balance, location, "createdAt")
         VALUES ($1,$2,true,true,$3,$4,ST_SetSRID(ST_MakePoint($6,$5),4326),$7) RETURNING delivery_id`,
        [
          distId,
          userId,
          Number((4.1 + azar() * 0.8).toFixed(2)),
          0,
          ubicacion[0],
          ubicacion[1],
          alta,
        ],
      );
      deliveryId = d.delivery_id;
    }

    const [car] = await q(
      `INSERT INTO car
         (distributor_id, user_id, type_car, car_capacity, car_patent, car_brand, car_model, car_year,
          car_color, tare_weight_kg, max_load_kg, odometer_km, fleet_status, in_service_since, "createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13,$13) RETURNING car_id`,
      [
        distId,
        userId,
        v.tipo,
        v.capacidad,
        v.patente,
        v.marca,
        v.modelo,
        v.anio,
        v.color,
        v.tara,
        v.cargaMaxima,
        v.km,
        diasAtras(entre(200, 800)),
      ],
    );
    // Los dos primeros vehículos llevan foto; el resto queda sin imagen.
    if (i < 2) {
      await adjuntarFoto(
        q,
        {
          tabla: 'car',
          columnaId: 'car_id',
          id: car.car_id,
          columnaKey: 'photo_key',
        },
        `cars/${distId}/${car.car_id}`,
        'camioneta',
        i + 1,
      );
    }

    // Vehículo en uso. El primer chofer tuvo antes otro (dado de baja), para
    // que el historial de asignaciones no quede vacío.
    const asignadoDesde = diasAtras(entre(70, 160));
    if (i === 0) {
      const [anterior] = await q(
        `INSERT INTO car
           (distributor_id, user_id, type_car, car_capacity, car_patent, car_brand, car_model, car_year,
            car_color, fleet_status, "createdAt", "deletedAt")
         VALUES ($1,$2,'Utilitario',600,'AA512FJ','Renault','Kangoo',2013,'Azul','grounded',$3,$4)
         RETURNING car_id`,
        [distId, userId, diasAtras(900), diasAtras(110)],
      );
      await q(
        `INSERT INTO vehicle_assignment
           (distributor_id, car_id, delivery_id, assigned_at, released_at, assigned_by_user_id, released_by_user_id, note)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`,
        [
          distId,
          anterior.car_id,
          deliveryId,
          diasAtras(600),
          asignadoDesde,
          adminUserId,
          'Se pasó a una camioneta más nueva',
        ],
      );
    }
    await q(
      `INSERT INTO vehicle_assignment
         (distributor_id, car_id, delivery_id, assigned_at, released_at, assigned_by_user_id, note)
       VALUES ($1,$2,$3,$4,NULL,$5,$6)`,
      [
        distId,
        car.car_id,
        deliveryId,
        asignadoDesde,
        adminUserId,
        'Asignación vigente',
      ],
    );

    choferes.push({
      deliveryId,
      userId,
      nombre: c.nombre,
      dni: c.dni,
      telefono: c.telefono,
      carId: car.car_id,
      patente: v.patente,
      marca: v.marca,
      modelo: v.modelo,
      km: v.km,
      ayudanteId: null,
    });
  }
  resumen.push(['delivery (choferes)', choferes.length]);
  resumen.push([
    'car (vehículos en uso + 1 dado de baja)',
    choferes.length + 1,
  ]);
  return choferes;
}

/** Pedidos forzados de hoy y de los últimos días: aseguran todos los estados. */
const PEDIDOS_DE_HOY: Array<{
  estado: 'accepted' | 'on_the_way' | 'pending' | 'reserved' | 'delivered';
  dia: number;
  chofer: boolean;
  medio?: 'cash' | 'transfer';
  /** Entregado y con el cobro todavía sin resolver. */
  cobro?: 'unpaid' | 'pending';
}> = [
  { estado: 'accepted', dia: 0, chofer: true },
  { estado: 'on_the_way', dia: 0, chofer: true },
  { estado: 'accepted', dia: 0, chofer: true },
  { estado: 'pending', dia: 0, chofer: false },
  { estado: 'pending', dia: 0, chofer: false },
  { estado: 'pending', dia: 1, chofer: false },
  { estado: 'reserved', dia: 0, chofer: false },
  { estado: 'reserved', dia: 1, chofer: false },
  { estado: 'reserved', dia: 3, chofer: false },
  { estado: 'delivered', dia: 1, chofer: true, medio: 'cash', cobro: 'unpaid' },
  {
    estado: 'delivered',
    dia: 1,
    chofer: true,
    medio: 'transfer',
    cobro: 'pending',
  },
];

const MEDIOS = ['cash', 'cash', 'cash', 'mercadopago', 'transfer'] as const;

async function sembrarPedidos(
  q: Q,
  distId: string,
  adminUserId: string,
  clientes: ClienteSembrado[],
  productos: Array<{ id: string; type: string; price: number; weight: number }>,
  franjas: string[],
  choferes: ChoferSembrado[],
): Promise<PedidoSembrado[]> {
  const pedidos: PedidoSembrado[] = [];
  let items = 0;
  let pagos = 0;
  let ofertas = 0;
  let historial = 0;

  // Cada día reparte un chofer (con otro de apoyo de vez en cuando): así hay
  // jornadas con varias entregas del mismo camión, que son las cargas.
  const choferDelDia = (dia: number): ChoferSembrado | null => {
    if (choferes.length === 0) return null;
    const principal = choferes[(dia * 3 + 1) % choferes.length];
    return quizas(0.85) ? principal : alguno(choferes);
  };
  const pesoDeProducto = (p: { weight: number }) =>
    p.weight === 10 ? 5 : p.weight === 5 ? 2 : p.weight === 15 ? 2 : 1;
  const elegirProducto = () => {
    const bolsa = productos.flatMap((p) => Array(pesoDeProducto(p)).fill(p));
    return alguno(bolsa) as (typeof productos)[number];
  };

  for (let n = 0; n < CANT_PEDIDOS; n++) {
    // Los primeros pedidos recorren a todos los clientes: ninguno queda sin compras
    // (un cliente sin pedidos sería un usuario huérfano para la próxima purga).
    const indice = n - PEDIDOS_DE_HOY.length;
    const cliente =
      indice >= 0 && indice < clientes.length
        ? clientes[indice]
        : alguno(clientes);
    if (cliente.direcciones.length === 0) continue;
    const dir = alguno(cliente.direcciones);

    const forzado = n < PEDIDOS_DE_HOY.length ? PEDIDOS_DE_HOY[n] : null;
    const dia = forzado ? forzado.dia : entre(1, DIAS_DE_HISTORIA - 1);
    let estado: string = forzado ? forzado.estado : 'delivered';
    if (!forzado && quizas(0.1)) estado = 'cancelled';

    const chofer: ChoferSembrado | null =
      estado === 'delivered' || (forzado && forzado.chofer)
        ? forzado && forzado.estado !== 'delivered'
          ? choferes[0]
          : choferDelDia(dia)
        : null;
    if (!chofer && (estado === 'accepted' || estado === 'on_the_way')) {
      estado = 'pending';
    }

    // Jornada: se crea entre las 7 y las 17; el pedido de hoy, hace unas horas.
    const creado =
      dia === 0
        ? new Date(Date.now() - entre(120, 300) * 60000)
        : diasAtras(dia, entre(7, 17));

    // Items: entre uno y tres productos distintos.
    const elegidos = new Map<string, (typeof productos)[number]>();
    const cuantos = entre(1, 3);
    while (elegidos.size < cuantos) {
      const p = elegirProducto();
      elegidos.set(p.id, p);
    }
    let subtotal = 0;
    const detalle = [...elegidos.values()].map((p) => {
      const cantidad = p.weight >= 25 ? entre(1, 2) : entre(1, 3);
      const linea = p.price * cantidad;
      subtotal += linea;
      return { producto: p, cantidad, unitario: p.price, subtotal: linea };
    });
    const metodo =
      forzado?.medio ??
      (estado === 'reserved' ? 'mercadopago' : alguno([...MEDIOS]));
    const tipoPago = metodo === 'cash' ? 'cash' : 'online';
    // Igual que el back: el pago online lleva +10 % sobre ítems + zona, guardado
    // aparte (`payment_surcharge_amount`), y el total es la suma exacta de las partes.
    const baseConZona = subtotal + dir.recargo;
    const recargoOnline =
      tipoPago === 'online' ? Math.round(baseConZona * 0.1 * 100) / 100 : 0;
    const total = Math.round((baseConZona + recargoOnline) * 100) / 100;
    const reciente = dia <= 2;

    // Estado de cobro según cómo terminó el pedido.
    let estadoPago: string;
    let confirmadoEl: Date | null = null;
    let confirmadoPor: string | null = null;
    let resueltoEl: Date | null = null;
    let resueltoPor: string | null = null;
    let notaDeResolucion: string | null = null;

    const aceptado =
      ['accepted', 'on_the_way', 'delivered'].includes(estado) && chofer
        ? masMinutos(creado, entre(2, 18))
        : null;
    const enCamino =
      ['on_the_way', 'delivered'].includes(estado) && aceptado
        ? masMinutos(aceptado, entre(5, 30))
        : null;
    const entregado =
      estado === 'delivered'
        ? masMinutos(enCamino ?? creado, entre(35, 120))
        : null;

    if (estado === 'delivered') {
      if (metodo === 'cash') {
        if (!reciente && quizas(0.045)) {
          // El chofer no llegó a cobrar: el administrador lo resuelve después.
          if (quizas(0.7)) {
            estadoPago = 'paid';
            confirmadoEl = masMinutos(entregado!, entre(1500, 4000));
            confirmadoPor = adminUserId;
            resueltoEl = confirmadoEl;
            resueltoPor = adminUserId;
            notaDeResolucion =
              'El cliente pasó a pagar por el local al día siguiente.';
          } else {
            estadoPago = 'written_off';
            resueltoEl = masMinutos(entregado!, entre(6000, 12000));
            resueltoPor = adminUserId;
            notaDeResolucion =
              'No se pudo ubicar al cliente: se da de baja el cobro.';
          }
        } else if (forzado?.cobro === 'unpaid' || (reciente && quizas(0.05))) {
          estadoPago = 'unpaid';
        } else {
          estadoPago = 'paid';
          confirmadoEl = masMinutos(entregado!, entre(2, 15));
          confirmadoPor = chofer?.userId ?? null;
        }
      } else if (metodo === 'transfer') {
        if (forzado?.cobro === 'pending' || (reciente && quizas(0.1))) {
          estadoPago = 'pending';
        } else {
          estadoPago = 'paid';
          confirmadoEl = masMinutos(creado, entre(40, 400));
          confirmadoPor = adminUserId;
        }
      } else {
        estadoPago = 'paid';
        confirmadoEl = masMinutos(creado, entre(1, 6));
      }
    } else if (estado === 'cancelled') {
      estadoPago =
        metodo === 'mercadopago' && quizas(0.4) ? 'failed' : 'pending';
    } else {
      estadoPago =
        metodo === 'cash'
          ? 'pending'
          : metodo === 'mercadopago' && quizas(0.7)
            ? 'paid'
            : 'pending';
      if (estadoPago === 'paid') confirmadoEl = masMinutos(creado, entre(1, 6));
    }

    const esReserva = estado === 'reserved';
    const sena = esReserva ? Math.round(total * 0.3) : 0;
    // Una reserva con la seña paga tiene el pago de la seña aprobado; si no, pendiente.
    const senaPaga = esReserva && quizas(0.7);
    if (esReserva) {
      estadoPago = 'pending';
      confirmadoEl = null;
    }
    const canceladoEl =
      estado === 'cancelled' ? masMinutos(creado, entre(10, 600)) : null;

    const [o] = await q(
      `INSERT INTO "order"
         (distributor_id, customer_id, delivery_id, time_slot_id, scheduled_date,
          deposit_amount, deposit_paid, address_id, status, "paymentMethod",
          "paymentType", "paymentStatus", "totalAmount", notes, "deliveryInstructions",
          "deliveryPoint", "acceptedAt", "onTheWayAt",
          "deliveredAt", "createdAt", "updatedAt", "cancellationReason", "deliveryCode",
          subtotal_items, coverage_zone_id, zone_name, zone_surcharge_type,
          zone_surcharge_value, zone_surcharge_amount, payment_surcharge_amount,
          vehicle_car_id, vehicle_patent, vehicle_brand, vehicle_model,
          payment_confirmed_at, payment_confirmed_by, payment_resolved_at, payment_resolved_by,
          payment_resolution_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               ST_SetSRID(ST_MakePoint($17::float8, $16::float8), 4326),
               $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,'fixed',$28,$28,
               $29,$30,$31,$32,$33,$34,$35,$36,$37,$38)
       RETURNING order_id`,
      [
        distId,
        cliente.userId,
        aceptado ? chofer!.deliveryId : null,
        quizas(0.85) ? alguno(franjas) : null,
        esReserva ? soloFecha(diasAtras(-entre(1, 12))) : null,
        sena,
        senaPaga,
        dir.id,
        estado,
        metodo,
        tipoPago,
        estadoPago,
        total,
        quizas(0.25)
          ? alguno([
              'Tocar bocina',
              'Dejar con el encargado',
              'Urgente, se quedaron sin gas',
            ])
          : null,
        quizas(0.3) ? alguno(INDICACIONES) : null,
        dir.lat.toFixed(6),
        dir.lng.toFixed(6),
        aceptado,
        enCamino,
        entregado,
        creado,
        canceladoEl ?? entregado ?? aceptado ?? creado,
        estado === 'cancelled' ? alguno(MOTIVOS_CANCELACION) : null,
        aceptado ? generateDeliveryCode() : null,
        subtotal,
        dir.zonaId,
        dir.zona,
        dir.recargo,
        recargoOnline,
        aceptado ? chofer!.carId : null,
        aceptado ? chofer!.patente : null,
        aceptado ? chofer!.marca : null,
        aceptado ? chofer!.modelo : null,
        confirmadoEl,
        confirmadoPor,
        resueltoEl,
        resueltoPor,
        notaDeResolucion,
      ],
    );

    for (const d of detalle) {
      await q(
        `INSERT INTO order_item (order_id, gas_cylinder_id, quantity, "unitPrice", subtotal)
         VALUES ($1,$2,$3,$4,$5)`,
        [o.order_id, d.producto.id, d.cantidad, d.unitario, d.subtotal],
      );
      items += 1;
    }

    // Historial de estados: el rastro de cada transición, con quién la hizo.
    const pasos: Array<
      [string | null, string, string | null, Date, string | null]
    > = [
      [null, esReserva ? 'reserved' : 'pending', cliente.userId, creado, null],
    ];
    if (aceptado)
      pasos.push(['pending', 'accepted', chofer!.userId, aceptado, null]);
    if (enCamino)
      pasos.push(['accepted', 'on_the_way', chofer!.userId, enCamino, null]);
    if (entregado)
      pasos.push(['on_the_way', 'delivered', chofer!.userId, entregado, null]);
    if (estado === 'cancelled') {
      pasos.push([
        'pending',
        'cancelled',
        quizas(0.5) ? cliente.userId : adminUserId,
        canceladoEl!,
        'Cancelado antes de despachar',
      ]);
    }
    for (const [desde, hacia, quien, cuando, motivo] of pasos) {
      await q(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_user_id, reason, changed_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [o.order_id, desde, hacia, quien, motivo, cuando],
      );
      historial += 1;
    }

    // Ledger de pagos: solo para lo que pasó por una pasarela.
    if (metodo === 'mercadopago') {
      const aprobado = esReserva ? senaPaga : estadoPago === 'paid';
      const idPasarela = aprobado ? `MP-${entre(100000000, 999999999)}` : null;
      await q(
        `INSERT INTO payment
           (order_id, distributor_id, gateway, integration, method, gateway_payment_id,
            external_reference, amount, currency, status, payment_url, is_deposit,
            metadata, "createdAt", "updatedAt")
         VALUES ($1,$2,'mercadopago','checkout_pro',$3,$4,$5,$6,'ARS',$7,$8,$9,$10::jsonb,$11,$12)`,
        [
          o.order_id,
          distId,
          alguno(['credit_card', 'debit_card', 'account_money']),
          idPasarela,
          o.order_id,
          esReserva ? sena : total,
          aprobado
            ? 'approved'
            : estadoPago === 'failed'
              ? 'rejected'
              : 'pending',
          `https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-${n}`,
          esReserva,
          JSON.stringify({ preferenceId: `pref-${n}` }),
          creado,
          confirmadoEl ??
            (esReserva && senaPaga
              ? masMinutos(creado, 3)
              : (entregado ?? creado)),
        ],
      );
      pagos += 1;
    }

    // Ofertas de despacho: el rastro de a quién se le ofreció el pedido.
    if (aceptado && chofer) {
      const ofrecidoEl = masMinutos(creado, 1);
      // A veces el primero rechaza y el pedido pasa al siguiente.
      if (choferes.length > 1 && quizas(0.3)) {
        const otro = choferes.find((c) => c.userId !== chofer.userId)!;
        await q(
          `INSERT INTO order_dispatch_offer
             (distributor_id, order_id, driver_id, status, "expiresAt", "offeredAt")
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            distId,
            o.order_id,
            otro.userId,
            alguno(['rejected', 'expired']),
            masMinutos(ofrecidoEl, 1),
            ofrecidoEl,
          ],
        );
        ofertas += 1;
      }
      await q(
        `INSERT INTO order_dispatch_offer
           (distributor_id, order_id, driver_id, status, "expiresAt", "offeredAt")
         VALUES ($1,$2,$3,'accepted',$4,$5)`,
        [
          distId,
          o.order_id,
          chofer.userId,
          masMinutos(ofrecidoEl, 2),
          ofrecidoEl,
        ],
      );
      ofertas += 1;
    }

    pedidos.push({
      id: o.order_id,
      clienteUserId: cliente.userId,
      choferUserId: aceptado ? chofer!.userId : null,
      deliveryId: aceptado ? chofer!.deliveryId : null,
      carId: aceptado ? chofer!.carId : null,
      estado,
      entregadoEl: entregado,
      creadoEl: creado,
      total,
      items: detalle.map((d) => ({
        gasCylinderId: d.producto.id,
        quantity: d.cantidad,
      })),
    });
  }

  resumen.push(['order (pedidos)', pedidos.length]);
  resumen.push(['order_item (renglones)', items]);
  resumen.push(['order_status_history (transiciones)', historial]);
  resumen.push(['payment (ledger de pasarela)', pagos]);
  resumen.push(['order_dispatch_offer (ofertas)', ofertas]);
  const porEstado = new Map<string, number>();
  for (const p of pedidos)
    porEstado.set(p.estado, (porEstado.get(p.estado) ?? 0) + 1);
  console.log(
    '  · pedidos por estado: ' +
      [...porEstado].map(([e, c]) => `${e} ${c}`).join(', '),
  );
  return pedidos;
}

/**
 * Un par de clientes bloqueados, pero nunca uno con un pedido abierto: el
 * bloqueo se hizo después de su última compra.
 */
async function bloquearAlgunosClientes(
  q: Q,
  clientes: ClienteSembrado[],
  pedidos: PedidoSembrado[],
) {
  const conPedidoAbierto = new Set(
    pedidos
      .filter((p) =>
        ['reserved', 'pending', 'accepted', 'on_the_way'].includes(p.estado),
      )
      .map((p) => p.clienteUserId),
  );
  // Los que no tienen nada abierto; se bloquean algunos, siempre los mismos.
  const elegibles = clientes
    .slice(1)
    .filter((c) => !conPedidoAbierto.has(c.userId));
  const aBloquear = elegibles.filter((_, i) => i % 9 === 4);
  for (const c of aBloquear) {
    await q(`UPDATE "user" SET blocked = true WHERE user_id = $1`, [c.userId]);
  }
  const n = aBloquear.length;
  resumen.push(['clientes bloqueados (sin pedidos abiertos)', n]);
}

async function sembrarReclamos(
  q: Q,
  distId: string,
  pedidos: PedidoSembrado[],
) {
  const candidatos = pedidos.filter((p) => p.estado === 'delivered');
  let n = 0;
  for (const p of candidatos) {
    if (!quizas(0.05)) continue;
    const estado = alguno([
      'pending',
      'in_process',
      'resolved',
      'resolved',
      'rejected',
    ] as const);
    const motivo = alguno(MOTIVOS_RECLAMO);
    // El azar se consume igual con o sin S3, para que los datos no cambien.
    const conFoto = quizas(0.4);
    const [reclamo] = await q(
      `INSERT INTO claims
         (distributor_id, order_id, customer_id, reason, description,
          status, "resolutionNote", "createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING claim_id`,
      [
        distId,
        p.id,
        p.clienteUserId,
        motivo,
        'El cliente informó el problema por la app apenas recibió el pedido. Se pidió foto del envase para verificar el estado.',
        estado,
        estado === 'resolved'
          ? 'Se repuso el envase sin cargo y se acreditó el descuento en el próximo pedido.'
          : estado === 'rejected'
            ? 'Revisado con el chofer y las fotos: el envase salió del depósito en condiciones.'
            : null,
        masMinutos(p.entregadoEl ?? p.creadoEl, entre(30, 2880)),
      ],
    );
    if (conFoto) {
      await adjuntarFoto(
        q,
        {
          tabla: 'claims',
          columnaId: 'claim_id',
          id: reclamo.claim_id,
          columnaKey: 'photo_key',
        },
        `claims/${distId}/${reclamo.claim_id}`,
        'garrafa',
        n,
      );
    }
    n += 1;
  }
  resumen.push(['claims (reclamos)', n]);
}

async function sembrarIncidencias(
  q: Q,
  distId: string,
  adminUserId: string,
  pedidos: PedidoSembrado[],
  choferes: Array<{ userId: string }>,
) {
  // Normalmente la reporta el chofer. Sin flota, la carga el administrador,
  // que es quien queda registrando lo que pasó en la calle.
  const reportante = () =>
    choferes.length ? alguno(choferes).userId : adminUserId;
  if (!reportante()) {
    resumen.push(['incident (incidencias)', 0]);
    return;
  }

  const candidatos = pedidos.filter((p) =>
    ['delivered', 'cancelled'].includes(p.estado),
  );
  const DESCRIPCIONES: Record<string, string> = {
    damaged:
      'El envase llegó con la válvula golpeada. Se retiró y se dejó otro en el momento.',
    out_of_stock:
      'No había stock del producto pedido en el camión. Se ofreció el de 10 kg como reemplazo.',
    no_show:
      'Se llamó tres veces al cliente y nadie atendió. El pedido volvió al depósito.',
    other:
      'Calle cortada por obra, hubo que reprogramar la entrega para la franja siguiente.',
  };

  let n = 0;
  for (const p of candidatos) {
    if (!quizas(0.05)) continue;
    const tipo = alguno([
      'damaged',
      'out_of_stock',
      'no_show',
      'other',
    ] as const);
    const cerrada = quizas(0.6);
    const creada = masMinutos(p.entregadoEl ?? p.creadoEl, entre(5, 200));
    const conFoto = quizas(0.3);
    const [incidencia] = await q(
      `INSERT INTO incident
         (order_id, distributor_id, reported_by, type, description,
          status, resolution_note, "createdAt", "resolvedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING incident_id`,
      [
        p.id,
        distId,
        reportante(),
        tipo,
        DESCRIPCIONES[tipo],
        cerrada ? 'resolved' : 'open',
        cerrada
          ? 'Resuelto con el cliente. Se dejó asentado para el informe del mes.'
          : null,
        creada,
        cerrada ? masMinutos(creada, entre(60, 4000)) : null,
      ],
    );
    if (conFoto) {
      await adjuntarFoto(
        q,
        {
          tabla: 'incident',
          columnaId: 'incident_id',
          id: incidencia.incident_id,
          columnaKey: 'photo_key',
        },
        `incidents/${distId}/${incidencia.incident_id}`,
        'aviso',
        n,
      );
    }
    n += 1;
  }
  resumen.push(['incident (incidencias)', n]);
}

/**
 * Calificaciones cruzadas de los pedidos entregados. Solo tienen sentido con
 * flota: sin chofer no hay a quién calificar ni quién califique al cliente.
 */
async function sembrarCalificaciones(
  q: Q,
  distId: string,
  pedidos: PedidoSembrado[],
) {
  const COMENTARIOS_CLIENTE = [
    'Llegó antes de lo previsto, muy amable.',
    'Todo bien, pero tardó casi una hora más que la franja.',
    'Excelente, me ayudó a colocar la garrafa.',
    'El envase estaba sucio pero funcionaba bien.',
    null,
  ];
  const COMENTARIOS_CHOFER = [
    'Cliente puntual, tenía el efectivo justo.',
    'Difícil de encontrar la dirección, no había número en la casa.',
    'Todo en orden.',
    null,
  ];

  let n = 0;
  for (const p of pedidos) {
    if (p.estado !== 'delivered' || !p.choferUserId) continue;
    if (quizas(0.4)) continue;

    const estrellas = quizas(0.75) ? entre(4, 5) : entre(2, 3);
    await q(
      `INSERT INTO rating
         (order_id, distributor_id, from_user_id, to_user_id, from_role, stars, comment, "createdAt")
       VALUES ($1,$2,$3,$4,'customer',$5,$6,$7)`,
      [
        p.id,
        distId,
        p.clienteUserId,
        p.choferUserId,
        estrellas,
        alguno(COMENTARIOS_CLIENTE),
        masMinutos(p.entregadoEl!, entre(10, 600)),
      ],
    );
    n += 1;

    if (quizas(0.5)) {
      await q(
        `INSERT INTO rating
           (order_id, distributor_id, from_user_id, to_user_id, from_role, stars, comment, "createdAt")
         VALUES ($1,$2,$3,$4,'delivery',$5,$6,$7)`,
        [
          p.id,
          distId,
          p.choferUserId,
          p.clienteUserId,
          entre(4, 5),
          alguno(COMENTARIOS_CHOFER),
          masMinutos(p.entregadoEl!, entre(10, 300)),
        ],
      );
      n += 1;
    }
  }
  resumen.push(['rating (calificaciones)', n]);
}

/**
 * Envases físicos con número de serie y su historia de movimientos. Es lo que
 * alimenta la trazabilidad: cada garrafa real, dónde está y cómo llegó ahí.
 */
async function sembrarEnvases(
  q: Q,
  distId: string,
  productos: Array<{ id: string; type: string; weight: number }>,
  clientes: ClienteSembrado[],
  pedidos: PedidoSembrado[],
) {
  const entregados = pedidos.filter((p) => p.estado === 'delivered');
  const DEPOSITO: Record<number, number> = {
    5: 12000,
    10: 18000,
    15: 26000,
    25: 40000,
    45: 70000,
  };

  let envases = 0;
  let movimientos = 0;
  let serie = 1;

  for (const p of productos) {
    // Cuántos envases físicos hay de cada medida.
    const cuantos =
      p.weight === 10 ? 90 : p.weight === 5 ? 45 : p.weight === 15 ? 35 : 20;

    for (let i = 0; i < cuantos; i++) {
      const dado = azar();
      let estado: string;
      if (dado < 0.4) estado = 'in_depot';
      else if (dado < 0.62) estado = 'filled';
      else if (dado < 0.68) estado = 'dispatched';
      else if (dado < 0.9) estado = 'with_customer';
      else estado = 'empty_returned';
      // «Con cliente» exige un cliente (`CHK_cylinder_cliente_segun_estado`): sin
      // pedidos entregados a quién atarlo, el envase queda en el depósito.
      if (estado === 'with_customer' && !entregados.length) estado = 'in_depot';

      // El envase que está en la calle se ata a un pedido entregado real, para
      // que la ficha del envase cuente una historia que se pueda seguir.
      const pedido =
        estado === 'with_customer' && entregados.length
          ? alguno(entregados)
          : null;
      const cliente = pedido ? pedido.clienteUserId : null;

      const serial = `SPLG-${String(serie).padStart(5, '0')}`;
      serie += 1;

      // La cadena de movimientos hasta el estado actual, en orden.
      const cadena: string[] = ['in_depot'];
      if (
        ['filled', 'dispatched', 'with_customer', 'empty_returned'].includes(
          estado,
        )
      )
        cadena.push('filled');
      if (['dispatched', 'with_customer', 'empty_returned'].includes(estado))
        cadena.push('dispatched');
      if (['with_customer', 'empty_returned'].includes(estado))
        cadena.push('with_customer');
      if (estado === 'empty_returned') cadena.push('empty_returned');

      // Fechas: un envase con pedido nunca se mueve antes de que exista el pedido.
      const alta = pedido
        ? masMinutos(pedido.creadoEl, -entre(200, 700) * 1440)
        : diasAtras(entre(200, 700));
      const momentos = new Map<string, Date>();
      if (pedido && pedido.entregadoEl) {
        momentos.set('in_depot', alta);
        momentos.set(
          'filled',
          masMinutos(pedido.creadoEl, -entre(1, 3) * 1440),
        );
        momentos.set('dispatched', masMinutos(pedido.creadoEl, entre(10, 30)));
        momentos.set('with_customer', pedido.entregadoEl);
      } else {
        let t = alta;
        for (const paso of cadena) {
          momentos.set(paso, t);
          t = masMinutos(t, entre(120, 2880));
        }
      }
      const ultimo = momentos.get(cadena[cadena.length - 1])!;

      const [c] = await q(
        `INSERT INTO cylinder
           (distributor_id, serial, gas_cylinder_id, state, current_customer_id,
            current_order_id, deposit, "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING cylinder_id`,
        [
          distId,
          serial,
          p.id,
          estado,
          cliente,
          pedido?.id ?? null,
          DEPOSITO[p.weight] ?? 0,
          alta,
          ultimo,
        ],
      );
      envases += 1;

      let anterior: string | null = null;
      for (const paso of cadena) {
        await q(
          `INSERT INTO cylinder_movement
             (cylinder_id, distributor_id, from_state, to_state, order_id, actor_user_id, note, "createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            c.cylinder_id,
            distId,
            anterior,
            paso,
            ['dispatched', 'with_customer'].includes(paso)
              ? (pedido?.id ?? null)
              : null,
            null,
            paso === 'filled'
              ? 'Cargado en planta'
              : paso === 'dispatched'
                ? 'Subido al camión de reparto'
                : paso === 'with_customer'
                  ? 'Entregado al cliente'
                  : paso === 'empty_returned'
                    ? 'Vacío recibido en depósito'
                    : 'Alta del envase en el parque',
            momentos.get(paso),
          ],
        );
        movimientos += 1;
        anterior = paso;
      }
    }
  }

  // Un cliente sin pedidos no debería figurar con un envase en su poder.
  void clientes;

  resumen.push(['cylinder (envases físicos)', envases]);
  resumen.push(['cylinder_movement (trazabilidad)', movimientos]);
}

/**
 * Deja el stock coherente con lo que hay comprometido hoy. Descuenta solo los
 * pedidos abiertos —lo que todavía no salió del depósito pero ya está vendido—
 * y no los noventa días de entregas, que se fueron reponiendo sobre la marcha.
 */
async function ajustarStock(q: Q, distId: string) {
  await q(
    `UPDATE gas_cylinder g
        SET stock = GREATEST(6, g.stock - COALESCE(v.comprometidas, 0))
       FROM (
         SELECT i.gas_cylinder_id, SUM(i.quantity)::int AS comprometidas
           FROM order_item i
           JOIN "order" o ON o.order_id = i.order_id
          WHERE o.distributor_id = $1
            AND o.status IN ('pending','accepted','on_the_way','reserved')
          GROUP BY i.gas_cylinder_id
       ) v
      WHERE v.gas_cylinder_id = g.gas_cylinder_id AND g.distributor_id = $1`,
    [distId],
  );
}

function imprimirResumen() {
  resumen.push([
    almacen
      ? 'fotos de ejemplo subidas a S3'
      : 'fotos de ejemplo (sin SEED_S3=1 o sin AWS_S3_BUCKET/AWS_REGION: se omitieron)',
    fotosSubidas,
  ]);
  console.log('\n──────────── DATOS SEMBRADOS ────────────');
  for (const [tabla, cantidad] of resumen) {
    console.log(`  ${tabla.padEnd(34)} ${String(cantidad).padStart(5)}`);
  }
  console.log('─────────────────────────────────────────');
  if (CANT_CHOFERES === 0) {
    console.log(
      '\nLa flota quedó vacía a pedido. Sin choferes no hay vehículos,\n' +
        'calificaciones ni ofertas de despacho, y el informe de ventas por\n' +
        'chofer sale en blanco. Para llenarlos:  SEED_DRIVERS=4 npm run seed:demo\n',
    );
  }
}

main()
  .then(async () => {
    await ds.destroy();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nEl seed de demostración falló:', err.message ?? err);
    if (ds.isInitialized) await ds.destroy();
    process.exit(1);
  });
