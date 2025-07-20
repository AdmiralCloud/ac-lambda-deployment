#!/usr/bin/env node

const { LambdaClient, UpdateFunctionCodeCommand, CreateFunctionCommand, GetFunctionCommand, UpdateFunctionConfigurationCommand, CreateEventSourceMappingCommand, ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand, DeleteEventSourceMappingCommand } = require('@aws-sdk/client-lambda')
const { fromIni } = require('@aws-sdk/credential-provider-ini')
const fs = require('fs')
const path = require('path')
const archiver = require('archiver')
const { execSync } = require('child_process')

class LambdaDeployer {
    constructor(options = {}) {
        const { region = 'eu-central-1', profile } = options
        
        const clientConfig = { region }
        if (profile) {
            clientConfig.credentials = fromIni({ profile })
        }
        
        this.lambda = new LambdaClient(clientConfig)
    }

    // Load configuration from lambda.config.js or package.json
    loadConfig(configPath) {
        const cwd = process.cwd()
        
        // Try lambda.config.js first
        const configFile = path.join(cwd, configPath || 'lambda.config.js')
        if (fs.existsSync(configFile)) {
            delete require.cache[require.resolve(configFile)]
            return require(configFile)
        }
        
        // Try package.json lambda section
        const packageFile = path.join(cwd, 'package.json')
        if (fs.existsSync(packageFile)) {
            const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
            if (pkg.lambda) {
                return pkg.lambda
            }
        }
        
        throw new Error('No configuration found. Create lambda.config.js or add "lambda" section to package.json')
    }

    // Create ZIP archive with code and dependencies
    createZip(sourceDir, outputPath, includes = ['lambda.js']) {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(outputPath)
            const archive = archiver('zip', { zlib: { level: 9 } })

            output.on('close', () => resolve(outputPath))
            archive.on('error', reject)

            archive.pipe(output)
            
            // Add specified files only
            includes.forEach(pattern => {
                const fullPath = path.join(sourceDir, pattern)
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                    archive.file(fullPath, { name: pattern })
                }
                else {
                    // Handle glob patterns
                    archive.glob(pattern, { cwd: sourceDir })
                }
            })

            // Install and add production dependencies
            console.log('Installing production dependencies...')
            try {
                // Detect package manager
                const hasYarnLock = fs.existsSync(path.join(sourceDir, 'yarn.lock'))
                const hasPnpmLock = fs.existsSync(path.join(sourceDir, 'pnpm-lock.yaml'))
                
                let installCmd
                if (hasYarnLock) {
                    installCmd = 'yarn install --production --silent'
                }
                else if (hasPnpmLock) {
                    installCmd = 'pnpm install --production'
                }
                else {
                    installCmd = 'npm install --production --silent'
                }
                
                execSync(installCmd, { cwd: sourceDir })
                archive.directory(path.join(sourceDir, 'node_modules'), 'node_modules')
            }
            catch {
                console.warn('Warning: dependency installation failed, continuing without dependencies')
            }

