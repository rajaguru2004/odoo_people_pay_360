import { PrismaClient } from '@prisma/client';
import { pipeline } from '@xenova/transformers';

const prisma = new PrismaClient();

async function main() {
    console.log('🔄 Generating embeddings for knowledge base...');

    // Initialize embedding model
    console.log('📦 Loading embedding model (Xenova/all-MiniLM-L6-v2)...');
    const extractor = await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
        {
            cache_dir: './node_modules/.cache/transformers',
        }
    );
    console.log('✅ Model loaded successfully');

    // Get all knowledge entries without embeddings
    const entries = await prisma.companyKnowledge.findMany({
        where: {
            isActive: true,
        },
    });

    console.log(`📝 Found ${entries.length} entries to process`);

    let processed = 0;
    let failed = 0;

    for (const entry of entries) {
        try {
            // Generate embedding
            const text = `${entry.title}\n\n${entry.content}`;
            const output = await extractor(text, {
                pooling: 'mean',
                normalize: true,
            });

            const embedding = Array.from(output.data) as number[];
            const embeddingStr = `[${embedding.join(',')}]`;

            // Update database
            await prisma.$executeRaw`
        UPDATE company_knowledge
        SET embedding = ${embeddingStr}::vector
        WHERE id = ${entry.id}
      `;

            processed++;
            console.log(`✅ [${processed}/${entries.length}] ${entry.title}`);
        } catch (error) {
            failed++;
            console.error(`❌ Failed: ${entry.title}`, error.message);
        }
    }

    console.log('\n📊 Summary:');
    console.log(`✅ Processed: ${processed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📝 Total: ${entries.length}`);
}

main()
    .catch((e) => {
        console.error('❌ Generation failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
