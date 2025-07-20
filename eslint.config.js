// eslint.config.js (ESLint 9+ flat config)
module.exports = [
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                console: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                module: 'readonly',
                require: 'readonly',
                exports: 'readonly',
                global: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly'
            }
        },
        rules: {
            // Error Prevention
            'no-unused-vars': ['error', { 
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_' 
            }],
            'no-undef': 'error',
            'no-unreachable': 'error',
            'no-console': 'off', // CLI tool needs console
            
            // Code Style (matching your preferences)
            'semi': ['error', 'never'],
            'quotes': ['error', 'single'],
            'indent': ['error', 4],
            'comma-dangle': ['error', 'never'],
            'object-curly-spacing': ['error', 'always'],
            'array-bracket-spacing': ['error', 'never'],
            'space-before-blocks': 'error',
            'keyword-spacing': 'error',
            
            // Best Practices
            'eqeqeq': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
            'no-throw-literal': 'error',
            'no-return-await': 'error',
            
            // Async/Await
            'require-await': 'error',
            'no-async-promise-executor': 'error',
            
            // Node.js specific
            'no-process-exit': 'off', // CLI tool needs process.exit
            'handle-callback-err': 'error'
        }
    },
    {
        files: ['lambda.config.js', '*.config.js'],
        rules: {
            // Config files can have unused exports
            'no-unused-vars': 'off'
        }
    }
]