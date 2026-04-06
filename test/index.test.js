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

        it('throws immediately for non-conflict errors', async () => {
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

            await assert.rejects(
                () => deployer.updateWithRetry({}, 'code'),
                /access denied/
            )
            assert.equal(attempts, 1)
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

        it('ignores transient polling errors and keeps waiting', async () => {
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
    })
})
