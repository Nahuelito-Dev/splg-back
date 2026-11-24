import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DistributorModule } from '../distributor/distributor.module';
import { EmailModule } from '../email/email.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoutePlanningHoliday } from '../order/entities/route-planning-holiday.entity';
import { RoutePlanningCalendarService } from '../route-batch/application/route-planning-calendar.service';
import { TimeSlotModule } from '../time-slot/time-slot.module';
import { OrderFailedVisit } from './entities/order-failed-visit.entity';
import { FailedVisitQueryService } from './failed-visit-query.service';
import { FailedVisitNotifier } from './failed-visit.notifier';
import { FailedVisitService } from './failed-visit.service';

/**
 * El registro de visitas fallidas y la nueva visita (C5), sin depender de
 * `OrderModule` ni de `RouteBatchModule`: así la hoja de ruta lo usa para
 * asentar sus intentos y el módulo de arriba (`FailedVisitModule`) suma el
 * «No pude entregar» de los pedidos sueltos sin armar un ciclo.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderFailedVisit,
      RoutePlanningHoliday, // sólo lectura: los feriados del calendario de reparto
    ]),
    TimeSlotModule, // franjas y su cupo
    DistributorModule, // calendario de reparto y radio de llegada
    GatewaysModule, // aviso al cliente y al panel por socket
    NotificationsModule, // push al cliente
    EmailModule, // correo al cliente
  ],
  providers: [
    FailedVisitService,
    FailedVisitNotifier,
    FailedVisitQueryService,
    RoutePlanningCalendarService, // días hábiles y feriados (lectura)
  ],
  exports: [FailedVisitService, FailedVisitNotifier, FailedVisitQueryService],
})
export class FailedVisitCoreModule {}
