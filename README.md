# ac-lambda-deployment

Simple AWS Lambda deployment tool using AWS SDK v3. Deploys code, manages layers, and configures SQS triggers without the complexity of full infrastructure-as-code tools.

## Features

- **Code-focused deployment** - Updates Lambda function code quickly
- **Layer management** - Attach and update Lambda layers
- **SQS trigger configuration** - Manage event source mappings
- **Multi-environment support** - Different configs for dev/prod
- **Automatic retry logic** - Handles concurrent update conflicts
- **Include-based packaging** - Only package specified files
- **AWS profile support** - Use different AWS profiles per environment

## Installation

```bash
npm install ac-lambda-deployment --save-dev
# or
yarn add ac-lambda-deployment --dev
```

## Quick Start

**1. Create a configuration file:**

```javascript
// lambda.config.js
module.exports = {
    functionName: 'my-lambda-function',
    roleArn: 'arn:aws:iam::123456789012:role/lambda-execution-role',
    handler: 'lambda.handler',
    includes: ['lambda.js'],
    layers: [
        'arn:aws:lambda:eu-central-1:123456789012:layer:my-utils:1'
    ]
}
```

**2. Add to package.json scripts:**

```json
{
    "scripts": {
        "deploy": "lambda-deploy",
        "deploy:prod": "NODE_ENV=production lambda-deploy --profile=prod"
    }
}
```

**3. Deploy:**

```bash
npm run deploy
```

## Configuration

### Basic Configuration

Create `lambda.config.js` in your project root:

```javascript
module.exports = {
    functionName: 'my-function',
    roleArn: 'arn:aws:iam::123456789012:role/lambda-role',
    handler: 'lambda.handler',
    runtime: 'nodejs18.x',
    timeout: 30,
    memorySize: 128,
    includes: ['lambda.js', 'config.json'],
    environment: {
        NODE_ENV: 'production',
        API_KEY: 'your-api-key'
    }
}
```

### Multi-Environment Configuration

```javascript
// lambda.config.js
const env = process.env.NODE_ENV || 'dev'

const environments = {
    dev: {
        functionName: 'my-function-dev',
        roleArn: 'arn:aws:iam::123456789012:role/lambda-dev-role',
        profile: 'default',
        layers: [
            'arn:aws:lambda:eu-central-1:123456789012:layer:dev-utils:1'
        ]
    },
    production: {
        functionName: 'my-function-prod',
        roleArn: 'arn:aws:iam::123456789012:role/lambda-prod-role', 
        profile: 'production',
        layers: [
            'arn:aws:lambda:eu-central-1:123456789012:layer:prod-utils:2'
        ]
    }
}

module.exports = {
    handler: 'lambda.handler',
    runtime: 'nodejs18.x',
    includes: ['lambda.js'],
    ...environments[env]
}
```

### SQS Triggers

```javascript
module.exports = {
    functionName: 'my-sqs-processor',
    roleArn: 'arn:aws:iam::123456789012:role/lambda-sqs-role',
    sqsTriggers: [
        {
            queueArn: 'arn:aws:sqs:eu-central-1:123456789012:my-queue',
            batchSize: 10,
            maxBatchingWindow: 5,
            enabled: true
        }
    ]
}
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `functionName` | string | **required** | Lambda function name |
| `roleArn` | string | **required** | IAM role ARN for the function |
| `handler` | string | `lambda.handler` | Function entry point |
| `runtime` | string | `nodejs18.x` | Lambda runtime |
| `timeout` | number | `30` | Function timeout in seconds |
| `memorySize` | number | `128` | Memory allocation in MB |
| `includes` | array | `['lambda.js']` | Files to include in deployment package |
| `layers` | array | `[]` | Lambda layer ARNs |
| `environment` | object | `{}` | Environment variables |
| `profile` | string | default | AWS profile to use |
| `region` | string | `eu-central-1` | AWS region |
| `sqsTriggers` | array | `[]` | SQS event source mappings |

## Usage

### Command Line

```bash
# Deploy with default configuration
npx lambda-deploy

# Deploy with specific AWS profile
npx lambda-deploy --profile=production

# Deploy with different region
npx lambda-deploy --region=us-east-1

