/**
 * Personal (legajos), flota y mantenimiento de la demo (herramienta de
 * desarrollo; el guardia `resguardoDeProduccion` la frena antes de llegar acá).
 */
import { EntityManager } from 'typeorm';
import { cuilValido } from './rng-demo';

const DIA_MS = 24 * 60 * 60 * 1000;
const hace = (dias: number): Date => new Date(Date.now() - dias * DIA_MS);
const fecha = (d: Date): string => d.toISOString().slice(0, 10);

export interface ChoferDeLaDemo {
  nombre: string;
  /** Si es la cuenta con login, el correo con el que entra. */
  emailLogin: string | null;
  dni: string;
  telefono: string;
  vehiculo: {
    tipo: string;
    marca: string;
    modelo: string;
    anio: number;
    patente: string;
    color: string;
    capacidad: number;
    tara: number;
    cargaMaxima: number;
    km: number;
  };
}

/** Choferes y vehículos de la demo. Patentes con formato Mercosur (AA 000 AA). */
export const CHOFERES_DE_LA_DEMO: readonly ChoferDeLaDemo[] = [
  {
    nombre: 'Ramón Villalba',
    emailLogin: 'chofer@splg.com',
    dni: '24118364',
    telefono: '+543764501101',
    vehiculo: {
      tipo: 'Camioneta',
      marca: 'Toyota',
      modelo: 'Hilux',
      anio: 2021,
      patente: 'AF218KT',
      color: 'Blanco',
      capacidad: 900,
      tara: 1950,
      cargaMaxima: 1000,
      km: 84200,
    },
  },
  {
    nombre: 'Cristian Maidana',
    emailLogin: null,
    dni: '30552871',
    telefono: '+543764501102',
    vehiculo: {
      tipo: 'Camioneta',
      marca: 'Ford',
      modelo: 'Ranger',
      anio: 2020,
      patente: 'AE774PM',
      color: 'Gris',
      capacidad: 850,
      tara: 2080,
      cargaMaxima: 950,
      km: 102350,
    },
  },
  {
    nombre: 'Sergio Insaurralde',
    emailLogin: null,
    dni: '28774215',
    telefono: '+543764501103',
    vehiculo: {
      tipo: 'Utilitario',
      marca: 'Renault',
      modelo: 'Kangoo',
      anio: 2019,
      patente: 'AD391RS',
      color: 'Blanco',
      capacidad: 600,
      tara: 1250,
      cargaMaxima: 650,
      km: 96780,
    },
  },
  {
    nombre: 'Diego Ferreyra',
    emailLogin: null,
    dni: '33210946',
    telefono: '+543764501104',
    vehiculo: {
      tipo: 'Camión',
      marca: 'Iveco',
      modelo: 'Daily 70C16',
      anio: 2018,
      patente: 'AB650LN',
      color: 'Rojo',
      capacidad: 2500,
      tara: 3400,
      cargaMaxima: 3100,
      km: 151900,
    },
  },
  {
    nombre: 'Walter Zaracho',
    emailLogin: null,
    dni: '35640128',
    telefono: '+543764501105',
    vehiculo: {
      tipo: 'Utilitario',
      marca: 'Fiat',
      modelo: 'Fiorino',
      anio: 2022,
      patente: 'AG102VC',
      color: 'Blanco',
      capacidad: 500,
      tara: 1130,
      cargaMaxima: 600,
      km: 41200,
    },
  },
];

interface PersonaDelLegajo {
  nombre: string;
  apellido: string;
  dni: string;
  puesto: string;
  tipo: 'permanent' | 'fixed_term' | 'part_time' | 'contractor';
  ingresoHaceDias: number;
  nacimiento: string;
  calle: string;
  telefono: string;
  contacto: [nombre: string, telefono: string, vinculo: string];
  userId?: string | null;
  baja?: { haceDias: number; motivo: 'resignation' | 'dismissal' };
  mujer?: boolean;
}

