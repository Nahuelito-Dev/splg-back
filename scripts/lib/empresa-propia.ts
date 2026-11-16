/**
 * La distribuidora de prueba propia de la plataforma («empresa propia sin
 * aprobación», decisión del 14/11): el administrador general la opera directo,
 * con lectura y escritura, sin sesión de soporte. Se arma copiando lo de la
 * demo (catálogo, franjas, zonas de Posadas y vehículos) y suma su galpón en
 * Posadas, dos choferes y cinco clientes con cuenta en Firebase
 * (`@splg-test.com`).
 *
 * Idempotente: lo que ya existe se saltea (por slug, tipo, nombre, patente o
 * correo); nunca borra ni pisa nada. Herramienta de desarrollo: la usa
 * `scripts/seed-empresa-propia.ts` y el e2e `empresa-propia-seed.e2e-spec.ts`.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { CustomersService } from '../../src/customer/customer.service';
import {
  DistribuidoraCreadaEvent,
  EVENTO_DISTRIBUIDORA_CREADA,
} from '../../src/distributor/events/distribuidora-creada.event';
import { RoleType } from '../../src/common/constants/role-type.enum';
import { RegistroService } from '../../src/registro/registro.service';
import { sembrarFisico } from './stock-demo';

export const EMPRESA_PROPIA = {
  name: 'Distribuidora de prueba OrixTech',
  slug: 'prueba-orixtech',
  legalName: 'OrixTech (distribuidora de prueba)',
  email: 'prueba@splg-test.com',
  phone: '+543764990100',
} as const;

/** El galpón de la empresa propia, en Posadas. */
export const GALPON_POSADAS = { lat: -27.3671, lng: -55.8961 } as const;

/** Contraseña de las cuentas de prueba (Firebase exige 6 caracteres o más). */
export const CLAVE_DE_PRUEBA = 'Test1234';

export interface PersonaDePrueba {
  email: string;
  fullName: string;
  phone: string;
}

export const CHOFERES_DE_PRUEBA: readonly PersonaDePrueba[] = [
  {
    email: 'chofer1.orixtech@splg-test.com',
    fullName: 'Chofer Uno OrixTech',
    phone: '+5493764990101',
  },
  {
    email: 'chofer2.orixtech@splg-test.com',
    fullName: 'Chofer Dos OrixTech',
    phone: '+5493764990102',
  },
];

export const CLIENTES_DE_PRUEBA: readonly PersonaDePrueba[] = [
  1, 2, 3, 4, 5,
].map((n) => ({
  email: `cliente${n}.orixtech@splg-test.com`,
  fullName: `Cliente ${['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco'][n - 1]} OrixTech`,
  phone: `+54937649902${String(n).padStart(2, '0')}`,
}));

export interface DependenciasDeLaSiembra {
  ds: DataSource;
  eventos: EventEmitter2;
  registro: RegistroService;
  clientes: CustomersService;
  /** El slug de la distribuidora de la que se copia (por defecto `demo`). */
  origen?: string;
  log?: (linea: string) => void;
}

export interface ResumenDeLaSiembra {
  distributorId: string;
  creada: boolean;
  /** Existe con el slug pero plataforma no la marcó: no se toca. */
  omitidaPorNoSerPropia?: boolean;
  productos: number;
  franjas: number;
  zonas: number;
  vehiculos: number;
  asignaciones: number;
  choferes: Array<{ email: string; estado: string }>;
  clientes: Array<{ email: string; estado: string }>;
  direcciones: number;
}

type Filas = Array<Record<string, unknown>>;

