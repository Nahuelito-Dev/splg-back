import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Redis } from 'ioredis';
import { redisConnectionOptions } from './common/redis/redis-connection';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthGuard } from './auth/guards/jwt-auth.guard';
import { AppThrottlerGuard } from './common/guards/app-throttler.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { UsersModule } from './users/users.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CarModule } from './car/car.module';
import { RoleModule } from './role/role.module';
import { DeliveryModule } from './delivery/delivery.module';
import { CustomersModule } from './customer/customer.module';
import { OrderModule } from './order/order.module';
import { GasCylinderModule } from './gascylinder/gascylinder.module';
import { EmailModule } from './email/email.module';
import { NotificationsModule } from './notifications/notifications.module';
import { UserAddresModule } from './user-addres/user-addres.module';
import { DistributorModule } from './distributor/distributor.module';
import { RatingModule } from './rating/rating.module';
import { IncidentModule } from './incident/incident.module';
import { CoverageZoneModule } from './coverage-zone/coverage-zone.module';
import { CylinderModule } from './cylinder/cylinder.module';

// Importa el interceptor de timeout
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptors';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { EnvConfiguration } from './common/config/env.config';
import { JoiValidationSchema } from './common/config/joi.validation';
import { RedisModule } from './redis/redis.module';
import { ClaimsModule } from './claims/claims.module';
import { TimeSlotModule } from './time-slot/time-slot.module';
import { ReportsModule } from './reports/reports.module';
import { HealthModule } from './health/health.module';
import { FirebaseModule } from './firebase/firebase.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [EnvConfiguration],
      validationSchema: JoiValidationSchema,
      isGlobal: true,
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
      ],
      // Storage en Redis: con más de una instancia, el rate-limit se cuenta de
      // forma compartida (sin esto, cada pod tenía su propio contador en memoria
      // y el límite efectivo era N×límite).
      storage: new ThrottlerStorageRedisService(
        new Redis(redisConnectionOptions()),
      ),
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const stage = configService.get('STAGE');
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
          extra: isSslEnabled
            ? { ssl: { rejectUnauthorized: false } }
            : undefined,

          // El esquema se gestiona con MIGRACIONES (fuente de verdad), en todos
          // los ambientes. `synchronize:false` por defecto para no alterar el
          // esquema al vuelo. En dev se puede optar por sync rápido con
          // DB_SYNC=true, pero nunca en prod (aunque se setee).
          synchronize:
            !isProd && configService.get('DB_SYNC') === 'true',
          autoLoadEntities: true,
          migrations: [__dirname + '/migrations/**/*{.ts,.js}'],
          cli: {
            migrationsDir: __dirname + '/migrations/',
          },
          logging: !isProd,
        };
      },
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    // Global: un único init del Admin SDK de Firebase para todo el proceso
    // (ver firebase/firebase.module.ts). Provee FirebaseAuthPort y FcmPort.
    FirebaseModule,
    UsersModule,
    AdminModule,
    AuthModule,
    CarModule,
    RoleModule,
    DeliveryModule,
    CustomersModule,
    OrderModule,
    GasCylinderModule,
    EmailModule,
    NotificationsModule,
    UserAddresModule,
    RedisModule,
    ClaimsModule,
    TimeSlotModule,
    ReportsModule,
    HealthModule,
    DistributorModule,
    RatingModule,
    IncidentModule,
    CoverageZoneModule,
    CylinderModule,
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
      // Logging estructurado, PRIMERO en la cadena de interceptors: mide la
      // duración TOTAL del request (envuelve también al timeout/idempotency).
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
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
  ],
})
export class AppModule {}