const PUESTOS: Array<[nombre: string, categoria: string]> = [
  ['Chofer repartidor', 'driver'],
  ['Ayudante de reparto', 'helper'],
  ['Operario de depósito', 'warehouse'],
  ['Administrativa', 'administration'],
  ['Vendedora de mostrador', 'sales'],
  ['Gerente', 'management'],
];

export interface ResultadoDePersonal {
  empleadosPorUsuario: Map<string, string>;
  ayudantes: string[];
  total: number;
  empleados: Array<{ id: string; nombre: string; ingreso: Date }>;
}

/**
 * Puestos y legajos: los choferes (con su usuario), ayudantes, depósito,
 * administración, ventas, gerencia y una baja por renuncia.
 */
export async function sembrarPersonal(
  m: EntityManager,
  distributorId: string,
  choferes: ReadonlyArray<{
    userId: string;
    nombre: string;
    dni: string;
    telefono: string;
  }>,
  adminUserId: string | null,
  adminNombre: string,
): Promise<ResultadoDePersonal> {
  const puestos = new Map<string, string>();
  for (const [nombre, categoria] of PUESTOS) {
    const [p]: Array<{ position_id: string }> = await m.query(
      `INSERT INTO "job_position" ("distributor_id", "name", "category") VALUES ($1, $2, $3) RETURNING "position_id"`,
      [distributorId, nombre, categoria],
    );
    puestos.set(nombre, p.position_id);
  }

  const personas: PersonaDelLegajo[] = [
    ...choferes.map((c, i) => {
      const [nombre, ...apellido] = c.nombre.split(' ');
      return {
        nombre,
        apellido: apellido.join(' '),
        dni: c.dni,
        puesto: 'Chofer repartidor',
        tipo: 'permanent' as const,
        ingresoHaceDias: 1500 - i * 230,
        nacimiento: `${1978 + i * 2}-0${(i % 9) + 1}-1${i}`,
        calle: `Calle ${100 + i * 37} N° ${300 + i * 111}`,
        telefono: c.telefono,
        contacto: [
          'Contacto de emergencia',
          `+54376455${1000 + i}`,
          'Pareja',
        ] as [string, string, string],
        userId: c.userId,
      };
    }),
    {
      nombre: 'Federico',
      apellido: 'Rojas',
      dni: '38220417',
      puesto: 'Ayudante de reparto',
      tipo: 'permanent',
      ingresoHaceDias: 640,
      nacimiento: '1995-04-12',
      calle: 'Av. Lavalle 2210',
      telefono: '+543764502201',
      contacto: ['Norma Rojas', '+543764455201', 'Madre'],
    },
    {
      nombre: 'Nicolás',
      apellido: 'Coronel',
      dni: '40118733',
      puesto: 'Ayudante de reparto',
      tipo: 'fixed_term',
      ingresoHaceDias: 210,
      nacimiento: '1998-09-30',
      calle: 'Calle Sarmiento 1450',
      telefono: '+543764502202',
      contacto: ['Ana Coronel', '+543764455202', 'Hermana'],
    },
    {
      nombre: 'Matías',
      apellido: 'Britos',
      dni: '41325590',
      puesto: 'Ayudante de reparto',
      tipo: 'part_time',
      ingresoHaceDias: 120,
      nacimiento: '2000-01-22',
      calle: 'Calle Tucumán 3380',
      telefono: '+543764502203',
      contacto: ['Raúl Britos', '+543764455203', 'Padre'],
    },
    {
      nombre: 'Oscar',
      apellido: 'Almirón',
      dni: '26480159',
      puesto: 'Operario de depósito',
      tipo: 'permanent',
      ingresoHaceDias: 2100,
      nacimiento: '1975-11-05',
      calle: 'Calle Junín 880',
      telefono: '+543764503301',
      contacto: ['Elsa Almirón', '+543764455301', 'Esposa'],
    },
    {
      nombre: 'Ángel',
      apellido: 'Núñez',
      dni: '31774026',
      puesto: 'Operario de depósito',
      tipo: 'permanent',
      ingresoHaceDias: 980,
      nacimiento: '1984-06-18',
      calle: 'Calle Ayacucho 2950',
      telefono: '+543764503302',
      contacto: ['Rosa Núñez', '+543764455302', 'Madre'],
    },
    {
      nombre: 'Marcela',
      apellido: 'Duarte',
      dni: '27655381',
      puesto: 'Administrativa',
      tipo: 'permanent',
      ingresoHaceDias: 1900,
      nacimiento: '1979-02-27',
      calle: 'Calle Bolívar 1722',
      telefono: '+543764504401',
      contacto: ['Luis Duarte', '+543764455401', 'Esposo'],
      userId: adminUserId,
      mujer: true,
    },
    {
      nombre: 'Patricia',
      apellido: 'Segovia',
      dni: '34908812',
      puesto: 'Administrativa',
      tipo: 'permanent',
      ingresoHaceDias: 760,
      nacimiento: '1988-12-09',
      calle: 'Calle Córdoba 2045',
      telefono: '+543764504402',
      contacto: ['Mirta Segovia', '+543764455402', 'Madre'],
      mujer: true,
    },
    {
      nombre: 'Daniela',
      apellido: 'Aguirre',
      dni: '39441270',
      puesto: 'Vendedora de mostrador',
      tipo: 'permanent',
      ingresoHaceDias: 430,
      nacimiento: '1996-07-14',
      calle: 'Calle Entre Ríos 1190',
      telefono: '+543764505501',
      contacto: ['Jorge Aguirre', '+543764455501', 'Padre'],
      mujer: true,
    },
    {
      nombre: 'Eduardo',
      apellido: 'Silva',
      dni: '22190467',
      puesto: 'Gerente',
      tipo: 'permanent',
      ingresoHaceDias: 3100,
      nacimiento: '1972-03-03',
      calle: 'Av. Mitre 2670',
      telefono: '+543764506601',
      contacto: ['Beatriz Silva', '+543764455601', 'Esposa'],
    },
    {
      nombre: 'Mario',
      apellido: 'Cabrera',
      dni: '29335714',
      puesto: 'Chofer repartidor',
      tipo: 'permanent',
      ingresoHaceDias: 1800,
      nacimiento: '1981-08-21',
      calle: 'Calle Mitre 515',
      telefono: '+543764507701',
      contacto: ['Susana Cabrera', '+543764455701', 'Esposa'],
      baja: { haceDias: 130, motivo: 'resignation' },
    },
  ];

  const resultado: ResultadoDePersonal = {
    empleadosPorUsuario: new Map(),
    ayudantes: [],
    total: 0,
    empleados: [],
  };
  let legajo = 0;
  for (const p of personas) {
    legajo += 1;
    const ingreso = hace(p.ingresoHaceDias);
    const baja = p.baja ? hace(p.baja.haceDias) : null;
    const [e]: Array<{ employee_id: string }> = await m.query(
      `INSERT INTO "employee"
         ("distributor_id", "user_id", "position_id", "file_number", "first_name", "last_name", "document_type",
          "document_number", "cuil", "birth_date", "address_line", "city", "province", "postal_code", "phone",
          "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship", "hire_date",
          "termination_date", "termination_reason", "employment_type", "status", "bank_cbu", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'dni', $7, $8, $9, $10, 'Posadas', 'Misiones', '3300', $11,
               $12, $13, $14, $15::date, $16, $17, $18, $19, $20, $15::date)
       RETURNING "employee_id"`,
      [
        distributorId,
        p.userId ?? null,
        puestos.get(p.puesto),
        `L-${String(legajo).padStart(4, '0')}`,
        p.nombre,
        p.apellido,
        p.dni,
        cuilValido(p.dni, p.mujer ? ['27', '23', '24'] : ['20', '23', '24']),
        p.nacimiento,
        p.calle,
        p.telefono,
        p.contacto[0],
        p.contacto[1],
        p.contacto[2],
        fecha(ingreso),
        baja ? fecha(baja) : null,
        p.baja?.motivo ?? null,
        p.tipo,
        baja ? 'terminated' : 'active',
        `0110${p.dni}${String(legajo).padStart(10, '0')}`.slice(0, 22),
      ],
    );
    resultado.total += 1;
    resultado.empleados.push({
      id: e.employee_id,
      nombre: `${p.nombre} ${p.apellido}`,
      ingreso,
    });
    if (p.userId) resultado.empleadosPorUsuario.set(p.userId, e.employee_id);
    if (p.puesto === 'Ayudante de reparto')
      resultado.ayudantes.push(e.employee_id);
  }
  void adminNombre;
  await m.query(
    `INSERT INTO "document_sequence" ("distributor_id", "doc_type", "last_number") VALUES ($1, 'employee_file', $2)
     ON CONFLICT ("distributor_id", "doc_type") DO UPDATE SET "last_number" = EXCLUDED."last_number"`,
    [distributorId, legajo],
  );
  return resultado;
}

