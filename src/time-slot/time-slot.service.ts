import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { TimeSlot } from './entities/time-slot.entity';
import { CreateTimeSlotDto } from './dto/create-time-slot.dto';
import { DistributorService } from '../distributor/distributor.service';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TimeSlotService {
    constructor(
        @InjectRepository(TimeSlot)
        private readonly timeSlotRepository: Repository<TimeSlot>,
        private readonly distributorService: DistributorService,
    ) { }

    /**
     * Resuelve un `distributor_id` a partir de un slug o uuid (o null si no se
     * pasó nada). Usado por los endpoints públicos, donde el tenant llega por
     * query `?distributor=` (el guard no corre en rutas @Public).
     */
    async resolveDistributor(slugOrId?: string): Promise<string | null> {
        if (!slugOrId) return null;
        const distributor = UUID_RE.test(slugOrId)
            ? await this.distributorService.assertActive(slugOrId)
            : await this.distributorService.findBySlug(slugOrId);
        return distributor.distributor_id;
    }

    async create(createTimeSlotDto: CreateTimeSlotDto, distributorId: string) {
        const timeSlot = this.timeSlotRepository.create({
            ...createTimeSlotDto,
            distributor_id: distributorId,
        });
        return await this.timeSlotRepository.save(timeSlot);
    }

    async findAll(distributor?: string) {
        const distributorId = await this.resolveDistributor(distributor);

        const where: FindOptionsWhere<TimeSlot> = { isActive: true };
        if (distributorId) where.distributor_id = distributorId;

        return await this.timeSlotRepository.find({
            where,
            order: { startTime: 'ASC' },
        });
    }

    /**
     * `distributorId` opcional: si viene, la franja debe pertenecer a ese
     * tenant (evita que un admin lea/borre franjas de otra distribuidora).
     */
    async findOne(id: string, distributorId?: string | null) {
        const where: FindOptionsWhere<TimeSlot> = { time_slot_id: id };
        if (distributorId) where.distributor_id = distributorId;

        const timeSlot = await this.timeSlotRepository.findOne({ where });
        if (!timeSlot) throw new NotFoundException('Time slot not found');
        return timeSlot;
    }

    async remove(id: string, distributorId: string) {
        const timeSlot = await this.findOne(id, distributorId);
        timeSlot.isActive = false;
        return await this.timeSlotRepository.save(timeSlot);
    }
}
