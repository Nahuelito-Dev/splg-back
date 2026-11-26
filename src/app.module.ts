import { ClassSerializerInterceptor, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { SentryModule } from '@sentry/nestjs/setup';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Redis } from 'ioredis';
import { redisConnectionOptions } from './common/redis/redis-connection';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthGuard } from './auth/guards/jwt-auth.guard';
import {
  AppThrottlerGuard,
  THROTTLER_CUENTA,
  esRutaDeAcceso,
  esRutaDeSubida,
  THROTTLER_SUBIDAS,
} from './common/guards/app-throttler.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PermissionGuard } from './admin/guards/permission.guard';
import { AlcanceGuard } from './common/guards/alcance.guard';
import { SupportModule } from './support/support.module';
import { ChatModule } from './chat/chat.module';
import { AssistantModule } from './assistant/assistant.module';
import { AsistenteIaModule } from './assistant-ai/asistente-ia.module';
import { AssistantLabModule } from './assistant-lab/assistant-lab.module';
import { ObservabilityModule } from './observability/observability.module';
import { PlatformModule } from './platform/platform.module';
import { PlatformAccessModule } from './platform/access/platform-access.module';
import { ModuloGuard } from './platform/access/modulo.guard';
import { UsersModule } from './users/users.module';
import { AdminModule } from './admin/admin.module';
import { AutoridadSobreCuentasModule } from './admin/autoridad-sobre-cuentas.module';
import { RegistroModule } from './registro/registro.module';
import { AuthModule } from './auth/auth.module';
import { CarModule } from './car/car.module';
import { RoleModule } from './role/role.module';
import { DeliveryModule } from './delivery/delivery.module';
import { CustomersModule } from './customer/customer.module';
import { CustomerContainerModule } from './customer-container/customer-container.module';
import { OrderModule } from './order/order.module';
import { GasCylinderModule } from './gascylinder/gascylinder.module';
import { EmailModule } from './email/email.module';
import { NotificationsModule } from './notifications/notifications.module';
import { UserAddressModule } from './user-address/user-address.module';
import { DistributorModule } from './distributor/distributor.module';
import { RatingModule } from './rating/rating.module';
import { IncidentModule } from './incident/incident.module';
import { CoverageZoneModule } from './coverage-zone/coverage-zone.module';
import { CylinderModule } from './cylinder/cylinder.module';
import { CylinderRecoveryModule } from './cylinder/recovery/cylinder-recovery.module';
import { FleetModule } from './fleet/fleet.module';
import { RouteBatchModule } from './route-batch/route-batch.module';
import { FailedVisitModule } from './failed-visit/failed-visit.module';
import { FleetExpenseModule } from './fleet-expense/fleet-expense.module';
import { InsuranceModule } from './insurance/insurance.module';
import { CartModule } from './cart/cart.module';
import { RepurchaseModule } from './repurchase/repurchase.module';
import { RepurchaseForecastModule } from './repurchase-forecast/repurchase-forecast.module';
import { AuditModule } from './audit/audit.module';
import { DocumentSequenceModule } from './document-sequence/document-sequence.module';
import { AttachmentModule } from './attachment/attachment.module';
import { EmployeeModule } from './employee/employee.module';
import { AttendanceModule } from './attendance/attendance.module';
import { LeaveModule } from './leave/leave.module';
import { PersonnelModule } from './personnel/personnel.module';
import { PurchaseModule } from './purchase/purchase.module';
import { TruckLoadModule } from './truck-load/truck-load.module';
import { CashModule } from './cash/cash.module';
import { SalesIncomeModule } from './cash/sales-income.module';
import { MpReconciliationModule } from './mp-reconciliation/mp-reconciliation.module';
import { CommissionModule } from './commission/commission.module';
import { CustomerAccountModule } from './customer-account/customer-account.module';
import { DriverSettlementModule } from './driver-settlement/driver-settlement.module';
import { FinanceModule } from './finance/finance.module';
import { StockModule } from './stock/stock.module';

