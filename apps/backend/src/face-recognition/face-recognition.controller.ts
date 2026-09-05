import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { FaceRecognitionService } from './face-recognition.service';
import { RegisterFaceDto, FaceCheckInDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Face Recognition')
@ApiBearerAuth('JWT-auth')
@Controller('face-recognition')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FaceRecognitionController {
  constructor(
    private readonly faceRecognitionService: FaceRecognitionService,
  ) {}

  @Post('register')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Register face',
    description:
      'Register a face image for the current user or specified employee',
  })
  @ApiResponse({ status: 201, description: 'Face registered successfully' })
  @ApiResponse({
    status: 400,
    description: 'Bad image quality or max descriptors reached',
  })
  registerFace(@Body() dto: RegisterFaceDto, @CurrentUser() user: any) {
    return this.faceRecognitionService.registerFace(
      dto.image,
      user,
      dto.employeeId,
    );
  }

  @Post('check-in')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Face check-in',
    description: 'Check in using face recognition',
  })
  @ApiResponse({ status: 201, description: 'Check-in result' })
  faceCheckIn(@Body() dto: FaceCheckInDto, @CurrentUser() user: any) {
    return this.faceRecognitionService.faceCheckIn(dto.image, user.employeeId, {
      latitude: dto.latitude,
      longitude: dto.longitude,
      accuracy: dto.accuracy,
    });
  }

  @Post('capture-check-in')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Face capture check-in',
    description: 'Check in with face photo capture (no recognition)',
  })
  @ApiResponse({ status: 201, description: 'Check-in result' })
  captureCheckIn(@Body() dto: FaceCheckInDto, @CurrentUser() user: any) {
    return this.faceRecognitionService.captureCheckIn(dto.image, user.employeeId, {
      latitude: dto.latitude,
      longitude: dto.longitude,
      accuracy: dto.accuracy,
    });
  }

  @Post('check-out')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Face check-out',
    description: 'Check out using face recognition',
  })
  @ApiResponse({ status: 201, description: 'Check-out result' })
  faceCheckOut(@Body() dto: FaceCheckInDto, @CurrentUser() user: any) {
    return this.faceRecognitionService.faceCheckOut(dto.image, user.employeeId);
  }

  @Post('capture-check-out')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Face capture check-out',
    description: 'Check out with face photo capture (no recognition)',
  })
  @ApiResponse({ status: 201, description: 'Check-out result' })
  captureCheckOut(@Body() dto: FaceCheckInDto, @CurrentUser() user: any) {
    return this.faceRecognitionService.captureCheckOut(dto.image, user.employeeId);
  }

  @Post('lunch-check-in')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Face lunch check-in',
    description: 'Check in from lunch using face recognition',
  })
  @ApiResponse({ status: 201, description: 'Face lunch check-in result' })
  faceLunchCheckIn(@Body() dto: FaceCheckInDto, @CurrentUser() user: any) {
    return this.faceRecognitionService.faceLunchCheckIn(dto.image, user.employeeId);
  }

  @Post('capture-lunch-check-in')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Face capture lunch check-in',
    description: 'Check in from lunch with face photo capture (no recognition)',
  })
  @ApiResponse({ status: 201, description: 'Lunch check-in result' })
  captureLunchCheckIn(@Body() dto: FaceCheckInDto, @CurrentUser() user: any) {
    return this.faceRecognitionService.captureLunchCheckIn(dto.image, user.employeeId);
  }

  @Post('lunch-check-out')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Face lunch check-out',
    description: 'Check out for lunch using face recognition',
  })
  @ApiResponse({ status: 201, description: 'Face lunch check-out result' })
  faceLunchCheckOut(@Body() dto: FaceCheckInDto, @CurrentUser() user: any) {
    return this.faceRecognitionService.faceLunchCheckOut(dto.image, user.employeeId);
  }

  @Post('capture-lunch-check-out')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Face capture lunch check-out',
    description: 'Check out for lunch with face photo capture (no recognition)',
  })
  @ApiResponse({ status: 201, description: 'Lunch check-out result' })
  captureLunchCheckOut(@Body() dto: FaceCheckInDto, @CurrentUser() user: any) {
    return this.faceRecognitionService.captureLunchCheckOut(dto.image, user.employeeId);
  }

  @Get('status')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get registration status',
    description: 'Get face registration status for current user',
  })
  getStatus(@CurrentUser() user: any) {
    return this.faceRecognitionService.getRegistrationStatus(user.employeeId);
  }

  @Get('descriptors/me')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get my descriptors',
    description: 'Get face descriptors for current user',
  })
  getMyDescriptors(@CurrentUser() user: any) {
    return this.faceRecognitionService.getEmployeeDescriptors(user.employeeId);
  }

  @Get('descriptors/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get employee descriptors',
    description: 'Get face descriptors for a specific employee (admin only)',
  })
  getEmployeeDescriptors(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    return this.faceRecognitionService.getEmployeeDescriptors(employeeId);
  }

  @Delete('descriptors/:id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Delete descriptor',
    description: 'Delete a face descriptor',
  })
  deleteDescriptor(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    if (['ADMIN', 'HR_MANAGER'].includes(user.role)) {
      return this.faceRecognitionService.deleteDescriptorAdmin(id);
    }
    return this.faceRecognitionService.deleteDescriptor(id, user.employeeId);
  }

  @Post('test')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Test recognition',
    description: 'Test face recognition without checking in (admin debug)',
  })
  testRecognition(@Body() dto: FaceCheckInDto) {
    return this.faceRecognitionService.testRecognition(dto.image);
  }
}
