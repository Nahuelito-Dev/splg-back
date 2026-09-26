/**
 * Seed de datos de demostración.
 *
 *   npm run seed:demo
 *
 * Deja la base local con un volumen de datos realista para recorrer el panel:
 * catálogo, clientes con direcciones, franjas horarias, zonas de cobertura,
 * envases físicos con su trazabilidad, y noventa días de pedidos con sus
 * items, pagos, reclamos e incidencias.
 *
 * Presupone que `npm run seed` ya corrió: de ahí salen los roles, la
 * distribuidora y los usuarios que tienen login real contra Firebase. Este
 * script no toca Firebase: los clientes que crea existen solo en la base, que
 * es lo que el panel necesita para mostrarlos.
 *
 * Es reproducible y reentrante. Borra los datos de demostración anteriores y
 * los vuelve a generar iguales, porque el azar sale de una semilla fija. Los
 * usuarios con login sobreviven al borrado.
 *
 * Se configura por variables de entorno:
 *
 *   SEED_CUSTOMERS=25   clientes en total, contando el que tiene login
 *   SEED_DRIVERS=0      choferes; en 0 quedan vacías las tablas que cuelgan
 *                       de un chofer (delivery, car, rating, ofertas)
 *   SEED_ORDERS=180     pedidos repartidos en los últimos 90 días
 *   SEED_DISTRIBUTOR=jeny-gas   slug de la distribuidora que recibe todo
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';

const CANT_CLIENTES = Number(process.env.SEED_CUSTOMERS ?? 25);
const CANT_CHOFERES = Number(process.env.SEED_DRIVERS ?? 0);
const CANT_PEDIDOS = Number(process.env.SEED_ORDERS ?? 180);
const SLUG = process.env.SEED_DISTRIBUTOR ?? 'jeny-gas';
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

/** El catálogo que pidió el negocio: 5, 10, 15 y 25 kg. */
const CATALOGO = [
  {
    type: 'Garrafa 5kg',
    weight: 5,
    price: 8500,
    stock: 140,
    description:
      'Envase de 5 kg. El más chico, para consumo puntual, camping o un anafe.',
    promotions: [{ quantity: 4, discountPercentage: 8 }],
  },
  {
    type: 'Garrafa 10kg',
    weight: 10,
    price: 14900,
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
    price: 21500,
    stock: 95,
    description:
      'Envase de 15 kg. Familias grandes y comercios con consumo sostenido.',
    promotions: [{ quantity: 2, discountPercentage: 7 }],
  },
  {
    type: 'Garrafa 25kg',
    weight: 25,
    price: 34000,
    stock: 40,
    description:
      'Envase de 25 kg. Uso comercial: parrillas, panaderías y hotelería.',
    promotions: [{ quantity: 3, discountPercentage: 10 }],
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
});

const resumen: Array<[string, number]> = [];