export interface FlotaParaMantenimiento {
  carId: string;
  deliveryId: string;
  km: number;
}

/**
 * Planes de mantenimiento y sus tareas (hechas, programadas, vencida y a
 * pronosticar), más el uso diario de cada vehículo a partir de las entregas.
 */
export async function sembrarMantenimiento(
  m: EntityManager,
  distributorId: string,
  flota: readonly FlotaParaMantenimiento[],
): Promise<{ planes: number; tareas: number }> {
  const plan = async (p: {
    nombre: string;
    sujeto: 'vehicle' | 'driver';
    disparador: 'by_km' | 'by_time' | 'by_fixed_date';
    km?: number;
    meses?: number;
    anticipo: number;
    criticidad: 'blocking' | 'non_blocking';
  }): Promise<string> => {
    const [r]: Array<{ plan_id: string }> = await m.query(
      `INSERT INTO "maintenance_plan"
         ("distributor_id", "name", "subject", "trigger", "interval_km", "interval_months", "lead_time_days", "criticality")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING "plan_id"`,
      [
        distributorId,
        p.nombre,
        p.sujeto,
        p.disparador,
        p.km ?? null,
        p.meses ?? null,
        p.anticipo,
        p.criticidad,
      ],
    );
    return r.plan_id;
  };
  const service = await plan({
    nombre: 'Service: aceite y filtros',
    sujeto: 'vehicle',
    disparador: 'by_km',
    km: 10000,
    anticipo: 15,
    criticidad: 'non_blocking',
  });
  const vtv = await plan({
    nombre: 'Revisión técnica obligatoria (VTV)',
    sujeto: 'vehicle',
    disparador: 'by_time',
    meses: 12,
    anticipo: 30,
    criticidad: 'blocking',
  });
  const frenos = await plan({
    nombre: 'Control de frenos y neumáticos',
    sujeto: 'vehicle',
    disparador: 'by_km',
    km: 20000,
    anticipo: 10,
    criticidad: 'non_blocking',
  });
  const carnet = await plan({
    nombre: 'Renovación del carnet profesional de conducir',
    sujeto: 'driver',
    disparador: 'by_time',
    meses: 60,
    anticipo: 45,
    criticidad: 'blocking',
  });

  let tareas = 0;
  const tarea = async (t: {
    plan: string;
    carId?: string;
    deliveryId?: string;
    estado: 'forecast' | 'scheduled' | 'done' | 'overdue';
    venceEnDias: number;
    dueKm?: number;
    programadaEnDias?: number;
    hechaHaceDias?: number;
    odometro?: number;
    costo?: number;
    proveedor?: string;
    referencia?: string;
    categoria?: string;
    notas?: string;
  }) => {
    const vence = hace(-t.venceEnDias);
    await m.query(
      `INSERT INTO "maintenance_task"
         ("plan_id", "distributor_id", "car_id", "delivery_id", "status", "due_at", "due_km", "predicted_due_at",
          "scheduled_at", "performed_at", "odometer_km", "cost", "provider", "reference_number", "category", "notes")
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $6::timestamptz, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        t.plan,
        distributorId,
        t.carId ?? null,
        t.deliveryId ?? null,
        t.estado,
        vence,
        t.dueKm ?? null,
        t.programadaEnDias !== undefined ? hace(-t.programadaEnDias) : null,
        t.hechaHaceDias !== undefined ? hace(t.hechaHaceDias) : null,
        t.odometro ?? null,
        t.costo ?? null,
        t.proveedor ?? null,
        t.referencia ?? null,
        t.categoria ?? null,
        t.notas ?? null,
      ],
    );
    tareas += 1;
  };

  for (const [i, f] of flota.entries()) {
    // Service: el último ya hecho y el próximo pronosticado.
    await tarea({
      plan: service,
      carId: f.carId,
      estado: 'done',
      venceEnDias: -(60 + i * 9),
      dueKm: f.km - 4200 - i * 300,
      hechaHaceDias: 58 + i * 9,
      odometro: f.km - 4300 - i * 300,
      costo: 78000 + i * 6500,
      proveedor: 'Taller Los Pinos',
      referencia: `OT-${2300 + i}`,
      categoria: 'service',
    });
    await tarea({
      plan: service,
      carId: f.carId,
      estado: i === 1 ? 'scheduled' : 'forecast',
      venceEnDias: 20 + i * 11,
      dueKm: f.km + 5700 - i * 300,
      programadaEnDias: i === 1 ? 6 : undefined,
    });
    // VTV: una vencida, una programada, el resto vigente (hecha).
    if (i === 3) {
      await tarea({
        plan: vtv,
        carId: f.carId,
        estado: 'overdue',
        venceEnDias: -9,
        notas: 'Turno sin sacar: el camión está habilitado hasta regularizar',
      });
    } else if (i === 2) {
      await tarea({
        plan: vtv,
        carId: f.carId,
        estado: 'scheduled',
        venceEnDias: 13,
        programadaEnDias: 11,
        categoria: 'inspección',
      });
    } else {
      await tarea({
        plan: vtv,
        carId: f.carId,
        estado: 'done',
        // Siempre antes que el último service (58 + 9i días): tiene menos km y el odómetro de las
        // tareas hechas de un vehículo no puede bajar con el tiempo (odometro_de_tarea_monotono).
        venceEnDias: 200 + i * 10,
        hechaHaceDias: 165 - i * 10,
        odometro: f.km - 9000,
        costo: 42000,
        proveedor: 'Planta VTV Posadas',
        referencia: `VTV-${4410 + i}`,
        categoria: 'inspección',
      });
    }
    if (i < 3) {
      await tarea({
        plan: frenos,
        carId: f.carId,
        estado: 'forecast',
        venceEnDias: 35 + i * 14,
        dueKm: f.km + 3000,
      });
    }
    await tarea({
      plan: carnet,
      deliveryId: f.deliveryId,
      estado: i === 4 ? 'scheduled' : 'forecast',
      venceEnDias: i === 4 ? 40 : 300 + i * 120,
      programadaEnDias: i === 4 ? 25 : undefined,
      categoria: 'documentos',
    });
  }
  return { planes: 4, tareas };
}

/** Uso diario de cada vehículo a partir de las entregas (km, pedidos y horas de ruta). */
export async function sembrarUsoDeFlota(
  m: EntityManager,
  distributorId: string,
  entregas: ReadonlyArray<{ carId: string; dia: string }>,
): Promise<number> {
  const porDia = new Map<string, { carId: string; dia: string; n: number }>();
  for (const e of entregas) {
    const k = `${e.carId}|${e.dia}`;
    const x = porDia.get(k) ?? { carId: e.carId, dia: e.dia, n: 0 };
    x.n += 1;
    porDia.set(k, x);
  }
  let filas = 0;
  for (const x of porDia.values()) {
    await m.query(
      `INSERT INTO "vehicle_usage_log" ("car_id", "distributor_id", "day", "km", "orders", "route_hours")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        x.carId,
        distributorId,
        x.dia,
        18 + x.n * 9 + (x.carId.charCodeAt(1) % 7),
        x.n,
        Math.round((2.5 + x.n * 0.55) * 10) / 10,
      ],
    );
    filas += 1;
  }
  return filas;
}
