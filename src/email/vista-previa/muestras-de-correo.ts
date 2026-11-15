import { ConfigService } from '@nestjs/config';
import { correoDelAviso } from '../../admin-notifications/aviso-por-correo';
import { AdminNotification } from '../../admin-notifications/entities/admin-notification.entity';
import { mensajeDeJornadasSinCerrar } from '../../attendance/correo-jornadas-sin-cerrar';
import { mensajeDeRendicionesSinCerrar } from '../../driver-settlement/application/correo-rendiciones-sin-cerrar';
import {
  mensajeDeAsignacionPendiente,
  mensajeDeCargaAnomala,
  mensajeDeDerrame,
} from '../../fleet-expense/correos-de-gastos-de-flota';
import { mensajeDeVencimientos } from '../../fleet/correo-vencimientos';
import { mensajeDePropuestaDeTaller } from '../../fleet/planner/correo-propuesta-de-taller';
import {
  mensajeDeConciliacion,
  mensajeDeStockBajo,
} from '../../stock/application/correos-de-stock';
import { EmailTemplateProvider } from '../email-template.provider';
import { EnlacesDeLaApp } from '../enlaces-de-la-app';
import { armarCorreo, CorreoArmado } from '../layout/correo';
import {
  marcaDeDistribuidora,
  marcaDePlataforma,
} from '../layout/marca-de-correo';

/** Un correo de muestra, armado con datos de ejemplo. */
export interface MuestraDeCorreo {
  clave: string;
  nombre: string;
  grupo: 'Plataforma' | 'Distribuidora';
  /** Destinatario de ejemplo (el de la vista previa). */
  para: string;
  correo: CorreoArmado;
}

export interface OpcionesDeMuestras {
  /** Variables de la plataforma (`PLATFORM_*`) y `APP_URL`. */
  env?: Record<string, string | undefined>;
  /** Mete `<script>` y comillas en cada dato que escribe una persona: para probar el escape. */
  hostil?: boolean;
}

const URL_POR_OMISION = 'https://app.splg.com.ar';

/**
 * Todos los correos del sistema con datos de ejemplo. Lo usan la vista
 * previa (`npm run email:preview`), el envío de muestras
 * (`npm run email:muestras`) y los tests del layout. Un correo nuevo se suma
 * acá para que aparezca en los tres.
 */
