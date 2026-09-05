import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { Prisma } from '@prisma/client';

export interface CreateKnowledgeDto {
  title: string;
  content: string;
  category: string;
  tags?: string[];
  metadata?: any;
}

export interface UpdateKnowledgeDto {
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
  metadata?: any;
  isActive?: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  similarity: number;
  metadata?: any;
}

@Injectable()
export class KnowledgeService {
  constructor(
    private prisma: PrismaService,
    private embeddingService: EmbeddingService,
  ) {}

  // Query expansion dictionary for Indian
  private readonly queryExpansions: Record<string, string> = {
    leave: 'annual leave day off rest holiday',
    salary: 'salary income wage pay payroll',
    overtime: 'overtime extra hours work late',
    attendance: 'attendance check in check out work day',
    hours: 'working hours time schedule',
    password: 'password pass change reset',
    contract: 'contract agreement signing',
    insurance: 'insurance social health',
    tax: 'tax income PIT',
  };

  // Expand query with synonyms and related terms
  private expandQuery(query: string): string {
    let expanded = query;
    const lowerQuery = query.toLowerCase();

    for (const [key, value] of Object.entries(this.queryExpansions)) {
      if (lowerQuery.includes(key)) {
        expanded += ' ' + value;
      }
    }

    return expanded;
  }

  async create(dto: CreateKnowledgeDto, createdBy: string) {
    // Generate embedding for the content
    const embedding = await this.embeddingService.generateEmbedding(
      `${dto.title}\n\n${dto.content}`,
    );

    // Convert embedding array to PostgreSQL vector format
    const embeddingStr = `[${embedding.join(',')}]`;

    const knowledge = await this.prisma.$executeRaw`
      INSERT INTO company_knowledge (
        id, title, content, category, tags, embedding, metadata, created_by, created_at, updated_at
      ) VALUES (
        gen_random_uuid(),
        ${dto.title},
        ${dto.content},
        ${dto.category},
        ${dto.tags || []}::text[],
        ${embeddingStr}::vector,
        ${dto.metadata ? JSON.stringify(dto.metadata) : null}::jsonb,
        ${createdBy}::uuid,
        NOW(),
        NOW()
      )
    `;

    return { success: true, message: 'Knowledge created successfully' };
  }

  async findAll(category?: string, isActive?: boolean) {
    const where: any = {};
    if (category) where.category = category;
    if (isActive !== undefined) where.isActive = isActive;

    return this.prisma.companyKnowledge.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        creator: {
          select: {
            email: true,
            employee: {
              select: {
                fullName: true,
              },
            },
          },
        },
      },
    });
  }

  async findOne(id: string) {
    const knowledge = await this.prisma.companyKnowledge.findUnique({
      where: { id },
      include: {
        creator: {
          select: {
            email: true,
            employee: {
              select: {
                fullName: true,
              },
            },
          },
        },
      },
    });

    if (!knowledge) {
      throw new NotFoundException('Knowledge not found');
    }

    return knowledge;
  }

  async update(id: string, dto: UpdateKnowledgeDto) {
    const existing = await this.findOne(id);

    // If content or title changed, regenerate embedding
    let embeddingStr: string | undefined;
    if (dto.title || dto.content) {
      const textToEmbed = `${dto.title || existing.title}\n\n${dto.content || existing.content}`;
      const embedding =
        await this.embeddingService.generateEmbedding(textToEmbed);
      embeddingStr = `[${embedding.join(',')}]`;
    }

    if (embeddingStr) {
      await this.prisma.$executeRaw`
        UPDATE company_knowledge
        SET 
          title = ${dto.title || existing.title},
          content = ${dto.content || existing.content},
          category = ${dto.category || existing.category},
          tags = ${dto.tags || existing.tags}::text[],
          embedding = ${embeddingStr}::vector,
          metadata = ${dto.metadata ? JSON.stringify(dto.metadata) : existing.metadata}::jsonb,
          is_active = ${dto.isActive !== undefined ? dto.isActive : existing.isActive},
          updated_at = NOW()
        WHERE id = ${id}::uuid
      `;
    } else {
      await this.prisma.companyKnowledge.update({
        where: { id },
        data: {
          ...(dto.title && { title: dto.title }),
          ...(dto.content && { content: dto.content }),
          ...(dto.category && { category: dto.category }),
          ...(dto.tags && { tags: dto.tags }),
          ...(dto.metadata && { metadata: dto.metadata }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
      });
    }

    return { success: true, message: 'Knowledge updated successfully' };
  }

  async remove(id: string) {
    await this.findOne(id); // Check if exists

    await this.prisma.companyKnowledge.delete({
      where: { id },
    });

    return { success: true, message: 'Knowledge deleted successfully' };
  }

  async search(query: string, limit: number = 5): Promise<SearchResult[]> {
    // Expand query with synonyms
    const expandedQuery = this.expandQuery(query);

    // Generate embedding for the expanded query
    const queryEmbedding =
      await this.embeddingService.generateEmbedding(expandedQuery);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Use pgvector's cosine similarity search with title boosting
    const results: any[] = await this.prisma.$queryRaw`
      SELECT 
        id,
        title,
        content,
        category,
        tags,
        metadata,
        CASE 
          -- Boost similarity if query matches title (case-insensitive)
          WHEN LOWER(title) LIKE LOWER('%' || ${query} || '%') THEN
            (1 - (embedding <=> ${embeddingStr}::vector)) * 1.3
          ELSE
            1 - (embedding <=> ${embeddingStr}::vector)
        END as similarity
      FROM company_knowledge
      WHERE is_active = true
      ORDER BY similarity DESC
      LIMIT ${limit}
    `;

    return results.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      category: r.category,
      tags: r.tags || [],
      similarity: parseFloat(r.similarity),
      metadata: r.metadata,
    }));
  }

  async getCategories() {
    const result = await this.prisma.companyKnowledge.groupBy({
      by: ['category'],
      where: { isActive: true },
      _count: true,
    });

    return result.map((r) => ({
      category: r.category,
      count: r._count,
    }));
  }
}