async function main() {
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

  // ── 2. Borrar lo sembrado antes ────────────────────────────────────────────
  // El orden respeta las claves foráneas: primero lo que depende, después lo
  // que sostiene. Los usuarios con login (los que tienen firebase_uid) no se
  // tocan, porque volver a crearlos exigiría entrar a Firebase.
  // Primero las otras distribuidoras: sus pedidos apuntan a clientes y
  // direcciones que la limpieza quiere borrar, y con las claves foráneas
  // declaradas el borrado fallaba.
  if (SOLO_UNA) await borrarOtrasDistribuidoras(q, distId);
  await limpiar(q, distId);

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
         (distributor_id, type, weight, price, stock, description, "isActive")
       VALUES ($1,$2,$3,$4,$5,$6,true)
       RETURNING gas_cylinder_id`,
      [distId, p.type, p.weight, p.price, p.stock, p.description],
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
  }
  resumen.push(['gas_cylinder (catálogo)', productos.length]);

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
  for (const b of BARRIOS) {
    const anillo = [
      [b.lngMin, b.latMin],
      [b.lngMax, b.latMin],
      [b.lngMax, b.latMax],
      [b.lngMin, b.latMax],
      [b.lngMin, b.latMin],
    ];
    await q(
      `INSERT INTO coverage_zone (distributor_id, name, area, surcharge, "isActive")
       VALUES ($1,$2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), $4, true)`,
      [
        distId,
        b.nombre,
        JSON.stringify({ type: 'Polygon', coordinates: [anillo] }),
        b.recargo,
      ],
    );
  }
  resumen.push(['coverage_zone (zonas)', BARRIOS.length]);

  // ── 6. Clientes ────────────────────────────────────────────────────────────
  const [rolCliente] = await q(
    `SELECT role_id FROM role WHERE type = 'customer'`,
  );
  const clientes = await sembrarClientes(q, rolCliente?.role_id ?? null);
  resumen.push(['customer (clientes)', clientes.length]);
  resumen.push([
    'user_address (direcciones)',
    clientes.reduce((n, c) => n + c.direcciones.length, 0),
  ]);

  // ── 7. Choferes ────────────────────────────────────────────────────────────
  const choferes = await sembrarChoferes(q, distId);
  resumen.push(['delivery (choferes)', choferes.length]);

  // ── 8. Pedidos y todo lo que cuelga de ellos ───────────────────────────────
  const pedidos = await sembrarPedidos(
    q,
    distId,
    clientes,
    productos,
    franjas,
    choferes,
  );
  await sembrarReclamos(q, distId, pedidos);
  await sembrarIncidencias(q, distId, pedidos, choferes);
  await sembrarCalificaciones(q, distId, pedidos);

  // ── 9. Envases físicos ─────────────────────────────────────────────────────
  await sembrarEnvases(q, distId, productos, clientes, pedidos);

  await ajustarStock(q, distId);
  await archivarUsuariosHuerfanos(q);

  imprimirResumen();
}

// ─────────────────────────────────────────────────────────────────────────────

type Q = (sql: string, params?: any[]) => Promise<any>;

interface ClienteSembrado {
  userId: string;
  nombre: string;
  direcciones: Array<{ id: string; lat: number; lng: number; recargo: number }>;
}

interface PedidoSembrado {
  id: string;
  clienteUserId: string;
  choferUserId: string | null;
  estado: string;
  entregadoEl: Date | null;
  creadoEl: Date;
  total: number;
}

/**
 * Vacía lo que este mismo script sembró antes, de la hoja hacia la raíz. Deja
 * en pie los usuarios con `firebase_uid`, que son los que permiten entrar al
 * panel y a las apps.
 */
async function limpiar(q: Q, distId: string) {
  await q(`DELETE FROM cylinder_movement WHERE distributor_id = $1`, [distId]);
  await q(`DELETE FROM cylinder WHERE distributor_id = $1`, [distId]);
  await q(`DELETE FROM order_dispatch_offer WHERE distributor_id = $1`, [
    distId,
  ]);
  await q(`DELETE FROM rating WHERE distributor_id = $1`, [distId]);
  await q(`DELETE FROM incident WHERE distributor_id = $1`, [distId]);
  await q(`DELETE FROM claims WHERE distributor_id = $1`, [distId]);
  await q(`DELETE FROM payment WHERE distributor_id = $1`, [distId]);
  await q(
    `DELETE FROM order_item WHERE order_id IN (SELECT order_id FROM "order" WHERE distributor_id = $1)`,
    [distId],
  );
  await q(`DELETE FROM "order" WHERE distributor_id = $1`, [distId]);
  await q(`DELETE FROM time_slot WHERE distributor_id = $1`, [distId]);
  await q(`DELETE FROM coverage_zone WHERE distributor_id = $1`, [distId]);
  await q(`DELETE FROM gas_cylinder WHERE distributor_id = $1`, [distId]);
  await q(`DELETE FROM car WHERE distributor_id = $1`, [distId]);

  // Perfiles y usuarios de demostración: los que no tienen cuenta en Firebase.
  await q(
    `DELETE FROM delivery
      WHERE user_id IN (SELECT user_id FROM "user" WHERE firebase_uid IS NULL)`,
  );
  // Las direcciones se borran todas, incluidas las del cliente con login: son
  // datos de demostración y si no, se acumulan una tanda nueva por corrida.
  // Quedan las que usa un pedido de otra distribuidora (con
  // SEED_SINGLE_TENANT=false): la clave foránea no deja borrarlas.
  await q(
    `DELETE FROM user_address a
      WHERE a.user_id IN (SELECT user_id FROM customer)
        AND NOT EXISTS (SELECT 1 FROM "order" o WHERE o.address_id = a.address_id)`,
  );
  const sinPedidos = `NOT EXISTS (SELECT 1 FROM "order" o WHERE o.customer_id = u.user_id)`;
  await q(
    `DELETE FROM customer c
      USING "user" u
      WHERE c.user_id = u.user_id AND u.firebase_uid IS NULL AND ${sinPedidos}`,
  );
  await q(
    `DELETE FROM "user" u
      WHERE u.firebase_uid IS NULL AND ${sinPedidos}
        AND NOT EXISTS (SELECT 1 FROM customer c WHERE c.user_id = u.user_id)
        AND NOT EXISTS (SELECT 1 FROM delivery d WHERE d.user_id = u.user_id)
        AND NOT EXISTS (SELECT 1 FROM user_address a WHERE a.user_id = u.user_id)`,
  );

  // Con 0 choferes pedidos, los perfiles que quedaron de corridas anteriores
  // también se van; el usuario sobrevive en Firebase y puede volver a darse de
  // alta desde el panel, que es justamente el flujo a mostrar.
  if (CANT_CHOFERES === 0) {
    await q(`DELETE FROM delivery WHERE distributor_id = $1`, [distId]);
  }
}

/**
 * Deja una sola distribuidora en pie. La segunda existía para probar el
 * aislamiento entre inquilinos; para mostrar el panel estorba, porque duplica
 * catálogo y staff. Los usuarios siguen en Firebase: si hace falta volver a
 * tener dos, `npm run seed` las recrea.
 */
async function borrarOtrasDistribuidoras(q: Q, distId: string) {
  const otras = await q(
    `SELECT distributor_id, name FROM distributor WHERE distributor_id <> $1`,
    [distId],
  );
  if (otras.length === 0) return;

  for (const d of otras) {
    const id = d.distributor_id;
    await q(`DELETE FROM cylinder_movement WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM cylinder WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM order_dispatch_offer WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM rating WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM incident WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM claims WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM payment WHERE distributor_id = $1`, [id]);
    await q(
      `DELETE FROM order_item WHERE order_id IN (SELECT order_id FROM "order" WHERE distributor_id = $1)`,
      [id],
    );
    await q(`DELETE FROM "order" WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM time_slot WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM coverage_zone WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM gas_cylinder WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM car WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM delivery WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM admin WHERE distributor_id = $1`, [id]);
    await q(`DELETE FROM distributor WHERE distributor_id = $1`, [id]);
    console.log(`  · se quitó la distribuidora ${d.name}`);
  }
}

async function sembrarClientes(
  q: Q,
  roleId: string | null,
): Promise<ClienteSembrado[]> {
  const clientes: ClienteSembrado[] = [];

  // El cliente con login real ya existe; entra como uno más de los 25 para que
  // tenga direcciones y pedidos como el resto.
  const conLogin = await q(
    `SELECT u.user_id, u.full_name
       FROM "user" u
       JOIN customer c ON c.user_id = u.user_id
      WHERE u.firebase_uid IS NOT NULL AND u."deletedAt" IS NULL`,
  );
  for (const u of conLogin) {
    clientes.push({ userId: u.user_id, nombre: u.full_name, direcciones: [] });
  }

  const usados = new Set<string>();
  let i = 0;
  while (clientes.length < CANT_CLIENTES) {
    const nombre = `${alguno(NOMBRES)} ${alguno(APELLIDOS)}`;
    const clave = nombre.toLowerCase().replace(/[^a-z]/g, '');
    if (usados.has(clave)) continue;
    usados.add(clave);
    i += 1;

    const email = `${clave}${i}@demo.splg.com`;
    const telefono = `+54376${String(4500000 + i).slice(0, 7)}`;
    const alta = diasAtras(entre(95, 400));

    const [u] = await q(
      `INSERT INTO "user"
         (role_id, full_name, email, phone_number, phone_verified, email_verified, blocked, "createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING user_id`,
      [
        roleId,
        nombre,
        email,
        telefono,
        quizas(0.7),
        quizas(0.85),
        quizas(0.06),
        alta,
      ],
    );
    await q(
      `INSERT INTO customer (user_id, validated, "createdAt")
       VALUES ($1,true,$2)`,
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
      c.direcciones.push({ id: a.address_id, lat, lng, recargo: b.recargo });
    }
  }
  return clientes;
}