export function muestrasDeCorreo(
  opciones: OpcionesDeMuestras = {},
): MuestraDeCorreo[] {
  const env: Record<string, string | undefined> = {
    ...opciones.env,
    PLATFORM_NAME: opciones.env?.PLATFORM_NAME ?? 'OrixTech',
  };
  const t = (texto: string) =>
    opciones.hostil ? `${texto} <script>alert("x")</script> & 'co'` : texto;

  const plataforma = marcaDePlataforma(env);
  const distribuidora = marcaDeDistribuidora(t('Gas del Litoral'), env);
  const base = (env.APP_URL ?? URL_POR_OMISION).replace(/\/+$/, '');
  const enlaces = new EnlacesDeLaApp({
    get: (clave: string) => (clave === 'APP_URL' ? base : undefined),
    getOrThrow: () => 'splg-demo',
  } as unknown as ConfigService);
  const plantillas = new EmailTemplateProvider(enlaces);
  const deLaPlataforma = (
    clave: string,
    nombre: string,
    data: Record<string, string | undefined>,
  ): MuestraDeCorreo => ({
    clave,
    nombre,
    grupo: 'Plataforma',
    para: 'ana.perez@ejemplo.com',
    correo: plantillas.renderCorreo(clave, data, plataforma),
  });
  const deLaDistribuidora = (
    clave: string,
    nombre: string,
    correo: CorreoArmado,
    para = 'admin@gasdellitoral.com.ar',
  ): MuestraDeCorreo => ({
    clave,
    nombre,
    grupo: 'Distribuidora',
    para,
    correo,
  });

  const aviso = {
    notificationId: 'n-1',
    distributorId: 'd-1',
    kind: 'claim_created',
    title: t('Nuevo reclamo en el pedido #A1B2C3'),
    body: t(
      'Pedido #A1B2C3 — Marta Giménez: «La garrafa llegó con olor a gas».\nRevisalo y respondé desde Reclamos.',
    ),
    linkEntity: 'order',
    linkId: 'o-1',
    dedupeKey: 'claim:c-1',
    email: true,
    emailedAt: null,
    createdAt: new Date('2026-11-14T12:00:00Z'),
  } as AdminNotification;

  return [
    deLaPlataforma('welcome', 'Bienvenida', {
      displayName: t('Ana Pérez'),
      supportEmail: plataforma.contacto ?? undefined,
    }),
    deLaPlataforma('email-verification', 'Verificación de correo', {
      displayName: t('Ana Pérez'),
      verificationLink: `${base}/__/auth/action?mode=verifyEmail&oobCode=EJEMPLO`,
    }),
    deLaPlataforma('password-reset', 'Restablecer contraseña', {
      email: t('ana.perez@ejemplo.com'),
      resetLink: `${base}/__/auth/action?mode=resetPassword&oobCode=EJEMPLO`,
    }),
    deLaPlataforma('email-change-notification', 'Cambio de correo', {
      displayName: t('Ana Pérez'),
      newEmail: 'ana.nueva@ejemplo.com',
    }),
    deLaDistribuidora(
      'aviso-del-panel',
      'Aviso de la bandeja del panel',
      correoDelAviso(aviso, `${base}/orders/o-1`, distribuidora),
    ),
    deLaDistribuidora(
      'jornadas-sin-cerrar',
      'Jornadas sin cerrar (asistencia)',
      armarCorreo(
        distribuidora,
        mensajeDeJornadasSinCerrar([
          { persona: t('Ana Pérez'), dia: '2026-11-12', ingreso: '07:58' },
          { persona: 'Carlos Benítez', dia: '2026-11-13', ingreso: '08:04' },
        ]),
      ),
    ),
    deLaDistribuidora(
      'rendiciones-sin-cerrar',
      'Rendiciones sin cerrar',
      armarCorreo(
        distribuidora,
        mensajeDeRendicionesSinCerrar([
          {
            numero: 41,
            dia: '2026-11-12',
            chofer: t('Jorge Duarte'),
            presentada: false,
          },
          { numero: 43, dia: '2026-11-13', chofer: null, presentada: true },
        ]),
      ),
    ),
    deLaDistribuidora(
      'carga-anomala',
      'Consumo de combustible anómalo',
      armarCorreo(
        distribuidora,
        mensajeDeCargaAnomala(t('AE 123 KD'), '7c1e2f90-carga'),
      ),
    ),
    deLaDistribuidora(
      'derrame',
      'Derrame de gas en un siniestro',
      armarCorreo(
        distribuidora,
        mensajeDeDerrame(t('AE 123 KD'), '5b7d1a22-siniestro'),
      ),
    ),
    deLaDistribuidora(
      'asignacion-pendiente',
      'Vehículo fuera de servicio con chofer en entrega',
      armarCorreo(
        distribuidora,
        mensajeDeAsignacionPendiente(
          t('AE 123 KD'),
          '5b7d1a22-siniestro',
          t('tiene 3 pedidos en camino'),
        ),
      ),
    ),
    deLaDistribuidora(
      'vencimientos',
      'Vencimientos de flota y personal',
      armarCorreo(
        distribuidora,
        mensajeDeVencimientos(
          [
            {
              que: 'VTV',
              sujeto: t('Vehículo AE 123 KD'),
              vence: '20/11/2026',
            },
            {
              que: 'Examen psicofísico',
              sujeto: 'Empleado Carlos Benítez',
              vence: '02/11/2026',
            },
          ],
          [
            {
              chofer: t('Jorge Duarte'),
              faltan: ['Licencia de conducir', 'Curso de transporte de GLP'],
            },
          ],
        ),
      ),
    ),
    deLaDistribuidora(
      'propuesta-de-taller',
      'Turno de taller (al chofer)',
      armarCorreo(
        distribuidora,
        mensajeDePropuestaDeTaller(
          {
            patente: t('AE 123 KD'),
            tarea: t('Service de 10.000 km'),
            cuando: 'lunes, 17 de noviembre de 2026, 08:00',
            responderAntes: 'sábado, 15 de noviembre de 2026, 19:00',
          },
          distribuidora.nombre,
        ),
      ),
      'jorge.duarte@ejemplo.com',
    ),
    deLaDistribuidora(
      'stock-bajo',
      'Stock bajo',
      armarCorreo(
        distribuidora,
        mensajeDeStockBajo([
          {
            deposito: t('Depósito Central'),
            garrafa: '10kg',
            llenas: 4,
            minimo: 20,
          },
          { deposito: 'Depósito Norte', garrafa: '45kg', llenas: 1, minimo: 5 },
        ]),
      ),
    ),
    deLaDistribuidora(
      'conciliacion-de-stock',
      'Conciliación de stock con diferencias',
      armarCorreo(
        distribuidora,
        mensajeDeConciliacion(
          [
            {
              garrafa: t('10kg'),
              vendible: 12,
              esperado: 14,
              llenas: 20,
              reservadas: 6,
              diferencia: -2,
              reservadasDeMas: 0,
            },
            {
              garrafa: '15kg',
              vendible: 0,
              esperado: -2,
              llenas: 3,
              reservadas: 5,
              diferencia: 0,
              reservadasDeMas: 2,
            },
          ],
          1,
        ),
      ),
    ),
  ];
}