export async function sembrarEmpresaPropia(
  deps: DependenciasDeLaSiembra,
): Promise<ResumenDeLaSiembra> {
  const { ds } = deps;
  const log = deps.log ?? (() => undefined);
  const q = <T = Filas>(sql: string, params: unknown[] = []): Promise<T> =>
    ds.query(sql, params);
  const origenSlug = deps.origen ?? 'demo';

  // ── 1. La distribuidora de origen ──────────────────────────────────────────
  const [origen] = await q<Array<{ distributor_id: string }>>(
    `SELECT distributor_id FROM distributor WHERE slug = $1 AND "deletedAt" IS NULL`,
    [origenSlug],
  );
  if (!origen) {
    throw new Error(
      `No existe la distribuidora '${origenSlug}' de la que se copia. Corré primero: npm run seed && npm run seed:demo`,
    );
  }
  const origenId = origen.distributor_id;

  // ── 2. La empresa propia ───────────────────────────────────────────────────
  const [existente] = await q<
    Array<{ distributor_id: string; deletedAt: Date | null; owned: boolean }>
  >(
    `SELECT distributor_id, "deletedAt", owned_by_platform AS owned
       FROM distributor WHERE slug = $1`,
    [EMPRESA_PROPIA.slug],
  );
  if (existente?.deletedAt) {
    throw new Error(
      `La distribuidora '${EMPRESA_PROPIA.slug}' está dada de baja: reactivala a mano, la siembra no la toca`,
    );
  }
  let distId: string;
  const creada = !existente;
  if (existente) {
    distId = existente.distributor_id;
    if (!existente.owned) {
      log(
        `No se toca '${EMPRESA_PROPIA.slug}': ya existe y no está marcada como propia. Marcala por el endpoint de plataforma auditado.`,
      );
      return resumenVacio(distId, false, true);
    }
  } else {
    // La creación y su marca ocurren juntas: el trigger de auditoría la deja
    // asentada con actor de sistema (el script no suplanta a un usuario).
    const nueva = await ds.transaction(async (manager) => {
      const filas = await manager.query<Array<{ distributor_id: string }>>(
        `INSERT INTO distributor (name, slug, legal_name, email, phone, owned_by_platform, created_by_platform)
         VALUES ($1, $2, $3, $4, $5, true, true) RETURNING distributor_id`,
        [
          EMPRESA_PROPIA.name,
          EMPRESA_PROPIA.slug,
          EMPRESA_PROPIA.legalName,
          EMPRESA_PROPIA.email,
          EMPRESA_PROPIA.phone,
        ],
      );
      return filas[0];
    });
    distId = nueva.distributor_id;
  }
  // Los datos base de toda distribuidora (caja central, puestos, planes de
  // flota, depósito predeterminado): los listeners son idempotentes, y
  // `emitAsync` espera a que terminen.
  await deps.eventos.emitAsync(
    EVENTO_DISTRIBUIDORA_CREADA,
    new DistribuidoraCreadaEvent(distId),
  );
  log(
    `${creada ? 'Creada' : 'Ya existía'}: ${EMPRESA_PROPIA.name} (${EMPRESA_PROPIA.slug}), propia de la plataforma`,
  );

  // ── 3. Catálogo (sin fotos: los objetos de S3 son de la demo) ──────────────
  const productos = await q<Array<{ gas_cylinder_id: string; type: string }>>(
    `INSERT INTO gas_cylinder
       (distributor_id, type, weight, price, container_price, stock, description, "isActive")
     SELECT $1, o.type, o.weight, o.price, o.container_price, o.stock, o.description, o."isActive"
       FROM gas_cylinder o
      WHERE o.distributor_id = $2
        AND NOT EXISTS (SELECT 1 FROM gas_cylinder p
                         WHERE p.distributor_id = $1
                           AND lower(btrim(p.type)) = lower(btrim(o.type)))
     RETURNING gas_cylinder_id, type`,
    [distId, origenId],
  );
  for (const p of productos) {
    await q(
      `INSERT INTO gas_cylinder_promotion (gas_cylinder_id, quantity, discount_percentage)
       SELECT $1, pr.quantity, pr.discount_percentage
         FROM gas_cylinder_promotion pr
         JOIN gas_cylinder o ON o.gas_cylinder_id = pr.gas_cylinder_id
        WHERE o.distributor_id = $2 AND o.type = $3`,
      [p.gas_cylinder_id, origenId, p.type],
    );
  }

  // ── 4. Franjas horarias ────────────────────────────────────────────────────
  const franjas = await q<Filas>(
    `INSERT INTO time_slot (distributor_id, name, "startTime", "endTime", capacity, "isActive")
     SELECT $1, o.name, o."startTime", o."endTime", o.capacity, o."isActive"
       FROM time_slot o
      WHERE o.distributor_id = $2
        AND NOT EXISTS (SELECT 1 FROM time_slot p
                         WHERE p.distributor_id = $1 AND p.name = o.name)
     RETURNING time_slot_id`,
    [distId, origenId],
  );

  // ── 5. Zonas de cobertura de Posadas ───────────────────────────────────────
  const zonas = await q<Filas>(
    `INSERT INTO coverage_zone
       (distributor_id, name, area, surcharge_type, surcharge_value, "isActive",
        priority, label, color, valid_from, valid_until)
     SELECT $1, o.name, o.area, o.surcharge_type, o.surcharge_value, o."isActive",
            o.priority, o.label, o.color, o.valid_from, o.valid_until
       FROM coverage_zone o
      WHERE o.distributor_id = $2 AND o."deletedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM coverage_zone p
                         WHERE p.distributor_id = $1 AND p.name = o.name
                           AND p."deletedAt" IS NULL)
     RETURNING coverage_zone_id`,
    [distId, origenId],
  );

  // ── 6. Galpón en Posadas ───────────────────────────────────────────────────
  await q(
    `UPDATE warehouse
        SET name = 'Galpón Posadas',
            address = 'Posadas, Misiones',
            location = ST_SetSRID(ST_MakePoint($2, $3), 4326)
      WHERE distributor_id = $1 AND is_default AND "deletedAt" IS NULL
        AND location IS NULL`,
    [distId, GALPON_POSADAS.lng, GALPON_POSADAS.lat],
  );
  // Stock físico del catálogo, por el libro (conteo inicial).
  await sembrarFisico(ds, distId);

  // ── 7. Choferes con cuenta ─────────────────────────────────────────────────
  const choferes: ResumenDeLaSiembra['choferes'] = [];
  for (const c of CHOFERES_DE_PRUEBA) {
    choferes.push({
      email: c.email,
      estado: await asegurarCuenta(deps, c, RoleType.DELIVERY, distId),
    });
  }

  // ── 8. Vehículos (copiados de la demo, uno por chofer) ─────────────────────
  const delChofer = await q<Array<{ user_id: string; delivery_id: string }>>(
    `SELECT u.user_id, d.delivery_id
       FROM "user" u JOIN delivery d ON d.user_id = u.user_id
      WHERE d.distributor_id = $1 AND lower(u.email) = ANY($2::text[])
        AND u."deletedAt" IS NULL
      ORDER BY u.email`,
    [distId, CHOFERES_DE_PRUEBA.map((c) => c.email)],
  );
  const modelos = await q<Filas>(
    `SELECT type_car, car_capacity, car_patent, car_brand, car_model, car_year,
            car_color, tare_weight_kg, max_load_kg, odometer_km
       FROM car
      WHERE distributor_id = $1 AND "deletedAt" IS NULL AND fleet_status = 'active'
        AND car_patent IS NOT NULL
      ORDER BY car_patent
      LIMIT $2`,
    [origenId, CHOFERES_DE_PRUEBA.length],
  );
  let vehiculos = 0;
  let asignaciones = 0;
  const [superAdmin] = await q<Array<{ user_id: string }>>(
    `SELECT u.user_id FROM "user" u JOIN role r ON r.role_id = u.role_id
      WHERE r.type = 'super_admin' AND u."deletedAt" IS NULL
      ORDER BY u."createdAt" LIMIT 1`,
  );
  for (const [i, m] of modelos.entries()) {
    const chofer = delChofer[i];
    if (!chofer) break;
    const [auto] = await q<Array<{ car_id: string }>>(
      `INSERT INTO car
         (distributor_id, user_id, type_car, car_capacity, car_patent, car_brand, car_model,
          car_year, car_color, tare_weight_kg, max_load_kg, odometer_km, fleet_status, in_service_since)
       SELECT $1::uuid, $2::uuid, $3::varchar, $4::int, $5::varchar, $6::varchar, $7::varchar,
              $8::int, $9::varchar, $10::numeric, $11::numeric, $12::int, 'active', now()
        WHERE NOT EXISTS (SELECT 1 FROM car WHERE distributor_id = $1
                            AND car_patent = $5::varchar AND "deletedAt" IS NULL)
       RETURNING car_id`,
      [
        distId,
        chofer.user_id,
        m.type_car,
        m.car_capacity,
        m.car_patent,
        m.car_brand,
        m.car_model,
        m.car_year,
        m.car_color,
        m.tare_weight_kg,
        m.max_load_kg,
        m.odometer_km,
      ],
    );
    if (!auto) continue;
    vehiculos += 1;
    // El vehículo en uso lo asigna alguien: el administrador general (la
    // empresa propia no tiene admin). Sin super admin, queda para el panel.
    if (superAdmin) {
      await q(
        `INSERT INTO vehicle_assignment
           (distributor_id, car_id, delivery_id, assigned_at, assigned_by_user_id, note)
         SELECT $1, $2, $3, now(), $4, 'Asignación de la siembra de la empresa propia'
          WHERE NOT EXISTS (SELECT 1 FROM vehicle_assignment
                             WHERE delivery_id = $3 AND released_at IS NULL)`,
        [distId, auto.car_id, chofer.delivery_id, superAdmin.user_id],
      );
      asignaciones += 1;
    }
  }

  // ── 9. Clientes con cuenta, vinculados y con domicilio en Posadas ─────────
  const clientes: ResumenDeLaSiembra['clientes'] = [];
  const emailsDeClientesVinculables: string[] = [];
  for (const c of CLIENTES_DE_PRUEBA) {
    const estado = await asegurarCuenta(deps, c, RoleType.CUSTOMER, distId);
    if (await clienteExisteEnOtraEmpresa(ds, c.email, distId)) {
      clientes.push({
        email: c.email,
        estado: 'omitida: ya es cliente de otra empresa',
      });
      log(`Cliente ${c.email}: se saltea; ya pertenece a otra empresa.`);
      continue;
    }
    clientes.push({
      email: c.email,
      estado,
    });
    emailsDeClientesVinculables.push(c.email);
  }
  const deLosClientes = await q<Array<{ user_id: string; email: string }>>(
    `SELECT u.user_id, lower(u.email) AS email
       FROM "user" u JOIN customer c ON c.user_id = u.user_id
      WHERE lower(u.email) = ANY($1::text[]) AND u."deletedAt" IS NULL
      ORDER BY u.email`,
    [emailsDeClientesVinculables],
  );
  // Un punto adentro de cada zona copiada, para que los pedidos coticen.
  const puntos = await q<Array<{ lat: number; lng: number; name: string }>>(
    `SELECT ST_Y(ST_PointOnSurface(area)) AS lat, ST_X(ST_PointOnSurface(area)) AS lng, name
       FROM coverage_zone
      WHERE distributor_id = $1 AND "deletedAt" IS NULL AND "isActive"
      ORDER BY priority, name`,
    [distId],
  );
  let direcciones = 0;
  for (const [i, c] of deLosClientes.entries()) {
    await ds.transaction((m) =>
      deps.clientes.vincularConDistribuidora(m, c.user_id, distId, null),
    );
    const punto = puntos.length
      ? puntos[i % puntos.length]
      : { ...GALPON_POSADAS, name: 'Centro' };
    const calle = `Calle de prueba ${100 + i * 10}`;
    const nuevas = await q<Filas>(
      `INSERT INTO user_address
         (user_id, street, city, "postalCode", location, "formattedAddress", "isDefault")
       SELECT $1, $2, 'Posadas', '3300', ST_SetSRID(ST_MakePoint($4, $3), 4326), $5, true
        WHERE NOT EXISTS (SELECT 1 FROM user_address
                           WHERE user_id = $1 AND "deletedAt" IS NULL)
       RETURNING address_id`,
      [
        c.user_id,
        calle,
        Number(Number(punto.lat).toFixed(6)),
        Number(Number(punto.lng).toFixed(6)),
        `${calle}, ${punto.name}, Posadas, Misiones`,
      ],
    );
    direcciones += nuevas.length;
  }

  return {
    distributorId: distId,
    creada,
    productos: productos.length,
    franjas: franjas.length,
    zonas: zonas.length,
    vehiculos,
    asignaciones,
    choferes,
    clientes,
    direcciones,
  };
}

