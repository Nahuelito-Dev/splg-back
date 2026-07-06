import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';

@ApiTags('Reports')
@ApiBearerAuth()
@Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('reports')
export class ReportsController {
    constructor(private readonly reportsService: ReportsService) { }

    private parseDates(from?: string, to?: string) {
        const startDate = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0)); // Default today 00:00
        const endDate = to ? new Date(to) : new Date(); // Default now

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            throw new BadRequestException('Invalid date format (YYYY-MM-DD)');
        }

        return { startDate, endDate };
    }

    @Get('sales-by-driver')
    @ApiOperation({ summary: 'Ventas por Repartidor' })
    @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD' })
    @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD' })
    async getSalesByDriver(@Query('from') from?: string, @Query('to') to?: string) {
        const { startDate, endDate } = this.parseDates(from, to);
        return this.reportsService.getSalesByDriver(startDate, endDate);
    }

    @Get('sales-by-product')
    @ApiOperation({ summary: 'Ventas por Producto' })
    @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD' })
    @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD' })
    async getSalesByProduct(@Query('from') from?: string, @Query('to') to?: string) {
        const { startDate, endDate } = this.parseDates(from, to);
        return this.reportsService.getSalesByProduct(startDate, endDate);
    }

    @Get('sales-by-payment')
    @ApiOperation({ summary: 'Ventas por Método de Pago' })
    @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD' })
    @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD' })
    async getSalesByPayment(@Query('from') from?: string, @Query('to') to?: string) {
        const { startDate, endDate } = this.parseDates(from, to);
        return this.reportsService.getSalesByPaymentMethod(startDate, endDate);
    }
}