# Deploy with custom config file
npx lambda-deploy --config=prod.config.js

# Multi-environment
NODE_ENV=production npx lambda-deploy --profile=prod
```

### Programmatic Usage

```javascript
const LambdaDeployer = require('ac-lambda-deployment')

async function deploy() {
    const deployer = new LambdaDeployer({
        region: 'eu-central-1',
        profile: 'production'
    })
    
    await deployer.deploy()
}

deploy().catch(console.error)
```

## Package Structure

The tool uses an **include-based** approach - only specified files are packaged:

```
project/
├── lambda.js              # Your Lambda function (included)
├── lambda.config.js       # Configuration (not included)
├── package.json           # Dependencies info (not included) 
├── node_modules/          # Always included in package
└── other-files.js         # Only if specified in includes
```

**Default includes:** `['lambda.js']`
**Always included:** `node_modules/` (production dependencies)

## AWS Permissions

Your Lambda execution role needs these permissions for SQS triggers:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage", 
                "sqs:GetQueueAttributes"
            ],
            "Resource": "arn:aws:sqs:*:*:*"
        }
    ]
}
```

## Alternative Configuration

You can also configure in `package.json`:

```json
{
    "name": "my-project",
    "lambda": {
        "functionName": "my-function",
        "roleArn": "arn:aws:iam::123456789012:role/lambda-role",
        "includes": ["lambda.js", "utils.js"]
    }
}
```

## Security

**Important:** Never commit `lambda.config.js` to version control if it contains sensitive data.

```bash
# .gitignore
lambda.config.js
lambda.*.config.js
```

Create a template instead:

```javascript
// lambda.config.example.js
module.exports = {
    functionName: 'your-function-name',
    roleArn: 'arn:aws:iam::YOUR-ACCOUNT:role/YOUR-ROLE',
    environment: {
        API_KEY: 'your-api-key'
    }
}
```

## Comparison with Other Tools

| Tool | Code Deploy | Infrastructure | Complexity |
|------|-------------|----------------|------------|
| **ac-lambda-deployment** | ✅ Fast | Layers, SQS only | Low |
| Serverless Framework | ✅ | ✅ Full | High |
| AWS SAM | ✅ | ✅ Full | Medium |
| Terraform | ❌ | ✅ Full | High |
| ClaudiaJS | ✅ Fast | Basic | Low (deprecated) |

**Use ac-lambda-deployment when:**
- You want fast code deployments
- Infrastructure is managed separately (Terraform/CDK)
- You need simple layer and SQS trigger management
- You want ClaudiaJS-like simplicity with modern AWS SDK

## Examples

### Simple API Function

```javascript
// lambda.config.js
module.exports = {
    functionName: 'api-handler',
    roleArn: 'arn:aws:iam::123456789012:role/api-lambda-role',
    handler: 'lambda.handler',
    timeout: 10,
    memorySize: 256,
    environment: {
        DATABASE_URL: process.env.DATABASE_URL
    }
}
```

### SQS Message Processor

```javascript
// lambda.config.js  
module.exports = {
    functionName: 'queue-processor',
    roleArn: 'arn:aws:iam::123456789012:role/sqs-lambda-role',
    sqsTriggers: [
        {
            queueArn: 'arn:aws:sqs:eu-central-1:123456789012:process-queue',
            batchSize: 5,
            maxBatchingWindow: 10
        }
    ],
    layers: [
        'arn:aws:lambda:eu-central-1:123456789012:layer:shared-utils:1'
    ]
}
```

## Troubleshooting

### Permission Denied
```bash
chmod +x ./node_modules/ac-lambda-deployment/index.js
```

### Concurrent Update Error
The tool automatically retries when Lambda is being updated. Wait 30-60 seconds between deployments.

### Function Not Found
Make sure the function exists or provide `roleArn` to create it automatically.

## License

MIT © 2025 AdmiralCloud AG, Mark Poepping

## Support

- Check AWS credentials: `aws sts get-caller-identity`
- Verify function exists: `aws lambda get-function --function-name your-function`
- Enable debug logging: `AWS_SDK_LOAD_CONFIG=1 DEBUG=* npx lambda-deploy`