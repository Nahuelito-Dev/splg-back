import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { UsersModule } from './users/users.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CarModule } from './car/car.module';
import { PaymentgatwayModule } from './paymentgatway/paymentgatway.module';
import { RoleModule } from './role/role.module';
import { DeliveryModule } from './delivery/delivery.module';
import { CustomersModule } from './customer/customer.module';
import { OrderModule } from './order/order.module';
import { GasCylinderModule } from './gascylinder/gascylinder.module';
import { EmailModule } from './email/email.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SeedModule } from './seed/seed.module';
import { WebhookModule } from './webhook/webhook.module';
import { UserAddresModule } from './user-addres/user-addres.module';

// Importa el interceptor de timeout
import { timeOutInterceptor } from './common/interceptors/timeout.interceptors';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { EnvConfiguration } from './common/config/env.config';
import { JoiValidationSchema } from './common/config/joi.validation';
import { RedisModule } from './redis/redis.module';
import { ClaimsModule } from './claims/claims.module';
import { TimeSlotModule } from './time-slot/time-slot.module';
import { ReportsModule } from './reports/reports.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [EnvConfiguration],
      validationSchema: JoiValidationSchema,
      isGlobal: true,
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

          synchronize: true,
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
    UsersModule,
    AdminModule,
    AuthModule,
    CarModule,
    PaymentgatwayModule,
    RoleModule,
    DeliveryModule,
    CustomersModule,
    OrderModule,
    GasCylinderModule,
    EmailModule,
    NotificationsModule,
    SeedModule,
    WebhookModule,
    UserAddresModule,
    RedisModule,
    ClaimsModule,
    TimeSlotModule,
    ReportsModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: timeOutInterceptor,
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
