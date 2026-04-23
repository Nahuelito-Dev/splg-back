  // admin.controller.ts - CORREGIDO
  import { Controller, Post, Body, Get, ForbiddenException, HttpCode, HttpStatus, Param } from '@nestjs/common';
  import { AdminService } from './admin.service';
  import { RegisterAdminDto } from './dto/register-admin.dto';
  import { ApiOperation, ApiResponse } from '@nestjs/swagger';
  import { Public } from 'src/common/decorators/isPublic.decorator';
  import { CreateAdminDto } from './dto/create-admin.dto';

  @Controller('admin')
  export class AdminController {
    constructor(private readonly adminService: AdminService) {}

    @Public()
    @Post()
    @ApiOperation({ summary: 'Create admin (basic)' })
    async create(@Body() createAdminDto: CreateAdminDto) {
      return await this.adminService.create(createAdminDto);
    }

    @Public()
    @Get('/term/:term')
    @ApiOperation({ summary: 'Find admin by term' })
    findOneByEmail(@Param('term') term: string) {
      return this.adminService.findAdminByTerm(term);
    }

    @Public()
    @Post('first-superadmin')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Create first super admin (development only)' })
    @ApiResponse({
      status: 201,
      description: 'First super admin created successfully',
    })
    @ApiResponse({ status: 403, description: 'Admins already exist in system' })
    async createFirstSuperAdmin(@Body() registerAdminDto: RegisterAdminDto) {
      // Validar que no existan otros admins
      const existingAdmins = await this.adminService.findAll();
      if (existingAdmins.length > 0) {
        throw new ForbiddenException(
          'Ya existen administradores en el sistema',
        );
      }

      return await this.adminService.registerAdmin(registerAdminDto);
    }
    @Post('register')
    @ApiOperation({ summary: 'Register a new admin (super_admin only)' })
    async register(@Body() registerAdminDto: RegisterAdminDto) {
      return await this.adminService.registerAdmin(registerAdminDto);
    }

    @Get()
    @ApiOperation({ summary: 'Get all admins' })
    async findAll() {
      return this.adminService.findAll();
    }
  }
