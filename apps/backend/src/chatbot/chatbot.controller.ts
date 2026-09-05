import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ChatbotService } from './chatbot.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChatDto } from './dto/chat.dto';

@ApiTags('Chatbot')
@Controller('chatbot')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ChatbotController {
  constructor(private readonly chatbotService: ChatbotService) {}

  @Post('chat')
  @ApiOperation({
    summary: 'Chat with AI assistant',
    description:
      'Send a message and receive a response from the company internal AI chatbot',
  })
  @ApiResponse({ status: 200, description: 'Successful response' })
  async chat(@Body() dto: ChatDto, @Request() req) {
    const context = {
      employeeId: req.user.employeeId,
      role: req.user.role,
    };

    const response = await this.chatbotService.chat(
      dto.message,
      context,
      dto.history || [],
    );

    // Save chat history
    if (response && context.employeeId) {
      await this.chatbotService.saveChatHistory(
        context.employeeId,
        dto.message,
        response.data.message,
      );
    }

    return response;
  }

  @Get('history')
  @ApiOperation({
    summary: 'Get chat history',
    description: 'Get employee chat history',
  })
  @ApiResponse({
    status: 200,
    description: 'Chat history retrieved successfully',
  })
  async getHistory(@Request() req, @Query('limit') limit?: number) {
    const history = await this.chatbotService.getChatHistory(
      req.user.employeeId,
      limit ? parseInt(limit.toString()) : 10,
    );

    return {
      success: true,
      data: history,
      meta: { total: history.length },
    };
  }

  @Get('suggestions')
  @ApiOperation({
    summary: 'Get question suggestions',
    description: 'Get a list of suggested questions for the user',
  })
  @ApiResponse({
    status: 200,
    description: 'Suggestions retrieved successfully',
  })
  getSuggestions() {
    return {
      success: true,
      data: [
        {
          category: 'Annual Leave',
          questions: [
            'How many leave days do I have left?',
            'What is my annual leave balance?',
            'How much sick leave is left?',
          ],
        },
        {
          category: 'Attendance',
          questions: [
            'How is my attendance this month?',
            'How many times was I late this month?',
            'Total working hours this month?',
          ],
        },
        {
          category: 'Salary',
          questions: [
            'How much is my salary this month?',
            'My salary for December?',
            'Detailed salary information?',
          ],
        },
        {
          category: 'Overtime',
          questions: [
            'How many hours of overtime have I worked?',
            'How many more overtime hours can I work?',
            'What are the overtime regulations?',
          ],
        },
        {
          category: 'Policies',
          questions: [
            'Working hours regulations?',
            'Leave policy?',
            'Overtime policy?',
            'Salary policy?',
          ],
        },
        {
          category: 'Requests',
          questions: [
            'What is the status of my leave request?',
            'My overtime request status?',
            'Which requests are pending approval?',
          ],
        },
      ],
    };
  }
}