/**
 * Choferes. Por defecto no crea ninguno: el negocio pidió arrancar con la
 * flota vacía para dar de alta al primero desde el panel. Con SEED_DRIVERS>0
 * los crea, con vehículo, y habilita las tablas que dependen de ellos.
 */
async function sembrarChoferes(q: Q, distId: string) {
  const choferes: Array<{
    deliveryId: string;
    userId: string;
    nombre: string;
  }> = [];
  if (CANT_CHOFERES <= 0) return choferes;

  const [rolChofer] = await q(
    `SELECT role_id FROM role WHERE type = 'delivery'`,
  );
  const VEHICULOS = [
    {
      type_car: 'Camioneta',
      car_brand: 'Toyota',
      car_model: 'Hilux',
      car_capacity: 900,
    },
    {
      type_car: 'Camioneta',
      car_brand: 'Ford',
      car_model: 'Ranger',
      car_capacity: 850,
    },
    {
      type_car: 'Utilitario',
      car_brand: 'Renault',
      car_model: 'Kangoo',
      car_capacity: 600,
    },
    {
      type_car: 'Camión',
      car_brand: 'Iveco',
      car_model: 'Daily',
      car_capacity: 2500,
    },
    {
      type_car: 'Utilitario',
      car_brand: 'Fiat',
      car_model: 'Fiorino',
      car_capacity: 500,
    },
  ];

  for (let i = 1; i <= CANT_CHOFERES; i++) {
    const nombre = `${alguno(NOMBRES)} ${alguno(APELLIDOS)}`;
    const [u] = await q(
      `INSERT INTO "user"
         (role_id, full_name, email, phone_number, phone_verified, email_verified, "createdAt")
       VALUES ($1,$2,$3,$4,true,true,$5) RETURNING user_id`,
      [
        rolChofer?.role_id ?? null,
        nombre,
        `chofer${i}@demo.splg.com`,
        `+54376${String(4700000 + i).slice(0, 7)}`,
        diasAtras(entre(120, 300)),
      ],
    );
    const b = BARRIOS[0];
    const [d] = await q(
      `INSERT INTO delivery
         (distributor_id, user_id, validated, "isActive", calification, balance, location, "createdAt")
       VALUES ($1,$2,true,true,$3,$4,ST_SetSRID(ST_MakePoint($6,$5),4326),$7) RETURNING delivery_id`,
      [
        distId,
        u.user_id,
        Number((3.6 + azar() * 1.4).toFixed(2)),
        entre(0, 45000),
        Number((b.latMin + azar() * 0.02).toFixed(6)),
        Number((b.lngMin + azar() * 0.02).toFixed(6)),
        diasAtras(entre(120, 300)),
      ],
    );
    const v = VEHICULOS[(i - 1) % VEHICULOS.length];
    await q(
      `INSERT INTO car
         (distributor_id, user_id, type_car, car_capacity, car_patent, car_brand,
          car_model, car_year, car_color)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        distId,
        u.user_id,
        v.type_car,
        v.car_capacity,
        `AB${String(100 + i)}${String.fromCharCode(65 + i)}${String.fromCharCode(70 + i)}`,
        v.car_brand,
        v.car_model,
        entre(2014, 2024),
        alguno(['Blanco', 'Gris', 'Negro', 'Rojo']),
      ],
    );
    choferes.push({ deliveryId: d.delivery_id, userId: u.user_id, nombre });
  }
  resumen.push(['car (vehículos)', choferes.length]);
  return choferes;
}

async function sembrarPedidos(
  q: Q,
  distId: string,
  clientes: ClienteSembrado[],
  productos: Array<{ id: string; type: string; price: number; weight: number }>,
  franjas: string[],
  choferes: Array<{ deliveryId: string; userId: string }>,
): Promise<PedidoSembrado[]> {
  const pedidos: PedidoSembrado[] = [];
  let items = 0;
  let pagos = 0;
  let ofertas = 0;

  for (let n = 0; n < CANT_PEDIDOS; n++) {
    const cliente = alguno(clientes);
    if (cliente.direcciones.length === 0) continue;
    const dir = alguno(cliente.direcciones);

    // La mayoría son entregas cerradas: es lo que da volumen a los informes.
    // El resto se reparte entre lo que está en curso y lo que se cayó.
    const dado = azar();
    let estado: string;
    if (dado < 0.72) estado = 'delivered';
    else if (dado < 0.82) estado = 'pending';
    else if (dado < 0.9) estado = 'cancelled';
    else if (dado < 0.96) estado = 'reserved';
    else
      estado = choferes.length ? alguno(['accepted', 'on_the_way']) : 'pending';

    const creado =
      estado === 'reserved' ? diasAtras(entre(0, 4)) : diasAtras(entre(0, 89));

    // Items: entre uno y tres productos distintos.
    const elegidos = [...productos]
      .sort(() => azar() - 0.5)
      .slice(0, entre(1, 3));
    let subtotal = 0;
    const detalle = elegidos.map((p) => {
      const cantidad = p.weight >= 25 ? entre(1, 2) : entre(1, 4);
      const linea = p.price * cantidad;
      subtotal += linea;
      return { producto: p, cantidad, unitario: p.price, subtotal: linea };
    });
    const total = subtotal + dir.recargo;

    const metodo = alguno(['cash', 'mercadopago', 'transfer'] as const);
    const tipoPago = metodo === 'cash' ? 'cash' : 'online';
    let estadoPago: string;
    if (estado === 'delivered')
      estadoPago =
        metodo === 'cash' ? 'paid' : quizas(0.94) ? 'paid' : 'failed';
    else if (estado === 'cancelled')
      estadoPago = quizas(0.25) ? 'failed' : 'pending';
    else
      estadoPago =
        metodo === 'cash' ? 'pending' : quizas(0.5) ? 'paid' : 'pending';

    const esReserva = estado === 'reserved';
    const sena = esReserva ? Math.round(total * 0.3) : 0;

    const chofer =
      ['accepted', 'on_the_way', 'delivered'].includes(estado) &&
      choferes.length
        ? alguno(choferes)
        : null;

    const aceptado = ['accepted', 'on_the_way', 'delivered'].includes(estado)
      ? masMinutos(creado, entre(2, 18))
      : null;
    const enCamino =
      ['on_the_way', 'delivered'].includes(estado) && aceptado
        ? masMinutos(aceptado, entre(5, 30))
        : null;
    const entregado =
      estado === 'delivered' && enCamino
        ? masMinutos(enCamino, entre(10, 55))
        : estado === 'delivered'
          ? masMinutos(creado, entre(35, 120))
          : null;

    const [o] = await q(
      `INSERT INTO "order"
         (distributor_id, customer_id, delivery_id, time_slot_id, scheduled_date,
          deposit_amount, deposit_paid, address_id, status, "paymentMethod",
          "paymentType", "paymentStatus", "totalAmount", notes, "deliveryInstructions",
          "deliveryPoint", "acceptedAt", "onTheWayAt",
          "deliveredAt", "createdAt", "updatedAt", "cancellationReason", "deliveryCode")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               ST_SetSRID(ST_MakePoint($17::float8, $16::float8), 4326),
               $18,$19,$20,$21,$22,$23,$24)
       RETURNING order_id`,
      [
        distId,
        cliente.userId,
        chofer?.deliveryId ?? null,
        quizas(0.85) ? alguno(franjas) : null,
        esReserva ? soloFecha(diasAtras(-entre(1, 12))) : null,
        sena,
        esReserva ? quizas(0.7) : false,
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
        entregado ?? aceptado ?? creado,
        estado === 'cancelled' ? alguno(MOTIVOS_CANCELACION) : null,
        aceptado ? String(entre(100000, 999999)) : null,
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

    // Ledger de pagos: solo para lo que pasó por una pasarela.
    if (metodo === 'mercadopago') {
      const aprobado = estadoPago === 'paid';
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
          `https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=demo-${n}`,
          esReserva,
          JSON.stringify({ preferenceId: `demo-pref-${n}`, seed: true }),
          creado,
          entregado ?? creado,
        ],
      );
      pagos += 1;
    }

    // Ofertas de despacho: el rastro de a quién se le ofreció el pedido.
    if (chofer) {
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
      choferUserId: chofer?.userId ?? null,
      estado,
      entregadoEl: entregado,
      creadoEl: creado,
      total,
    });
  }

  resumen.push(['order (pedidos)', pedidos.length]);
  resumen.push(['order_item (renglones)', items]);
  resumen.push(['payment (ledger)', pagos]);
  resumen.push(['order_dispatch_offer (ofertas)', ofertas]);
  return pedidos;
}

async function sembrarReclamos(
  q: Q,
  distId: string,
  pedidos: PedidoSembrado[],
) {
  const candidatos = pedidos.filter((p) => p.estado === 'delivered');
  let n = 0;
  for (const p of candidatos) {
    if (!quizas(0.13)) continue;
    const estado = alguno([
      'pending',
      'in_process',
      'resolved',
      'resolved',
      'rejected',
    ] as const);
    await q(
      `INSERT INTO claims
         (distributor_id, order_id, customer_id, reason, description, "photoUrl",
          status, "resolutionNote", "createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        distId,
        p.id,
        p.clienteUserId,
        alguno(MOTIVOS_RECLAMO),
        'El cliente informó el problema por la app apenas recibió el pedido. Se pidió foto del envase para verificar el estado.',
        quizas(0.4) ? `https://storage.splg.app/reclamos/demo-${n}.jpg` : null,
        estado,
        estado === 'resolved'
          ? 'Se repuso el envase sin cargo y se acreditó el descuento en el próximo pedido.'
          : estado === 'rejected'
            ? 'Revisado con el chofer y las fotos: el envase salió del depósito en condiciones.'
            : null,
        masMinutos(p.entregadoEl ?? p.creadoEl, entre(30, 2880)),
      ],
    );
    n += 1;
  }
  resumen.push(['claims (reclamos)', n]);
}