// Importa el interceptor de timeout
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptors';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ContextoDeSentryInterceptor } from './common/sentry/contexto-de-sentry.interceptor';
import { TypeOrmModule } from '@nestjs/typeorm';
import { enteroPositivoDeEnv } from './common/config/entero-positivo';
import { EnvConfiguration } from './common/config/env.config';
import { plataformaConfig } from './common/config/plataforma.config';
import { JoiValidationSchema } from './common/config/joi.validation';
import { RedisModule } from './redis/redis.module';
import { ImportModule } from './import/import.module';
import { ClaimsModule } from './claims/claims.module';
import { AdminNotificationsModule } from './admin-notifications/admin-notifications.module';
import { ProcessRunModule } from './process-run/process-run.module';
import { NotificationLogModule } from './notification-log/notification-log.module';
import { TimeSlotModule } from './time-slot/time-slot.module';
import { PdfModule } from './pdf/pdf.module';
import { ReportsModule } from './reports/reports.module';
import { RoutesModule } from './routes/routes.module';
import { LiveFleetModule } from './live-fleet/live-fleet.module';
import { HealthModule } from './health/health.module';
import { FirebaseModule } from './firebase/firebase.module';
import { ExportsModule } from './exports/exports.module';
import { PeoplePhotosModule } from './people-photos/people-photos.module';
import { DocumentReaderModule } from './document-reader/document-reader.module';
import { DocumentReadingModule } from './document-reading/document-reading.module';
import { ReceiptReaderModule } from './receipt-reader/receipt-reader.module';
import { GraphqlApiModule } from './graphql/graphql-api.module';