            archive.finalize()
        })
    }

    // Check if function exists
    async functionExists(functionName) {
        try {
            await this.lambda.send(new GetFunctionCommand({ FunctionName: functionName }))
            return true
        }
        catch (err) {
            if (err.name === 'ResourceNotFoundException') {
                return false
            }
            throw err
        }
    }

    // Create new Lambda function
    createFunction(config) {
        const zipBuffer = fs.readFileSync(config.zipPath)
        
        const params = {
            FunctionName: config.functionName,
            Runtime: config.runtime || 'nodejs22.x',
            Role: config.roleArn,
            Handler: config.handler || 'lambda.handler',
            Code: { ZipFile: zipBuffer },
            Description: config.description || 'Deployed with lambda-deployer',
            Timeout: config.timeout || 30,
            MemorySize: config.memorySize || 128,
            Environment: config.environment ? { Variables: config.environment } : undefined,
            Layers: config.layers || []
        }

        const command = new CreateFunctionCommand(params)
        return this.lambda.send(command)
    }

    // Generic retry logic for any command
    async updateWithRetry(command, updateType) {
        for (let i = 0; i < 3; i++) {
            try {
                return await this.lambda.send(command)
            }
            catch (err) {
                if (err.name === 'ResourceConflictException' && i < 2) {
                    const waitTime = (i + 1) * 30000
                    console.log(`Function ${updateType} is being updated, waiting ${waitTime/1000} seconds... (attempt ${i + 1}/3)`)
                    await new Promise(resolve => setTimeout(resolve, waitTime))
                    continue
                }
                throw err
            }
        }
    }

    // Wait until function is in Active state and ready for next update
    async waitForFunctionReady(functionName, maxWaitMs = 120000) {
        const startTime = Date.now()
        
        while (Date.now() - startTime < maxWaitMs) {
            try {
                const result = await this.lambda.send(new GetFunctionCommand({ FunctionName: functionName }))
                const state = result.Configuration?.State
                const lastUpdateStatus = result.Configuration?.LastUpdateStatus
                
                if (state === 'Active' && lastUpdateStatus === 'Successful') {
                    return
                }
                
                if (lastUpdateStatus === 'Failed') {
                    throw new Error('Previous update failed')
                }
            }
            catch (err) {
                if (err.message === 'Previous update failed') {
                    throw err
                }
                // Ignore other errors during polling
            }
            
            await new Promise(resolve => setTimeout(resolve, 3000))
        }
        
        throw new Error('Timeout waiting for function to be ready')
    }

    // Update function code, then config sequentially
    async updateFunctionSequential(functionName, zipPath, config) {
        const zipBuffer = fs.readFileSync(zipPath)
        
        // Step 1: Update code
        console.log('Updating function code...')
        const codeParams = {
            FunctionName: functionName,
            ZipFile: zipBuffer
        }
        
        await this.updateWithRetry(new UpdateFunctionCodeCommand(codeParams), 'code')
        
        // Step 2: Wait for function to be ready, then update configuration
        if (config.layers || config.environment || config.timeout || config.memorySize || config.description) {
            console.log('Waiting for code update to complete...')
            await this.waitForFunctionReady(functionName)
            
            const configParams = {
                FunctionName: functionName,
                Runtime: config.runtime || 'nodejs18.x',
                Handler: config.handler || 'lambda.handler',
                Description: config.description,
                Timeout: config.timeout || 30,
                MemorySize: config.memorySize || 128,
                Environment: config.environment ? { Variables: config.environment } : undefined,
                Layers: config.layers || []
            }
            
            console.log('Updating function configuration...')
            await this.updateWithRetry(new UpdateFunctionConfigurationCommand(configParams), 'configuration')
        }
    }

    // Manage SQS event source mappings
    async updateEventSourceMappings(functionName, sqsTriggers = []) {
        if (sqsTriggers.length === 0) return

        // Get existing mappings
        const listCommand = new ListEventSourceMappingsCommand({
            FunctionName: functionName
        })
        const existing = await this.lambda.send(listCommand)
        
        // Process each SQS trigger
        for (const trigger of sqsTriggers) {
            const existingMapping = existing.EventSourceMappings?.find(
                m => m.EventSourceArn === trigger.queueArn
            )

            if (existingMapping) {
                // Update existing mapping
                console.log(`Updating SQS trigger: ${trigger.queueArn}`)
                const updateCommand = new UpdateEventSourceMappingCommand({
                    UUID: existingMapping.UUID,
                    BatchSize: trigger.batchSize || 10,
                    MaximumBatchingWindowInSeconds: trigger.maxBatchingWindow || 0,
                    Enabled: trigger.enabled !== false
                })
                await this.lambda.send(updateCommand)
            }
            else {
                // Create new mapping
                console.log(`Creating SQS trigger: ${trigger.queueArn}`)
                const createCommand = new CreateEventSourceMappingCommand({
                    EventSourceArn: trigger.queueArn,
                    FunctionName: functionName,
                    BatchSize: trigger.batchSize || 10,
                    MaximumBatchingWindowInSeconds: trigger.maxBatchingWindow || 0,
                    Enabled: trigger.enabled !== false
                })
                await this.lambda.send(createCommand)
            }
        }

        // Remove mappings not in config
        const configuredArns = sqsTriggers.map(t => t.queueArn)
        for (const mapping of existing.EventSourceMappings || []) {
            if (!configuredArns.includes(mapping.EventSourceArn)) {
                console.log(`Removing SQS trigger: ${mapping.EventSourceArn}`)
                const deleteCommand = new DeleteEventSourceMappingCommand({
                    UUID: mapping.UUID
                })
                await this.lambda.send(deleteCommand)
            }
        }
    }

    // Main deployment function
    async deploy(configPath) {
        const config = this.loadConfig(configPath)
        
        const {
            functionName,
            sourceDir = '.',
            roleArn,
            includes = ['lambda.js'],
            region,
            profile
        } = config

        // Override AWS config if specified in config file
        if (region || profile) {
            const clientConfig = { region: region || 'eu-central-1' }
            if (profile) {
                clientConfig.credentials = fromIni({ profile })
            }
            this.lambda = new LambdaClient(clientConfig)
        }

        if (!functionName) {
            throw new Error('functionName is required in configuration')
        }

        console.log(`Deploying Lambda function: ${functionName}`)
        
        // Create ZIP
        const zipPath = path.join(sourceDir, `${functionName}.zip`)
        console.log('Creating deployment package...')
        await this.createZip(sourceDir, zipPath, includes)
        
        try {
            const exists = await this.functionExists(functionName)
            
            if (exists) {
                console.log('Updating existing function...')
                
                // Update function code and config sequentially
                await this.updateFunctionSequential(functionName, zipPath, config)
                
                // Update SQS triggers (separate API)
                if (config.sqsTriggers) {
                    console.log('Updating SQS triggers...')
                    await this.updateEventSourceMappings(functionName, config.sqsTriggers)
                }
                
                console.log('Function updated successfully!')
            }
            else {
                if (!roleArn) {
                    throw new Error('roleArn is required for creating new functions')
                }
                console.log('Creating new function...')
                await this.createFunction({ ...config, zipPath })
                
                // Add SQS triggers after function creation
                if (config.sqsTriggers) {
                    console.log('Creating SQS triggers...')
                    await this.updateEventSourceMappings(functionName, config.sqsTriggers)
                }
                
                console.log('Function created successfully!')
            }
        }
        finally {
            // Cleanup ZIP file
            if (fs.existsSync(zipPath)) {
                fs.unlinkSync(zipPath)
            }
        }
    }
}

// CLI interface
async function cli() {
    const args = process.argv.slice(2)
    const profile = args.find(arg => arg.startsWith('--profile='))?.split('=')[1]
    const region = args.find(arg => arg.startsWith('--region='))?.split('=')[1]
    const config = args.find(arg => arg.startsWith('--config='))?.split('=')[1]
    
    const deployer = new LambdaDeployer({ region, profile })
    
    try {
        await deployer.deploy(config)
    }
    catch (err) {
        console.error('Deployment failed:', err.message)
        process.exit(1)
    }
}

// Run CLI if called directly
if (require.main === module) {
    cli()
}

module.exports = LambdaDeployer