function resumenVacio(
  distributorId: string,
  creada: boolean,
  omitidaPorNoSerPropia = false,
): ResumenDeLaSiembra {
  return {
    distributorId,
    creada,
    ...(omitidaPorNoSerPropia && { omitidaPorNoSerPropia: true }),
    productos: 0,
    franjas: 0,
    zonas: 0,
    vehiculos: 0,
    asignaciones: 0,
    choferes: [],
    clientes: [],
    direcciones: 0,
  };
}

/** No vincula un correo fijo de prueba que ya es cliente de otra empresa. */
async function clienteExisteEnOtraEmpresa(
  ds: DataSource,
  email: string,
  distributorId: string,
): Promise<boolean> {
  const filas = await ds.query<Array<{ existe: boolean }>>(
    `SELECT EXISTS (
       SELECT 1
         FROM "user" u
         JOIN customer c ON c.user_id = u.user_id
        WHERE lower(u.email) = lower($1)
          AND (
            EXISTS (SELECT 1 FROM customer_distributor cd
                     WHERE cd.user_id = u.user_id AND cd.distributor_id <> $2
                       AND cd.removed_at IS NULL)
            OR EXISTS (SELECT 1 FROM "order" o
                       WHERE o.customer_id = u.user_id AND o.distributor_id <> $2)
          )
     ) AS existe`,
    [email, distributorId],
  );
  return Boolean(filas[0]?.existe);
}

/**
 * La cuenta (Firebase + base + perfil) si no existe; por el alta de siempre
 * (`RegistroService`, solicitante `sistema`). Devuelve qué pasó.
 */
async function asegurarCuenta(
  deps: DependenciasDeLaSiembra,
  p: PersonaDePrueba,
  rol: RoleType.DELIVERY | RoleType.CUSTOMER,
  distributorId: string,
): Promise<string> {
  const [ya] = await deps.ds.query<Array<{ user_id: string }>>(
    `SELECT user_id FROM "user" WHERE lower(email) = lower($1)`,
    [p.email],
  );
  if (ya) return 'ya existía';
  await deps.registro.registrar(
    {
      email: p.email,
      password: CLAVE_DE_PRUEBA,
      full_name: p.fullName,
      phone_number: p.phone,
      rol,
      // La política la ignora para clientes.
      distributorId,
      validated: true,
      isActive: true,
    },
    { tipo: 'sistema' },
  );
  await deps.ds.query(
    `UPDATE "user" SET created_by_platform = true WHERE lower(email) = lower($1)`,
    [p.email],
  );
  return 'creada';
}