@Module({
  imports: [
    // Sentry (errores, trazas y logs; ver common/config/sentry.config.ts): sin
    // `SENTRY_DSN` el SDK no se inicializa y esto no manda nada.
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      load: [EnvConfiguration, plataformaConfig],
      validationSchema: JoiValidationSchema,
      isGlobal: true,
      // Los tests de integración reciben el entorno de sus contenedores: el
      // `.env` de desarrollo no se lee nunca (apuntaría a `splg_db`).
      ignoreEnvFile: process.env.STAGE === 'test',
    }),
    // Rate limiting (C4, hardening de prod). Límite GLOBAL por IP; los
    // endpoints sensibles (login) usan @Throttle() con un límite más
    // estricto por ruta, y el webhook de MercadoPago / health check se
    // excluyen con @SkipThrottle() (no son tráfico de usuario final).
    // Valores configurables por env; con defaults sensatos si no se setean.
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
          limit: Number(process.env.THROTTLE_LIMIT ?? 100),
        },
        // Segundo cupo, SOLO en las rutas de acceso: cuenta los intentos por
        // cuenta además de por IP. Frena probar contraseñas contra un usuario
        // sin castigar a los usuarios legítimos que comparten IP pública
        // (CGNAT del operador móvil). Ver AppThrottlerGuard.generateKey.
        {
          name: THROTTLER_CUENTA,
          ttl: Number(process.env.THROTTLE_LOGIN_TTL_MS ?? 60_000),
          limit: Number(process.env.THROTTLE_LOGIN_LIMIT ?? 8),
          skipIf: (context) => !esRutaDeAcceso(context),
        },
        // Tercer cupo, SOLO en las subidas de archivos: cada imagen se
        // decodifica y recodifica en el back (memoria y CPU), así que el tope
        // por sesión es bastante más bajo que el general.
        {
          name: THROTTLER_SUBIDAS,
          ttl: Number(process.env.THROTTLE_UPLOAD_TTL_MS ?? 60_000),
          limit: Number(process.env.THROTTLE_UPLOAD_LIMIT ?? 10),
          skipIf: (context) => !esRutaDeSubida(context),
        },
      ],
      // Storage en Redis: con más de una instancia, el rate-limit se cuenta de
      // forma compartida (sin esto, cada pod tenía su propio contador en memoria
      // y el límite efectivo era N×límite).
      storage: new ThrottlerStorageRedisService(
        new Redis(redisConnectionOptions()),
      ),
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const stage = configService.get<string>('STAGE');
        // AQUI ESTA LA CLAVE: Leemos si DB_SSL es 'true' en el .env
        const isSslEnabled = configService.get('DB_SSL') === 'true';
        const isProd = stage === 'prod';

        return {
          type: 'postgres',
          host: configService.get('DB_HOST'),
          port: configService.get('DB_PORT'),
          username: configService.get('DB_USERNAME'),
          password: configService.get('DB_PASSWORD'),
          database: configService.get('DB_NAME'),

          // Si en el .env dice DB_SSL=true, activamos SSL (aunque sea dev)
          ssl: isSslEnabled ? { rejectUnauthorized: false } : false,

          // Configuración extra necesaria para Render
          extra: {
            // Quién es esta conexión en `pg_stat_activity` y en la auditoría
            // (`audit.app_name`): la API es `splg-api`; un script de
            // mantenimiento fija `DB_APP_NAME=splg-script:<nombre>`. Una
            // escritura sin usuario cuyo nombre es otro (psql, un cliente
            // cualquiera) se lee como cambio directo en la base.
            application_name:
              configService.get<string>('DB_APP_NAME') ?? 'splg-api',
            // Sólo los seeds de desarrollo (`DB_AUDIT_OFF=on`): sus conexiones
            // no dejan asientos de datos (`auditoria_trigger` lo respeta).
            ...(configService.get('DB_AUDIT_OFF') === 'on'
              ? { options: '-c splg.audit_off=on' }
              : {}),
            // Conexiones del pool (10 por defecto de `pg`). Cada pedido
            // concurrente retiene una dentro de su transacción mientras otra
            // consulta pide una segunda: con el pool chico, 10 pedidos
            // simultáneos se bloquean entre sí.
            max: Number(configService.get('DB_POOL_SIZE') ?? 10),
            // Red de seguridad contra transacciones/consultas colgadas (un
            // deadlock de aplicación entre dos conexiones no lo detecta
            // Postgres): la sesión que quede `idle in transaction`, la
            // consulta que espere un lock o la que no termine se cortan solas
            // en vez de bloquear pedidos para siempre. En ms.
            idle_in_transaction_session_timeout: enteroPositivoDeEnv(
              'DB_IDLE_IN_TX_TIMEOUT_MS',
              configService.get('DB_IDLE_IN_TX_TIMEOUT_MS'),
              60_000,
            ),
            lock_timeout: enteroPositivoDeEnv(
              'DB_LOCK_TIMEOUT_MS',
              configService.get('DB_LOCK_TIMEOUT_MS'),
              30_000,
            ),
            statement_timeout: enteroPositivoDeEnv(
              'DB_STATEMENT_TIMEOUT_MS',
              configService.get('DB_STATEMENT_TIMEOUT_MS'),
              90_000,
            ),
            ...(isSslEnabled ? { ssl: { rejectUnauthorized: false } } : {}),
          },

          // El esquema se gestiona con MIGRACIONES (fuente de verdad), en todos
          // los ambientes. `synchronize:false` por defecto para no alterar el
          // esquema al vuelo. En dev se puede optar por sync rápido con
          // DB_SYNC=true, pero nunca en prod (aunque se setee).
          synchronize: !isProd && configService.get('DB_SYNC') === 'true',
          autoLoadEntities: true,
          // Sólo la carpeta raíz: `migrations/sql/` guarda las sentencias que
          // comparten las migraciones y las pruebas, y exporta funciones que
          // TypeORM tomaría por migraciones.
          migrations: [__dirname + '/migrations/*{.ts,.js}'],
          cli: {
            migrationsDir: __dirname + '/migrations/',
          },
          // En dev se registra cada consulta, que es lo que se quiere cuando
          // se está depurando. Con DB_LOGGING=false se apaga sin salir de dev:
          // sirve para demostrar el panel sin que la consola se llene de SQL.
          logging: !isProd && configService.get('DB_LOGGING') !== 'false',
        };
      },
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    // Eventos de dominio entre módulos (CONVENCIONES 4): hoy, el pago
    // notificado que publica payments y confirma order.
    EventEmitterModule.forRoot(),
    DocumentReaderModule,
    DocumentReadingModule,
    ReceiptReaderModule,
    // Global: un único init del Admin SDK de Firebase para todo el proceso
    // (ver firebase/firebase.module.ts). Provee FirebaseAuthPort y FcmPort.
    FirebaseModule,
    UsersModule,
    AdminModule,
    // Regla sobre cuentas de otros para `users` (puerto, sin ciclo).
    AutoridadSobreCuentasModule,
    RegistroModule,
    AuthModule,
    CarModule,
    RoleModule,
    DeliveryModule,
    CustomersModule,
    CustomerContainerModule,
    OrderModule,
    GasCylinderModule,
    EmailModule,
    NotificationsModule,
    UserAddressModule,
    RedisModule,
    ClaimsModule,
    AdminNotificationsModule,
    ProcessRunModule,
    NotificationLogModule,
    TimeSlotModule,
    ReportsModule,
    PdfModule,
    HealthModule,
    RoutesModule,
    LiveFleetModule,
    DistributorModule,
    RatingModule,
    IncidentModule,
    CoverageZoneModule,
    CylinderModule,
    CylinderRecoveryModule,
    FleetModule,
    RouteBatchModule,
    FailedVisitModule, // entrega fallida y nueva visita (C5)
    FleetExpenseModule,
    InsuranceModule,
    CartModule,
    RepurchaseModule,
    RepurchaseForecastModule,
    AuditModule,
    DocumentSequenceModule,
    AttachmentModule,
    EmployeeModule,
    AttendanceModule,
    LeaveModule,
    PersonnelModule,
    StockModule,
    PurchaseModule,
    TruckLoadModule,
    CashModule,
    SalesIncomeModule,
    MpReconciliationModule,
    CommissionModule,
    DriverSettlementModule,
    CustomerAccountModule,
    FinanceModule,
    ExportsModule,
    PeoplePhotosModule,
    ImportModule,
    SupportModule,
    PlatformAccessModule,
    ChatModule,
    PlatformModule,
    ObservabilityModule,
    // TEMPORAL: ruta de prueba de Sentry, sólo en development y test.
    AssistantModule,
    AsistenteIaModule,
    AssistantLabModule,
    GraphqlApiModule,
  ],
  providers: [
    // Guards globales. El ORDEN importa: ThrottlerGuard corta temprano (barato,
    // protege de abuso/DoS antes de gastar trabajo en auth/DB); AuthGuard
    // autentica y setea req.user; RolesGuard lee ese req.user para autorizar
    // por rol. Antes RolesGuard no se registraba en ningún lado → todos los
    // @Roles() eran no-ops (agujero de authz).
    {
      provide: APP_GUARD,
      useClass: AppThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      // Permisos del personal del panel (F37): después de RolesGuard, sólo
      // para los endpoints con @Permiso y sólo restringe a los admin.
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
    {
      // Modo soporte (después de los permisos): el super admin sólo ve lo de
      // una empresa con una sesión de soporte activa, y sólo a leer.
      provide: APP_GUARD,
      useClass: AlcanceGuard,
    },
    {
      // Módulos por distribuidora (último): un endpoint `@RequiereModulo(m)`
      // de una empresa sin `m` habilitado responde 403 `MODULE_DISABLED`.
      provide: APP_GUARD,
      useClass: ModuloGuard,
    },
    {
      // Logging estructurado, PRIMERO en la cadena de interceptors: mide la
      // duración TOTAL del request (envuelve también al timeout/idempotency).
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      // Contexto de Sentry (usuario, empresa, cliente, request id): después de
      // los guards, que son los que resuelven el usuario y la empresa.
      provide: APP_INTERCEPTOR,
      useClass: ContextoDeSentryInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TimeoutInterceptor,
    },
    {
      // Idempotency interceptor global: solo actúa en handlers decorados
      // con @Idempotent(). Backwards compatible: si el cliente no envía
      // el header `Idempotency-Key`, el handler se ejecuta normalmente.
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
    {
      // Serializacion global de la salida. Hasta ahora solo `order` la
      // aplicaba, asi que el resto de los modulos devolvia la entidad de
      // TypeORM entera. Con esto un @Exclude() en una entidad se respeta en
      // todos los modulos y un controlador nuevo nace con la salida filtrada.
      //
      // No se pudo habilitar antes: el login devolvia el objeto de Firebase,
      // que tiene referencias circulares y hacia entrar a class-transformer en
      // recursion infinita. Ahora devuelve un DTO propio.
      provide: APP_INTERCEPTOR,
      useClass: ClassSerializerInterceptor,
    },
  ],
})
export class AppModule {}