async function sembrarIncidencias(
  q: Q,
  distId: string,
  pedidos: PedidoSembrado[],
  choferes: Array<{ userId: string }>,
) {
  // Normalmente la reporta el chofer. Sin flota, la carga el administrador,
  // que es quien queda registrando lo que pasó en la calle.
  const [admin] = await q(
    `SELECT u.user_id FROM "user" u
       JOIN admin a ON a.user_id = u.user_id
      WHERE u.firebase_uid IS NOT NULL LIMIT 1`,
  );
  const reportante = () =>
    choferes.length ? alguno(choferes).userId : admin?.user_id;
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
    if (!quizas(0.16)) continue;
    const tipo = alguno([
      'damaged',
      'out_of_stock',
      'no_show',
      'other',
    ] as const);
    const cerrada = quizas(0.6);
    const creada = masMinutos(p.entregadoEl ?? p.creadoEl, entre(5, 200));
    await q(
      `INSERT INTO incident
         (order_id, distributor_id, reported_by, type, description, photo_url,
          status, resolution_note, "createdAt", "resolvedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        p.id,
        distId,
        reportante(),
        tipo,
        DESCRIPCIONES[tipo],
        quizas(0.3)
          ? `https://storage.splg.app/incidencias/demo-${n}.jpg`
          : null,
        cerrada ? 'resolved' : 'open',
        cerrada
          ? 'Resuelto con el cliente. Se dejó asentado para el informe del mes.'
          : null,
        creada,
        cerrada ? masMinutos(creada, entre(60, 4000)) : null,
      ],
    );
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

      // El envase que está en la calle se ata a un pedido entregado real, para
      // que la ficha del envase cuente una historia que se pueda seguir.
      const pedido =
        estado === 'with_customer' && entregados.length
          ? alguno(entregados)
          : null;
      const cliente = pedido ? pedido.clienteUserId : null;

      const serial = `SPLG-${String(serie).padStart(5, '0')}`;
      serie += 1;

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
          diasAtras(entre(200, 700)),
          pedido?.entregadoEl ?? diasAtras(entre(1, 60)),
        ],
      );
      envases += 1;

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

      let cuando = diasAtras(entre(30, 90));
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
            cuando,
          ],
        );
        movimientos += 1;
        anterior = paso;
        cuando = masMinutos(cuando, entre(120, 2880));
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

/**
 * Deja fuera de las listas a los usuarios que quedaron sin perfil: el staff de
 * la distribuidora que se quitó y los choferes cuya alta se dio de baja. Es
 * baja lógica, no física: la cuenta sigue en Firebase y `npm run seed` la
 * vuelve a tomar si algún día hacen falta de nuevo.
 */
async function archivarUsuariosHuerfanos(q: Q) {
  const r = await q(
    `UPDATE "user" u
        SET "deletedAt" = now()
      WHERE u."deletedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM customer c WHERE c.user_id = u.user_id)
        AND NOT EXISTS (SELECT 1 FROM delivery d WHERE d.user_id = u.user_id)
        AND NOT EXISTS (SELECT 1 FROM admin   a WHERE a.user_id = u.user_id)
      RETURNING u.email`,
  );
  // Un UPDATE ... RETURNING devuelve [filas, cantidad], no las filas sueltas.
  const filas = Array.isArray(r?.[0]) ? r[0] : r;
  if (filas.length) {
    console.log(`  · quedaron archivados ${filas.length} usuarios sin perfil`);
  }
}

function imprimirResumen() {
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
