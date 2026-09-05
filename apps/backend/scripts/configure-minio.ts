import * as dotenv from 'dotenv';
import * as path from 'path';
import * as Minio from 'minio';

// Load environment variables from backend/.env
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const accessKey = process.env.MINIO_ACCESS_KEY || 'admin';
const secretKey = process.env.MINIO_SECRET_KEY || 'StrongPassword@123';
const bucketName = process.env.MINIO_BUCKET || 'attendance-photos';

async function tryConnectAndSetPolicy(endPoint: string, port: number, useSSL: boolean) {
  console.log(`\nAttempting to connect to MinIO S3 API at ${useSSL ? 'https' : 'http'}://${endPoint}:${port}...`);
  try {
    const minioClient = new Minio.Client({
      endPoint,
      port,
      useSSL,
      accessKey,
      secretKey,
    });

    // Test bucketExists to verify connection
    console.log(`Checking if bucket "${bucketName}" exists...`);
    const exists = await Promise.race([
      minioClient.bucketExists(bucketName),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout (5s)')), 5000)
      ),
    ]);

    if (!exists) {
      console.log(`Bucket "${bucketName}" does not exist. Creating it...`);
      await minioClient.makeBucket(bucketName, 'us-east-1');
      console.log(`Bucket "${bucketName}" created.`);
    } else {
      console.log(`Bucket "${bucketName}" exists.`);
    }

    // Set public read-only policy
    console.log(`Setting public read-only policy for bucket "${bucketName}"...`);
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucketName}/*`],
        },
      ],
    };

    await minioClient.setBucketPolicy(bucketName, JSON.stringify(policy));
    console.log(`Successfully set public read policy for bucket "${bucketName}"!`);

    // Verify by fetching policy
    const currentPolicyStr = await minioClient.getBucketPolicy(bucketName);
    console.log(`Current policy in MinIO:\n`, JSON.stringify(JSON.parse(currentPolicyStr), null, 2));
    return true;
  } catch (error: any) {
    console.error(`Failed connecting to ${endPoint}:${port} - Error: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('--- MinIO Bucket Policy Configuration Script ---');
  console.log(`Bucket: ${bucketName}`);
  console.log(`Access Key: ${accessKey}`);
  console.log(`Secret Key: ${'*'.repeat(secretKey.length)}`);

  // We will try several potential endpoints
  const targets = [
    // 1. Target from .env if defined
    ...(process.env.MINIO_ENDPOINT ? [
      {
        endPoint: process.env.MINIO_ENDPOINT,
        port: parseInt(process.env.MINIO_PORT || '443', 10),
        useSSL: process.env.MINIO_USE_SSL === 'true'
      }
    ] : []),
    // 2. Localhost defaults (if port-forwarding or local)
    { endPoint: 'localhost', port: 9009, useSSL: false },
    { endPoint: '127.0.0.1', port: 9009, useSSL: false },
    // 3. VPS console domain but mapped S3 port
    { endPoint: 'console.hrm.skillhiveinnovations.com', port: 9009, useSSL: false },
    { endPoint: 'console.hrm.skillhiveinnovations.com', port: 9000, useSSL: false },
    { endPoint: 'console.hrm.skillhiveinnovations.com', port: 443, useSSL: true },
    { endPoint: 'console.hrm.skillhiveinnovations.com', port: 80, useSSL: false },
    // 4. Subdomains
    { endPoint: 's3.hrm.skillhiveinnovations.com', port: 443, useSSL: true },
    { endPoint: 's3.hrm.skillhiveinnovations.com', port: 80, useSSL: false },
    { endPoint: 's3.hrm.skillhiveinnovations.com', port: 9009, useSSL: false },
  ];

  // De-duplicate targets by endpoint + port
  const uniqueTargets = targets.filter(
    (t, index, self) =>
      self.findIndex((o) => o.endPoint === t.endPoint && o.port === t.port) === index
  );

  let success = false;
  for (const target of uniqueTargets) {
    const ok = await tryConnectAndSetPolicy(target.endPoint, target.port, target.useSSL);
    if (ok) {
      success = true;
      console.log(`\n🎉 Connection succeeded using: ${target.endPoint}:${target.port} (SSL: ${target.useSSL})`);
    }
  }

  if (!success) {
    console.error('\n❌ Could not connect to any of the S3 API endpoints.');
    console.log('Please verify the public S3 URL/port of your MinIO instance.');
  }
}

main().catch(console.error);
