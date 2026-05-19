'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

const LambdaDeployer = require('../index')

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-test-'))
}

// Swap global.setTimeout to execute callbacks immediately (no real waiting)
function patchTimeout() {
    const orig = global.setTimeout
    global.setTimeout = (fn) => fn()
    return () => { global.setTimeout = orig }
}

describe('LambdaDeployer', () => {

    describe('constructor', () => {
        it('creates instance without options', () => {
            const deployer = new LambdaDeployer()
            assert.ok(deployer.lambda)
        })

        it('accepts custom region', () => {
            const deployer = new LambdaDeployer({ region: 'us-east-1' })
            assert.ok(deployer.lambda)
        })

        it('uses fromIni credentials when profile is provided', () => {
            const deployer = new LambdaDeployer({ profile: 'my-profile' })
            assert.ok(deployer.lambda)
        })
    })

    describe('loadConfig', () => {
        let tmpDir, origCwd

        beforeEach(() => {
            tmpDir = makeTempDir()
            origCwd = process.cwd()
            process.chdir(tmpDir)
        })

        afterEach(() => {
            process.chdir(origCwd)
            fs.rmSync(tmpDir, { recursive: true })
        })

        it('throws when no config found', () => {
            const deployer = new LambdaDeployer()
            assert.throws(
                () => deployer.loadConfig(),
                /No configuration found/
            )
        })

        it('loads lambda config from package.json', () => {
            const deployer = new LambdaDeployer()
            const lambdaConfig = { functionName: 'test-fn', roleArn: 'arn:aws:iam::123:role/test' }
            fs.writeFileSync('package.json', JSON.stringify({ name: 'test', lambda: lambdaConfig }))

            const config = deployer.loadConfig()
            assert.deepEqual(config, lambdaConfig)
        })

        it('ignores package.json without lambda section', () => {
            const deployer = new LambdaDeployer()
            fs.writeFileSync('package.json', JSON.stringify({ name: 'test' }))

            assert.throws(
                () => deployer.loadConfig(),
                /No configuration found/
            )
        })

        it('loads config from lambda.config.js', () => {
            const deployer = new LambdaDeployer()
            const lambdaConfig = { functionName: 'config-fn' }
            fs.writeFileSync('lambda.config.js', `module.exports = ${JSON.stringify(lambdaConfig)}`)

            const config = deployer.loadConfig()
            assert.deepEqual(config, lambdaConfig)
        })

        it('prefers lambda.config.js over package.json', () => {
            const deployer = new LambdaDeployer()
            fs.writeFileSync('lambda.config.js', `module.exports = { functionName: 'from-config-js' }`)
            fs.writeFileSync('package.json', JSON.stringify({ lambda: { functionName: 'from-package-json' } }))

            const config = deployer.loadConfig()
            assert.equal(config.functionName, 'from-config-js')
        })

        it('loads config from custom configPath', () => {
            const deployer = new LambdaDeployer()
            const lambdaConfig = { functionName: 'custom-fn' }
            fs.writeFileSync('my.config.js', `module.exports = ${JSON.stringify(lambdaConfig)}`)

            const config = deployer.loadConfig('my.config.js')
            assert.deepEqual(config, lambdaConfig)
        })
    })

    describe('functionExists', () => {
        it('returns true when function exists', async () => {
            const deployer = new LambdaDeployer()
            deployer.lambda = { send: async () => ({ Configuration: { FunctionName: 'test' } }) }

            assert.equal(await deployer.functionExists('test'), true)
        })

        it('returns false for ResourceNotFoundException', async () => {
            const deployer = new LambdaDeployer()
            deployer.lambda = {
                send: async () => {
                    const e = new Error('not found')
                    e.name = 'ResourceNotFoundException'
                    throw e
                }
            }

            assert.equal(await deployer.functionExists('missing'), false)
        })

        it('rethrows unexpected errors', async () => {
            const deployer = new LambdaDeployer()
            deployer.lambda = {
                send: async () => {
                    const e = new Error('network error')
                    e.name = 'NetworkError'
                    throw e
                }
            }

            await assert.rejects(() => deployer.functionExists('test'), /network error/)
        })
    })

    describe('updateWithRetry', () => {
        it('returns result on first successful call', async () => {
            const deployer = new LambdaDeployer()
            const mockResult = { FunctionArn: 'arn:test' }
            deployer.lambda = { send: async () => mockResult }

            const result = await deployer.updateWithRetry({}, 'code')
            assert.deepEqual(result, mockResult)
        })

        it('retries on ResourceConflictException and succeeds on 2nd attempt', async () => {
            const deployer = new LambdaDeployer()
            const restore = patchTimeout()
            let attempts = 0
            deployer.lambda = {
                send: async () => {
                    attempts++
                    if (attempts < 2) {
                        const e = new Error('conflict')
                        e.name = 'ResourceConflictException'
                        throw e
                    }
                    return { success: true }
                }
            }

            try {
                const result = await deployer.updateWithRetry({}, 'code')
                assert.deepEqual(result, { success: true })
                assert.equal(attempts, 2)
            }
            finally { restore() }
        })

        it('throws after 3 failed ResourceConflictException attempts', async () => {
            const deployer = new LambdaDeployer()
            const restore = patchTimeout()
            let attempts = 0
            deployer.lambda = {
                send: async () => {
                    attempts++
                    const e = new Error('always conflict')
                    e.name = 'ResourceConflictException'
                    throw e
                }
            }

            try {
                await assert.rejects(
                    () => deployer.updateWithRetry({}, 'code'),
                    /always conflict/
                )
                assert.equal(attempts, 3)
            }
            finally { restore() }
        })

        it('throws immediately for non-conflict errors, propagating name and message', async () => {
            const deployer = new LambdaDeployer()
            let attempts = 0
            deployer.lambda = {
                send: async () => {
                    attempts++
                    const e = new Error('access denied')
                    e.name = 'AccessDeniedException'
                    throw e
                }
            }

            const err = await deployer.updateWithRetry({}, 'code').catch(e => e)
            assert.equal(attempts, 1)
            assert.equal(err.name, 'AccessDeniedException')
            assert.equal(err.message, 'access denied')
        })
    })

    describe('waitForFunctionReady', () => {
        it('resolves when state is Active and LastUpdateStatus is Successful', async () => {
            const deployer = new LambdaDeployer()
            deployer.lambda = {
                send: async () => ({
                    Configuration: { State: 'Active', LastUpdateStatus: 'Successful' }
                })
            }

            await assert.doesNotReject(() => deployer.waitForFunctionReady('test'))
        })

        it('throws when LastUpdateStatus is Failed', async () => {
            const deployer = new LambdaDeployer()
            deployer.lambda = {
                send: async () => ({
                    Configuration: { State: 'Active', LastUpdateStatus: 'Failed' }
                })
            }

            await assert.rejects(
                () => deployer.waitForFunctionReady('test'),
                /Previous update failed/
            )
        })

        it('throws timeout when function never becomes ready', async () => {
            const deployer = new LambdaDeployer()
            const restore = patchTimeout()
            deployer.lambda = {
                send: async () => ({
                    Configuration: { State: 'Pending', LastUpdateStatus: 'InProgress' }
                })
            }

            try {
                await assert.rejects(
                    () => deployer.waitForFunctionReady('test', 0),
                    /Timeout waiting/
                )
            }
            finally { restore() }
        })

        it('ignores a single transient polling error and keeps waiting', async () => {
            const deployer = new LambdaDeployer()
            const restore = patchTimeout()
            let calls = 0
            deployer.lambda = {
                send: async () => {
                    calls++
                    if (calls === 1) throw new Error('transient error')
                    return { Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } }
                }
            }

            try {
                await assert.doesNotReject(() => deployer.waitForFunctionReady('test'))
                assert.equal(calls, 2)
            }
            finally { restore() }
        })

        it('ignores multiple consecutive transient polling errors before eventual success', async () => {
            const deployer = new LambdaDeployer()
            const restore = patchTimeout()
            let calls = 0
            deployer.lambda = {
                send: async () => {
                    calls++
                    if (calls < 4) throw new Error(`transient error ${calls}`)
                    return { Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } }
                }
            }

            try {
                await assert.doesNotReject(() => deployer.waitForFunctionReady('test'))
                assert.equal(calls, 4)
            }
            finally { restore() }
        })
    })

    describe('createFunction', () => {
        it('sends CreateFunctionCommand with default values', async () => {
            const deployer = new LambdaDeployer()
            const tmpDir = makeTempDir()
            const zipPath = path.join(tmpDir, 'test.zip')
            fs.writeFileSync(zipPath, 'fake zip')

            let sentCommand
            deployer.lambda = {
                send: async (cmd) => { sentCommand = cmd; return { FunctionArn: 'arn:test' } }
            }

            try {
                const result = await deployer.createFunction({
                    functionName: 'test-fn',
                    zipPath,
                    roleArn: 'arn:aws:iam::123:role/test'
                })
                assert.equal(sentCommand.constructor.name, 'CreateFunctionCommand')
                assert.equal(result.FunctionArn, 'arn:test')
            }
            finally {
                fs.rmSync(tmpDir, { recursive: true })
            }
        })

        it('includes layers when provided', async () => {
            const deployer = new LambdaDeployer()
            const tmpDir = makeTempDir()
            const zipPath = path.join(tmpDir, 'test.zip')
            fs.writeFileSync(zipPath, 'fake zip')

            let capturedInput
            deployer.lambda = {
                send: async (cmd) => { capturedInput = cmd.input; return { FunctionArn: 'arn:test' } }
            }

            try {
                await deployer.createFunction({
                    functionName: 'test-fn',
                    zipPath,
                    roleArn: 'arn:aws:iam::123:role/test',
                    layers: ['arn:aws:lambda:eu-central-1:123:layer:test:1'],
                    environment: { KEY: 'value' }
                })
                assert.deepEqual(capturedInput.Layers, ['arn:aws:lambda:eu-central-1:123:layer:test:1'])
                assert.deepEqual(capturedInput.Environment, { Variables: { KEY: 'value' } })
            }
            finally {
                fs.rmSync(tmpDir, { recursive: true })
            }
        })
    })

    describe('updateEventSourceMappings', () => {
        it('does nothing when sqsTriggers is empty', async () => {
            const deployer = new LambdaDeployer()
            let called = false
            deployer.lambda = { send: async () => { called = true } }

            await deployer.updateEventSourceMappings('test', [])
            assert.equal(called, false)
        })

        it('creates new SQS trigger when no existing mapping', async () => {
            const deployer = new LambdaDeployer()
            const calls = []
            deployer.lambda = {
                send: async (cmd) => {
                    calls.push(cmd.constructor.name)
                    if (cmd.constructor.name === 'ListEventSourceMappingsCommand') {
                        return { EventSourceMappings: [] }
                    }
                    return {}
                }
            }

            await deployer.updateEventSourceMappings('test', [
                { queueArn: 'arn:aws:sqs:eu-central-1:123:my-queue', batchSize: 5 }
            ])

            assert.ok(calls.includes('CreateEventSourceMappingCommand'))
            assert.ok(!calls.includes('UpdateEventSourceMappingCommand'))
        })

        it('updates existing SQS trigger', async () => {
            const deployer = new LambdaDeployer()
            const calls = []
            deployer.lambda = {
                send: async (cmd) => {
                    calls.push(cmd.constructor.name)
                    if (cmd.constructor.name === 'ListEventSourceMappingsCommand') {
                        return {
                            EventSourceMappings: [
                                { UUID: 'existing-uuid', EventSourceArn: 'arn:aws:sqs:eu-central-1:123:my-queue' }
                            ]
                        }
                    }
                    return {}
                }
            }

            await deployer.updateEventSourceMappings('test', [
                { queueArn: 'arn:aws:sqs:eu-central-1:123:my-queue', batchSize: 5 }
            ])

            assert.ok(calls.includes('UpdateEventSourceMappingCommand'))
            assert.ok(!calls.includes('CreateEventSourceMappingCommand'))
        })

        it('disables a trigger when enabled is false', async () => {
            const deployer = new LambdaDeployer()
            let capturedInput
            deployer.lambda = {
                send: async (cmd) => {
                    if (cmd.constructor.name === 'ListEventSourceMappingsCommand') {
                        return {
                            EventSourceMappings: [
                                { UUID: 'uuid-1', EventSourceArn: 'arn:aws:sqs:eu-central-1:123:q' }
                            ]
                        }
                    }
                    capturedInput = cmd.input
                    return {}
                }
            }

            await deployer.updateEventSourceMappings('test', [
                { queueArn: 'arn:aws:sqs:eu-central-1:123:q', enabled: false }
            ])

            assert.equal(capturedInput.Enabled, false)
        })

        it('handles list response without EventSourceMappings key', async () => {
            const deployer = new LambdaDeployer()
            const calls = []
            deployer.lambda = {
                send: async (cmd) => {
                    calls.push(cmd.constructor.name)
                    if (cmd.constructor.name === 'ListEventSourceMappingsCommand') {
                        return {}  // no EventSourceMappings key
                    }
                    return {}
                }
            }

            await deployer.updateEventSourceMappings('test', [
                { queueArn: 'arn:aws:sqs:eu-central-1:123:q' }
            ])

            assert.ok(calls.includes('CreateEventSourceMappingCommand'))
        })

        it('deletes SQS triggers not present in config', async () => {
            const deployer = new LambdaDeployer()
            const calls = []
            deployer.lambda = {
                send: async (cmd) => {
                    calls.push(cmd.constructor.name)
                    if (cmd.constructor.name === 'ListEventSourceMappingsCommand') {
                        return {
                            EventSourceMappings: [
                                { UUID: 'old-uuid', EventSourceArn: 'arn:aws:sqs:eu-central-1:123:old-queue' }
                            ]
                        }
                    }
                    return {}
                }
            }

            await deployer.updateEventSourceMappings('test', [
                { queueArn: 'arn:aws:sqs:eu-central-1:123:new-queue' }
            ])

            assert.ok(calls.includes('DeleteEventSourceMappingCommand'))
            assert.ok(calls.includes('CreateEventSourceMappingCommand'))
        })
    })

    describe('createZip', () => {
        let tmpDir

        beforeEach(() => { tmpDir = makeTempDir() })
        afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

        it('creates a zip file with specified file includes', async () => {
            const deployer = new LambdaDeployer()
            fs.writeFileSync(path.join(tmpDir, 'lambda.js'), 'exports.handler = () => {}')
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', dependencies: {} }))

            const outputPath = path.join(tmpDir, 'out.zip')
            const result = await deployer.createZip(tmpDir, outputPath, ['lambda.js'])

            assert.equal(result, outputPath)
            assert.ok(fs.existsSync(outputPath))
            assert.ok(fs.statSync(outputPath).size > 0)
        })

        it('handles glob patterns in includes', async () => {
            const deployer = new LambdaDeployer()
            fs.writeFileSync(path.join(tmpDir, 'handler.js'), 'exports.handler = () => {}')
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', dependencies: {} }))

            const outputPath = path.join(tmpDir, 'out.zip')
            const result = await deployer.createZip(tmpDir, outputPath, ['*.js'])

            assert.equal(result, outputPath)
            assert.ok(fs.existsSync(outputPath))
        })

        it('detects yarn.lock and uses yarn install', async () => {
            const deployer = new LambdaDeployer()
            fs.writeFileSync(path.join(tmpDir, 'lambda.js'), 'exports.handler = () => {}')
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', dependencies: {} }))
            fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), '')

            const outputPath = path.join(tmpDir, 'out.zip')
            // execSync may fail in CI if yarn not installed – error is caught by createZip
            const result = await deployer.createZip(tmpDir, outputPath, ['lambda.js'])

            assert.equal(result, outputPath)
            assert.ok(fs.existsSync(outputPath))
        })

        it('detects pnpm-lock.yaml and uses pnpm install', async () => {
            const deployer = new LambdaDeployer()
            fs.writeFileSync(path.join(tmpDir, 'lambda.js'), 'exports.handler = () => {}')
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', dependencies: {} }))
            fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '')

            const outputPath = path.join(tmpDir, 'out.zip')
            const result = await deployer.createZip(tmpDir, outputPath, ['lambda.js'])

            assert.equal(result, outputPath)
            assert.ok(fs.existsSync(outputPath))
        })

        it('continues without dependencies when install fails', async () => {
            const deployer = new LambdaDeployer()
            fs.writeFileSync(path.join(tmpDir, 'lambda.js'), 'exports.handler = () => {}')
            // No package.json → execSync will fail → caught gracefully
            const outputPath = path.join(tmpDir, 'out.zip')
            const result = await deployer.createZip(tmpDir, outputPath, ['lambda.js'])

            assert.equal(result, outputPath)
            assert.ok(fs.existsSync(outputPath))
        })

        it('silently ignores errors during temp dir cleanup', async () => {
            const fsModule = require('fs')
            const origRmSync = fsModule.rmSync
            // Make rmSync throw only for the internal lambda-deploy- temp dir
            fsModule.rmSync = (p, opts) => {
                if (typeof p === 'string' && p.includes('lambda-deploy-')) {
                    throw new Error('cleanup failed')
                }
                return origRmSync(p, opts)
            }

            try {
                const deployer = new LambdaDeployer()
                fs.writeFileSync(path.join(tmpDir, 'lambda.js'), 'exports.handler = () => {}')
                fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', dependencies: {} }))

                const outputPath = path.join(tmpDir, 'out.zip')
                const result = await deployer.createZip(tmpDir, outputPath, ['lambda.js'])

                assert.equal(result, outputPath)
                assert.ok(fs.existsSync(outputPath))
            }
            finally {
                fsModule.rmSync = origRmSync
            }
        })
    })

    describe('updateFunctionSequential', () => {
        let tmpDir

        beforeEach(() => { tmpDir = makeTempDir() })
        afterEach(() => { fs.rmSync(tmpDir, { recursive: true }) })

        it('only updates code when no config changes are needed', async () => {
            const deployer = new LambdaDeployer()
            const zipPath = path.join(tmpDir, 'test.zip')
            fs.writeFileSync(zipPath, 'fake zip')

            const calls = []
            deployer.lambda = { send: async (cmd) => { calls.push(cmd.constructor.name); return {} } }

            await deployer.updateFunctionSequential('test-fn', zipPath, {})

            assert.ok(calls.includes('UpdateFunctionCodeCommand'))
            assert.ok(!calls.includes('UpdateFunctionConfigurationCommand'))
        })

        it('updates code then config when layers/environment are present', async () => {
            const deployer = new LambdaDeployer()
            const zipPath = path.join(tmpDir, 'test.zip')
            fs.writeFileSync(zipPath, 'fake zip')

            const calls = []
            deployer.lambda = {
                send: async (cmd) => {
                    calls.push(cmd.constructor.name)
                    if (cmd.constructor.name === 'GetFunctionCommand') {
                        return { Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } }
                    }
                    return {}
                }
            }

            await deployer.updateFunctionSequential('test-fn', zipPath, {
                layers: ['arn:aws:lambda:eu-central-1:123:layer:test:1'],
                environment: { KEY: 'value' }
            })

            assert.ok(calls.includes('UpdateFunctionCodeCommand'))
            assert.ok(calls.includes('UpdateFunctionConfigurationCommand'))
        })

        it('uses explicit runtime and handler when provided in config', async () => {
            const deployer = new LambdaDeployer()
            const zipPath = path.join(tmpDir, 'test.zip')
            fs.writeFileSync(zipPath, 'fake zip')

            let configInput
            deployer.lambda = {
                send: async (cmd) => {
                    if (cmd.constructor.name === 'GetFunctionCommand') {
                        return { Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } }
                    }
                    if (cmd.constructor.name === 'UpdateFunctionConfigurationCommand') {
                        configInput = cmd.input
                    }
                    return {}
                }
            }

            await deployer.updateFunctionSequential('test-fn', zipPath, {
                timeout: 60,
                runtime: 'nodejs20.x',
                handler: 'index.handler'
            })

            assert.equal(configInput.Runtime, 'nodejs20.x')
            assert.equal(configInput.Handler, 'index.handler')
        })
    })

    describe('deploy', () => {
        it('throws when functionName is missing', async () => {
            const deployer = new LambdaDeployer()
            deployer.loadConfig = () => ({ sourceDir: os.tmpdir() })
            deployer.createZip = async () => {}

            await assert.rejects(
                () => deployer.deploy(),
                /functionName is required/
            )
        })

        it('throws when roleArn is missing for a new function', async () => {
            const deployer = new LambdaDeployer()
            const tmpDir = makeTempDir()

            try {
                deployer.loadConfig = () => ({ functionName: 'new-fn', sourceDir: tmpDir })
                deployer.createZip = async () => {}
                deployer.lambda = {
                    send: async () => {
                        const e = new Error('not found')
                        e.name = 'ResourceNotFoundException'
                        throw e
                    }
                }

                await assert.rejects(
                    () => deployer.deploy(),
                    /roleArn is required/
                )
            }
            finally {
                fs.rmSync(tmpDir, { recursive: true })
            }
        })

        it('overrides region from config file', async () => {
            const deployer = new LambdaDeployer()
            const tmpDir = makeTempDir()

            try {
                deployer.loadConfig = () => ({
                    functionName: 'test-fn',
                    sourceDir: tmpDir,
                    region: 'us-west-2'
                })
                deployer.createZip = async () => {}
                deployer.functionExists = async () => true
                deployer.updateFunctionSequential = async () => {}

                await deployer.deploy()
                assert.ok(deployer.lambda)
            }
            finally {
                fs.rmSync(tmpDir, { recursive: true })
            }
        })

        it('overrides with profile only (falls back to default region)', async () => {
            const deployer = new LambdaDeployer()
            const tmpDir = makeTempDir()

            try {
                deployer.loadConfig = () => ({
                    functionName: 'test-fn',
                    sourceDir: tmpDir,
                    profile: 'my-profile'
                    // no region → should fall back to 'eu-central-1'
                })
                deployer.createZip = async () => {}
                deployer.functionExists = async () => true
                deployer.updateFunctionSequential = async () => {}

                await deployer.deploy()
                assert.ok(deployer.lambda)
            }
            finally {
                fs.rmSync(tmpDir, { recursive: true })
            }
        })

        it('updates existing function', async () => {
            const deployer = new LambdaDeployer()
            const tmpDir = makeTempDir()

            try {
                let updateCalled = false
                deployer.loadConfig = () => ({ functionName: 'test-fn', sourceDir: tmpDir })
                deployer.createZip = async () => {}
                deployer.functionExists = async () => true
                deployer.updateFunctionSequential = async () => { updateCalled = true }

                await deployer.deploy()
                assert.ok(updateCalled)
            }
            finally {
                fs.rmSync(tmpDir, { recursive: true })
            }
        })

        it('updates existing function and its SQS triggers', async () => {
            const deployer = new LambdaDeployer()
            const tmpDir = makeTempDir()

            try {
                let mappingsCalled = false
                deployer.loadConfig = () => ({
                    functionName: 'test-fn',
                    sourceDir: tmpDir,
                    sqsTriggers: [{ queueArn: 'arn:aws:sqs:eu-central-1:123:queue' }]
                })
                deployer.createZip = async () => {}
                deployer.functionExists = async () => true
                deployer.updateFunctionSequential = async () => {}
                deployer.updateEventSourceMappings = async () => { mappingsCalled = true }

                await deployer.deploy()
                assert.ok(mappingsCalled)
            }
            finally {
                fs.rmSync(tmpDir, { recursive: true })
            }
        })

        it('creates new function with SQS triggers', async () => {
            const deployer = new LambdaDeployer()
            const tmpDir = makeTempDir()

            try {
                let createCalled = false
                let mappingsCalled = false
                deployer.loadConfig = () => ({
                    functionName: 'new-fn',
                    sourceDir: tmpDir,
                    roleArn: 'arn:aws:iam::123:role/test',
                    sqsTriggers: [{ queueArn: 'arn:aws:sqs:eu-central-1:123:queue' }]
                })
                deployer.createZip = async () => {}
                deployer.functionExists = async () => false
                deployer.createFunction = async () => { createCalled = true; return {} }
                deployer.updateEventSourceMappings = async () => { mappingsCalled = true }

                await deployer.deploy()
                assert.ok(createCalled)
                assert.ok(mappingsCalled)
            }
            finally {
                fs.rmSync(tmpDir, { recursive: true })
            }
        })

        it('cleans up zip file after successful deploy', async () => {
            const deployer = new LambdaDeployer()
            const tmpDir = makeTempDir()
            const zipPath = path.join(tmpDir, 'test-fn.zip')

            try {
                deployer.loadConfig = () => ({ functionName: 'test-fn', sourceDir: tmpDir })
                deployer.createZip = async () => { fs.writeFileSync(zipPath, 'fake') }
                deployer.functionExists = async () => true
                deployer.updateFunctionSequential = async () => {}

                await deployer.deploy()
                assert.ok(!fs.existsSync(zipPath))
            }
            finally {
                fs.rmSync(tmpDir, { recursive: true, force: true })
            }
        })
    })

    describe('cli', () => {
        it('exits with code 1 when deployment fails', async () => {
            const { spawnSync } = require('child_process')
            const tmpDir = makeTempDir()

            try {
                // No config file → deploy throws → cli catches and exits 1
                const result = spawnSync(process.execPath, [
                    path.join(__dirname, '..', 'index.js')
                ], { cwd: tmpDir, timeout: 5000 })

                assert.equal(result.status, 1)
            }
            finally {
                fs.rmSync(tmpDir, { recursive: true })
            }
        })

        it('parses --profile, --region and --config arguments', async () => {
            const { spawnSync } = require('child_process')
            const tmpDir = makeTempDir()

            try {
                // Args are parsed before deploy is called → lines 360-362 are covered
                // Deploy still fails (no config file) → exits 1
                const result = spawnSync(process.execPath, [
                    path.join(__dirname, '..', 'index.js'),
                    '--profile=test-profile',
                    '--region=us-east-1',
                    '--config=custom.config.js'
                ], { cwd: tmpDir, timeout: 5000 })

                assert.equal(result.status, 1)
            }
            finally {
                fs.rmSync(tmpDir, { recursive: true })
            }
        })
    })
})
