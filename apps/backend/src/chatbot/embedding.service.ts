import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

@Injectable()
export class EmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingService.name);
  private extractor:
    | ((
        text: string,
        options?: { pooling?: string; normalize?: boolean },
      ) => Promise<{ data: Float32Array }>)
    | null = null;
  private isInitialized = false;

  async onModuleInit() {
    // Initialize the model when module starts
    try {
      await this.initializeModel();
    } catch (error) {
      this.logger.warn(
        `Failed to initialize embedding model during startup: ${error instanceof Error ? error.message : String(error)}. Will try again lazily when needed.`,
      );
    }
  }

  private async initializeModel() {
    if (this.isInitialized) return;

    try {
      this.logger.log(
        'Initializing embedding model (Xenova/all-MiniLM-L6-v2)...',
      );

      // Load the feature extraction pipeline
      // Model will be downloaded and cached on first run (~23MB)
      const { pipeline } = await import('@xenova/transformers');
      this.extractor = (await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
        {
          // Cache model in node_modules/.cache
          cache_dir: './node_modules/.cache/transformers',
        },
      )) as (
        text: string,
        options?: { pooling?: string; normalize?: boolean },
      ) => Promise<{ data: Float32Array }>;

      this.isInitialized = true;
      this.logger.log('✅ Embedding model initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize embedding model:', error);
      throw error;
    }
  }

  // Preprocess text before embedding
  private preprocessText(text: string): string {
    return text
      .toLowerCase() // Convert to lowercase
      .normalize('NFC') // Normalize Unicode
      .replace(/[?!.,;:()[\]{}""'']/g, '') // Remove punctuation
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Ensure model is initialized
      if (!this.extractor) {
        await this.initializeModel();
      }

      // Preprocess text
      const cleanText = this.preprocessText(text);

      // Generate embedding
      const output = await this.extractor!(cleanText, {
        pooling: 'mean',
        normalize: true,
      });

      // Convert tensor to array
      const embedding = Array.from(output.data);

      return embedding;
    } catch (error) {
      this.logger.error('Embedding generation error:', error);
      throw new Error('Could not generate embedding. Please try again later.');
    }
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      // Ensure model is initialized
      if (!this.extractor) {
        await this.initializeModel();
      }

      // Generate embeddings for all texts
      const embeddings: number[][] = [];

      for (const text of texts) {
        const output = await this.extractor!(text, {
          pooling: 'mean',
          normalize: true,
        });
        embeddings.push(Array.from(output.data));
      }

      return embeddings;
    } catch (error) {
      this.logger.error('Batch embedding generation error:', error);
      throw new Error('Could not generate embeddings. Please try again later.');
    }
  }

  // Calculate cosine similarity between two vectors
  cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must have the same length');
    }

    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }

    return dotProduct / (magnitudeA * magnitudeB);
  }

  // Get embedding dimension
  getEmbeddingDimension(): number {
    return 384; // all-MiniLM-L6-v2 produces 384-dimensional embeddings
  }
}
