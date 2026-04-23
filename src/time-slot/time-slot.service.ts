import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeSlot } from './entities/time-slot.entity';
import { CreateTimeSlotDto } from './dto/create-time-slot.dto';

@Injectable()
export class TimeSlotService {
    constructor(
        @InjectRepository(TimeSlot)
        private readonly timeSlotRepository: Repository<TimeSlot>,
    ) { }

    async create(createTimeSlotDto: CreateTimeSlotDto) {
        const timeSlot = this.timeSlotRepository.create(createTimeSlotDto);
        return await this.timeSlotRepository.save(timeSlot);
    }

    async findAll() {
        return await this.timeSlotRepository.find({
            where: { isActive: true },
            order: { startTime: 'ASC' },
        });
    }

    async findOne(id: string) {
        const timeSlot = await this.timeSlotRepository.findOne({
            where: { time_slot_id: id },
        });
        if (!timeSlot) throw new NotFoundException('Time slot not found');
        return timeSlot;
    }

    async remove(id: string) {
        const timeSlot = await this.findOne(id);
        timeSlot.isActive = false;
        return await this.timeSlotRepository.save(timeSlot);
    }
}