/** Todos los componentes del layout juntos, para revisar el diseño (sólo vista previa). */
export function catalogoDeComponentes(
  env: Record<string, string | undefined> = {},
): CorreoArmado {
  return armarCorreo(marcaDePlataforma({ PLATFORM_NAME: 'OrixTech', ...env }), {
    asunto: 'Catálogo de componentes del correo',
    preheader: 'Todos los bloques del layout en un solo correo.',
    etiqueta: 'Componentes',
    titulo: 'Catálogo de componentes',
    bloques: [
      {
        tipo: 'parrafo',
        texto: [
          'Párrafo con ',
          { fuerte: 'negrita' },
          ', ',
          { mono: 'AE 123 KD' },
          ' y un ',
          { enlace: 'enlace', url: 'https://ejemplo.com' },
          '.',
        ],
      },
      {
        tipo: 'parrafo',
        suave: true,
        texto: 'Párrafo suave, para aclaraciones.',
      },
      { tipo: 'boton', texto: 'Botón principal', url: 'https://ejemplo.com' },
      {
        tipo: 'enlace-alternativo',
        url: 'https://ejemplo.com/a/un/enlace/largo?token=ABC123',
      },
      {
        tipo: 'codigo',
        etiqueta: 'Tu código de verificación',
        codigo: '482 913',
      },
      {
        tipo: 'nota',
        tono: 'info',
        titulo: 'Info',
        texto: 'Nota informativa.',
      },
      {
        tipo: 'nota',
        tono: 'exito',
        titulo: 'Listo',
        texto: 'Algo salió bien.',
      },
      {
        tipo: 'nota',
        tono: 'aviso',
        titulo: 'Atención',
        texto: 'Algo para mirar.',
      },
      {
        tipo: 'nota',
        tono: 'peligro',
        titulo: 'Importante',
        texto: 'Algo urgente.',
      },
      {
        tipo: 'datos',
        titulo: 'Datos clave',
        filas: [
          { etiqueta: 'Pedido', valor: '#A1B2C3', mono: true },
          { etiqueta: 'Cliente', valor: 'Marta Giménez' },
          { etiqueta: 'Total', valor: '$ 18.500,00', mono: true },
        ],
      },
      {
        tipo: 'tabla',
        titulo: 'Tabla',
        columnas: [
          { titulo: 'Producto' },
          { titulo: 'Cant.', alinear: 'derecha', mono: true },
          { titulo: 'Importe', alinear: 'derecha', mono: true },
        ],
        filas: [
          ['Garrafa 10kg', '2', '$ 12.000,00'],
          ['Garrafa 15kg', '1', '$ 6.500,00'],
        ],
      },
      {
        tipo: 'lista',
        items: ['Un ítem', ['Otro con ', { fuerte: 'negrita' }]],
      },
      { tipo: 'separador' },
      { tipo: 'parrafo', texto: 'Fin del catálogo.' },
    ],
  });
}
