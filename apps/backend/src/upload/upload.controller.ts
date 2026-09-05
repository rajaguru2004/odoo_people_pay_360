import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { UploadService } from './upload.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('Upload')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('upload')
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('file')
  @Roles('ADMIN', 'HR_MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary:
      'Upload a file that is not attached to a record yet, and get its URL',
    description:
      'Backs the file/photo controls on forms that render before their record exists — the employee CREATE form in particular. `folder` is an allowlist: profile (images) or documents.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async uploadPublicFile(
    @Query('folder') folder: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const url = await this.uploadService.uploadPublicFile(folder, file);

    return {
      message: 'File uploaded successfully',
      url,
      fileName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
    };
  }

  @Post('avatar/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload employee avatar' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async uploadAvatar(
    @Param('employeeId') employeeId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    // Check if employee exists
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new BadRequestException('Employee not found');
    }

    const avatarUrl = await this.uploadService.uploadAvatar(employeeId, file);

    // Update employee avatar in database
    await this.prisma.employee.update({
      where: { id: employeeId },
      data: { avatarUrl: avatarUrl },
    });

    return {
      message: 'Avatar uploaded successfully',
      url: avatarUrl,
    };
  }

  @Post('contract/:contractId')
  @Roles('ADMIN', 'HR_MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload contract file' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async uploadContract(
    @Param('contractId') contractId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    // Check if contract exists
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
    });

    if (!contract) {
      throw new BadRequestException('Contract not found');
    }

    const documentUrl = await this.uploadService.uploadContract(
      contractId,
      file,
    );

    // Update contract document URL in database
    await this.prisma.contract.update({
      where: { id: contractId },
      data: { fileUrl: documentUrl },
    });

    return {
      message: 'Contract document uploaded successfully',
      url: documentUrl,
    };
  }

  @Post('document/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'EMPLOYEE')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload document (degree, certificate, etc.)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async uploadDocument(
    @Param('employeeId') employeeId: string,
    @Query('category') category: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    if (!category) {
      throw new BadRequestException('Category is required');
    }

    // Check if employee exists
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new BadRequestException('Employee not found');
    }

    const documentUrl = await this.uploadService.uploadDocument(
      employeeId,
      category,
      file,
    );

    return {
      message: 'Document uploaded successfully',
      url: documentUrl,
      category,
      fileName: file.originalname,
    };
  }

  @Get('documents/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get employee document list' })
  async listDocuments(
    @Param('employeeId') employeeId: string,
    @Query('category') category?: string,
  ) {
    const files = await this.uploadService.listEmployeeFiles(
      employeeId,
      category,
    );

    return {
      employeeId,
      category: category || 'all',
      files,
    };
  }

  @Delete('file')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Delete file' })
  async deleteFile(@Query('path') filePath: string) {
    if (!filePath) {
      throw new BadRequestException('File path is required');
    }

    await this.uploadService.deleteFile(filePath);

    return {
      message: 'File deleted successfully',
    };
  }

  @Post('logo')
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload company logo' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async uploadLogo(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const { url, faviconUrl } = await this.uploadService.uploadLogo(file);

    return {
      message: 'Logo uploaded successfully',
      url,
      faviconUrl,
    };
  }
}
